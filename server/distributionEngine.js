'use strict';

/**
 * Motor de reparto y protección de tickets para el Panel de Reparto.
 * Soporta:
 *  - Modo menor carga ('least_load')
 *  - Modo turnos ('round_robin')
 *  - Filtro opcional por tipo de asesor ('Digital' | 'Sala')
 *  - Respeto estricto de disponibilidad y tope_maximo
 *  - Regla de protección por actividad reciente entre asesor y cliente (últimos N minutos)
 *  - Liberación de asesor ("Quitarle todo a [asesor]")
 *  - Bloqueo de concurrencia para evitar doble asignación simultánea
 */

let activeOperationLock = false;
const recentlyAssignedTickets = new Map(); // ticketId -> timestamp ms

function acquireLock() {
  if (activeOperationLock) {
    return false;
  }
  activeOperationLock = true;
  return true;
}

function releaseLock() {
  activeOperationLock = false;
}

/**
 * Determina si un ticket está protegido contra movimientos automáticos o masivos.
 * Regla de negocio: No mover tickets con actividad entre asesor y cliente en los
 * últimos N minutos (por defecto 3), salvo que el supervisor lo fuerce explícitamente.
 *
 * @param {Object} ticket - Ticket enriquecido
 * @param {number} protectionMinutes - Minutos de protección (por defecto 3)
 * @param {number} [nowMs] - Timestamp actual en ms
 * @returns {{ protected: boolean, reason: string | null, minutesSinceActivity: number | null }}
 */
function checkTicketProtection(ticket, protectionMinutes = 3, nowMs = Date.now()) {
  const thresholdMin = Number(protectionMinutes ?? 3);
  if (thresholdMin <= 0) {
    return { protected: false, reason: null, minutesSinceActivity: null };
  }

  // Un ticket está en conversación activa si tiene asesor asignado (userId) o está 'open'
  const hasAdvisor = Boolean(ticket.userId || ticket.status === 'open');
  if (!hasAdvisor) {
    return { protected: false, reason: null, minutesSinceActivity: null };
  }

  // Evaluar marca de tiempo de última actividad (último mensaje de asesor o cliente, o updatedAt)
  const activityIso =
    ticket.lastActivityAt ||
    (ticket.lastMessageObj && ticket.lastMessageObj.createdAt) ||
    ticket.lastReceivedMessageAt ||
    ticket.updatedAt;

  if (!activityIso) {
    return { protected: false, reason: null, minutesSinceActivity: null };
  }

  const activityMs = new Date(activityIso).getTime();
  if (Number.isNaN(activityMs)) {
    return { protected: false, reason: null, minutesSinceActivity: null };
  }

  const elapsedMinutes = (nowMs - activityMs) / 60000;
  if (elapsedMinutes >= 0 && elapsedMinutes < thresholdMin) {
    return {
      protected: true,
      minutesSinceActivity: Math.max(0, Math.round(elapsedMinutes * 10) / 10),
      reason: `Actividad hace ${Math.max(0.1, Math.round(elapsedMinutes * 10) / 10)} min (protección de ${thresholdMin} min activa)`
    };
  }

  return {
    protected: false,
    minutesSinceActivity: Math.round(elapsedMinutes * 10) / 10,
    reason: null
  };
}

/**
 * Calcula el plan de distribución de un conjunto de tickets entre los asesores elegibles.
 *
 * @param {Object} params
 * @param {Array<Object>} params.tickets - Lista de tickets candidatos a repartir
 * @param {Array<Object>} params.advisors - Lista de asesores configurados
 * @param {string} [params.mode='least_load'] - 'least_load' | 'round_robin'
 * @param {string|null} [params.advisorType=null] - 'Digital' | 'Sala' | null
 * @param {number} [params.protectionMinutes=3] - Minutos de ventana de protección
 * @param {boolean} [params.force=false] - Si true, ignora la ventana de protección
 * @param {number} [params.roundRobinCursor=0] - Cursor inicial para turnos
 * @param {string|null} [params.excludeAdvisorUserId=null] - Excluir un asesor específico (ej. al liberar)
 * @param {number} [params.nowMs=Date.now()] - Hora de referencia
 */
function planDistribution({
  tickets = [],
  advisors = [],
  mode = 'least_load',
  advisorType = null,
  protectionMinutes = 3,
  force = false,
  roundRobinCursor = 0,
  excludeAdvisorUserId = null,
  requireOnline = false,
  nowMs = Date.now()
}) {
  // 1. Filtrar asesores incluidos, disponibles, del tipo solicitado y no excluidos
  const eligibleAdvisors = advisors
    .filter((a) => {
      const incluido = a.incluido === undefined ? true : Boolean(a.incluido);
      const disponible = Boolean(a.disponible);
      if (!incluido || !disponible) return false;
      // online === null significa "estado desconocido" (sin permiso users:view): no se excluye
      if (requireOnline && a.online === false) return false;
      if (excludeAdvisorUserId && String(a.whaticket_user_id) === String(excludeAdvisorUserId)) {
        return false;
      }
      if (advisorType && advisorType !== 'all' && a.tipo !== advisorType) {
        return false;
      }
      return true;
    })
    .map((a) => ({
      ...a,
      currentLoad: Number(a.currentLoad ?? a.carga_actual ?? 0),
      tope_maximo: Number(a.tope_maximo ?? 15),
      peso: Math.max(1, Math.min(20, Number(a.nivel ?? a.peso) || 1)),
      nivel: Math.max(1, Math.min(20, Number(a.nivel ?? a.peso) || 1)),
      assignedCountInPlan: 0
    }));

  // Construir rueda intercalada de turnos por Nivel (uno a la vez por ronda):
  // Ronda 1: todos con nivel >= 1 (ordenados de mayor a menor nivel)
  // Ronda 2: todos con nivel >= 2, etc.
  const orderedByLevel = [...eligibleAdvisors].sort((a, b) => {
    if (b.nivel !== a.nivel) return b.nivel - a.nivel;
    return String(a.id || a.whaticket_user_id).localeCompare(String(b.id || b.whaticket_user_id));
  });
  const maxLevel = orderedByLevel.reduce((m, a) => Math.max(m, a.nivel), 1);
  const weightedTurnWheel = [];
  for (let pass = 1; pass <= maxLevel; pass++) {
    for (const adv of orderedByLevel) {
      if (adv.nivel >= pass) {
        weightedTurnWheel.push(adv);
      }
    }
  }

  const assignments = [];
  const skippedProtected = [];
  const skippedNoCapacity = [];
  const seenTicketIds = new Set();

  let cursor = Number.isInteger(roundRobinCursor) && roundRobinCursor >= 0 ? roundRobinCursor : 0;

  for (const ticket of tickets) {
    if (!ticket || !ticket.id) continue;
    // Evitar asignar un mismo ticket dos veces en el mismo ciclo
    if (seenTicketIds.has(ticket.id)) continue;
    seenTicketIds.add(ticket.id);

    // Verificar regla de protección salvo que force === true
    if (!force) {
      const prot = checkTicketProtection(ticket, protectionMinutes, nowMs);
      if (prot.protected) {
        skippedProtected.push({
          ticketId: ticket.id,
          contactName: ticket.contact?.name || ticket.contactName || 'Sin nombre',
          reason: prot.reason,
          minutesSinceActivity: prot.minutesSinceActivity
        });
        continue;
      }
    }

    // Buscar asesores que aún no han alcanzado su tope_maximo
    // Y que no sean ya el asesor actual del ticket
    const availableWithCap = eligibleAdvisors.filter(
      (a) =>
        a.currentLoad < a.tope_maximo &&
        String(a.whaticket_user_id) !== String(ticket.userId || '')
    );

    if (availableWithCap.length === 0) {
      skippedNoCapacity.push({
        ticketId: ticket.id,
        contactName: ticket.contact?.name || ticket.contactName || 'Sin nombre',
        reason:
          eligibleAdvisors.length === 0
            ? 'No hay asesores disponibles con los filtros seleccionados'
            : 'Todos los asesores disponibles alcanzaron su tope máximo'
      });
      continue;
    }

    let chosen = null;

    if (mode === 'round_robin') {
      // Recorrer circularmente desde cursor buscando el siguiente asesor con cupo
      const totalEligible = eligibleAdvisors.length;
      for (let offset = 0; offset < totalEligible; offset++) {
        const idx = (cursor + offset) % totalEligible;
        const candidate = eligibleAdvisors[idx];
        if (
          candidate.currentLoad < candidate.tope_maximo &&
          String(candidate.whaticket_user_id) !== String(ticket.userId || '')
        ) {
          chosen = candidate;
          cursor = (idx + 1) % totalEligible;
          break;
        }
      }
    } else if (mode === 'weighted') {
      // Turnos por Nivel (uno a la vez): avanza en la rueda intercalada (weightedTurnWheel)
      // usando el cursor persistente para pasar siempre al siguiente asesor en línea según su nivel.
      const wheelLen = weightedTurnWheel.length;
      if (wheelLen > 0) {
        for (let offset = 0; offset < wheelLen; offset++) {
          const idx = (cursor + offset) % wheelLen;
          const candidate = weightedTurnWheel[idx];
          if (
            candidate.currentLoad < candidate.tope_maximo &&
            String(candidate.whaticket_user_id) !== String(ticket.userId || '')
          ) {
            chosen = candidate;
            cursor = (idx + 1) % wheelLen;
            break;
          }
        }
      }
    } else {
      // Por defecto: 'least_load' (menor carga actual; desempate por menor cantidad asignada en este lote y luego ID)
      const sorted = [...availableWithCap].sort((a, b) => {
        if (a.currentLoad !== b.currentLoad) return a.currentLoad - b.currentLoad;
        if (a.assignedCountInPlan !== b.assignedCountInPlan) {
          return a.assignedCountInPlan - b.assignedCountInPlan;
        }
        return String(a.id || a.whaticket_user_id).localeCompare(String(b.id || b.whaticket_user_id));
      });
      chosen = sorted[0];
    }

    if (!chosen) {
      skippedNoCapacity.push({
        ticketId: ticket.id,
        contactName: ticket.contact?.name || ticket.contactName || 'Sin nombre',
        reason: 'Sin capacidad disponible'
      });
      continue;
    }

    chosen.currentLoad += 1;
    chosen.assignedCountInPlan += 1;

    assignments.push({
      ticketId: ticket.id,
      ticketStatus: ticket.status || 'pending',
      contactName: ticket.contact?.name || ticket.contactName || 'Sin nombre',
      fromUserId: ticket.userId || null,
      fromAdvisorName: ticket.advisorName || null,
      toAdvisorId: chosen.id,
      toUserId: chosen.whaticket_user_id,
      toAdvisorName: chosen.nombre_visible,
      toAdvisorType: chosen.tipo,
      queueId: ticket.queueId || null
    });
  }

  // Resumen agrupado por asesor para el modal de confirmación ("Se moverán 12 tickets: Ana 4, Luis 4...")
  const summaryByAdvisor = eligibleAdvisors
    .filter((a) => a.assignedCountInPlan > 0)
    .map((a) => ({
      advisorId: a.id,
      whaticketUserId: a.whaticket_user_id,
      nombre: a.nombre_visible,
      tipo: a.tipo,
      cantidad: a.assignedCountInPlan,
      cargaFinal: a.currentLoad,
      topeMaximo: a.tope_maximo
    }));

  const summaryText =
    assignments.length > 0
      ? `Se moverán ${assignments.length} ticket${assignments.length === 1 ? '' : 's'}: ` +
        summaryByAdvisor.map((s) => `${s.nombre} (${s.cantidad})`).join(', ')
      : 'No hay tickets elegibles para mover con las condiciones actuales.';

  return {
    mode,
    totalCandidates: seenTicketIds.size,
    assignments,
    summaryByAdvisor,
    summaryText,
    skippedProtected,
    skippedNoCapacity,
    nextRoundRobinCursor: cursor
  };
}

/**
 * Planifica "Quitarle todo a [asesor]": toma todos los tickets abiertos/pendientes
 * de un asesor y los redistribuye entre los demás asesores disponibles.
 */
function planAdvisorRelease({
  advisorToRelease,
  allTickets = [],
  allAdvisors = [],
  mode = 'least_load',
  protectionMinutes = 3,
  force = false,
  roundRobinCursor = 0,
  nowMs = Date.now()
}) {
  if (!advisorToRelease || !advisorToRelease.whaticket_user_id) {
    throw new Error('Asesor a liberar inválido.');
  }

  const targetUserId = String(advisorToRelease.whaticket_user_id);
  const advisorTickets = allTickets.filter(
    (t) =>
      String(t.userId || '') === targetUserId &&
      (t.status === 'open' || t.status === 'pending')
  );

  return planDistribution({
    tickets: advisorTickets,
    advisors: allAdvisors,
    mode,
    advisorType: null,
    protectionMinutes,
    force,
    roundRobinCursor,
    excludeAdvisorUserId: targetUserId,
    nowMs
  });
}

module.exports = {
  acquireLock,
  releaseLock,
  recentlyAssignedTickets,
  checkTicketProtection,
  planDistribution,
  planAdvisorRelease
};
