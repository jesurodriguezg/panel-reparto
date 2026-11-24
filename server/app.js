'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { AppDatabase } = require('./db');
const { WhaticketClient } = require('./whaticketClient');
const {
  acquireLock,
  releaseLock,
  checkTicketProtection,
  planDistribution,
  planAdvisorRelease
} = require('./distributionEngine');
const { signSessionToken, verifySessionToken } = require('./crypto');
const {
  DEFAULT_MIN_CLIENT_MESSAGES,
  extractCleanContacts,
  buildContactsCsv,
  buildContactsXlsx
} = require('./contactsExporter');

function isLocalhostIp(ip = '') {
  const clean = String(ip).trim();
  return (
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean === '::ffff:127.0.0.1' ||
    clean === 'localhost'
  );
}

function parseCookies(cookieHeader = '') {
  const out = {};
  if (!cookieHeader) return out;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

/**
 * Construye el estado consolidado del tablero:
 * - Clasifica tickets en "En espera" y "Sin responder"
 * - Calcula semáforo (verde, amarillo, rojo) y protección
 * - Calcula carga actual y tickets sin responder por asesor
 */
function buildBoardState({
  rawTickets = [],
  appDb,
  connectionState,
  lastUpdatedAt,
  liveUsers = new Map(),
  liveUsersAvailable = false,
  todayCounts = {}
}) {
  const settings = appDb.getRawSettings();
  const advisors = appDb.listAdvisors();
  const departments = appDb.listDepartments();

  const greenMax = Number(settings.green_max_min || 5);
  const yellowMax = Number(settings.yellow_max_min || 15);
  const unansweredMin = Number(settings.unanswered_min || 5);
  const protectionMin = Number(settings.protection_min ?? 3);
  const nowMs = Date.now();

  const deptById = new Map(departments.map((d) => [String(d.id), d]));
  const advisorByUserId = new Map(advisors.map((a) => [String(a.whaticket_user_id), a]));

  // Inicializar métricas por asesor (incluye estado en línea real de GET /users y foto)
  const advisorStats = new Map();
  for (const a of advisors) {
    const live = liveUsers.get(String(a.whaticket_user_id)) || null;
    advisorStats.set(String(a.whaticket_user_id), {
      ...a,
      currentLoad: 0,
      unansweredCount: 0,
      waitingCount: 0,
      assignedToday: Number(todayCounts[String(a.whaticket_user_id)] || 0),
      online: live ? live.online : null,
      whaticketStatus: live ? live.status : null,
      away: live ? live.away : null,
      fotoPerfil: a.foto_url || (live ? live.profilePicUrl : null) || null
    });
  }

  const waitingTickets = [];
  const unansweredTickets = [];
  const allProcessedTickets = [];
  let criticalCount = 0;

  for (const t of rawTickets) {
    if (!t || (t.status !== 'open' && t.status !== 'pending')) continue;

    const dept = t.queueId ? deptById.get(String(t.queueId)) : null;
    const adv = t.userId ? advisorByUserId.get(String(t.userId)) : null;

    if (t.userId && advisorStats.has(String(t.userId))) {
      advisorStats.get(String(t.userId)).currentLoad += 1;
    }

    const lastMsg = t.lastMessageObj || {
      body: t.lastMessage || '',
      fromMe: false,
      senderType: 'cliente',
      createdAt: t.lastReceivedMessageAt || t.updatedAt || t.createdAt
    };

    const refIso =
      !lastMsg.fromMe && t.lastReceivedMessageAt
        ? t.lastReceivedMessageAt
        : lastMsg.createdAt || t.updatedAt || t.createdAt;
    const refMs = refIso ? new Date(refIso).getTime() : nowMs;
    const elapsedMin = Math.max(0, Math.floor((nowMs - (Number.isNaN(refMs) ? nowMs : refMs)) / 60000));

    let semaphore = 'verde';
    if (elapsedMin > yellowMax) {
      semaphore = 'rojo';
    } else if (elapsedMin >= greenMax) {
      semaphore = 'amarillo';
    }

    const protection = checkTicketProtection(t, protectionMin, nowMs);

    // Definiciones de negocio:
    // - En espera: ticket sin asesor asignado, o con estado pendiente según el openapi.
    const isWaiting = !t.userId || t.status === 'pending';

    // - Sin responder: el último mensaje es del cliente y lleva más de X minutos sin respuesta del asesor.
    const isLastFromClient = !lastMsg.fromMe;
    const isUnanswered = isLastFromClient && elapsedMin >= unansweredMin;

    if (isUnanswered && t.userId && advisorStats.has(String(t.userId))) {
      advisorStats.get(String(t.userId)).unansweredCount += 1;
    }
    if (isWaiting && t.userId && advisorStats.has(String(t.userId))) {
      advisorStats.get(String(t.userId)).waitingCount += 1;
    }

    if ((isWaiting || isUnanswered) && semaphore === 'rojo') {
      criticalCount += 1;
    }

    const enrichedTicket = {
      id: String(t.id),
      status: t.status,
      channel: String(t.channel || 'whatsapp'),
      unreadMessages: Number(t.unreadMessages || 0),
      contact: {
        name: String(t.contact?.name || 'Cliente sin nombre'),
        number: String(t.contact?.number || '')
      },
      queueId: t.queueId ? String(t.queueId) : null,
      departmentName: dept ? dept.name : null,
      departmentColor: dept ? dept.color : null,
      hasNoDepartment: !t.queueId,
      userId: t.userId ? String(t.userId) : null,
      advisorName: adv ? adv.nombre_visible : t.userId ? `ID ${String(t.userId).slice(0, 6)}` : null,
      advisorType: adv ? adv.tipo : null,
      lastMessagePreview: String(lastMsg.body || t.lastMessage || '').slice(0, 110),
      lastMessageSender: lastMsg.fromMe ? 'asesor' : 'cliente',
      lastMessageAt: refIso,
      elapsedMinutes: elapsedMin,
      semaphore,
      protected: protection.protected,
      protectionReason: protection.reason,
      createdAt: t.createdAt || null,
      updatedAt: t.updatedAt
    };

    allProcessedTickets.push(enrichedTicket);
    if (isWaiting) {
      waitingTickets.push(enrichedTicket);
    }
    if (isUnanswered) {
      unansweredTickets.push(enrichedTicket);
    }
  }

  // Ordenar del más antiguo/crítico al más reciente (mayor tiempo transcurrido primero)
  waitingTickets.sort((a, b) => b.elapsedMinutes - a.elapsedMinutes);
  unansweredTickets.sort((a, b) => b.elapsedMinutes - a.elapsedMinutes);

  const advisorsWithStats = Array.from(advisorStats.values()).filter((a) => a.incluido);
  const availableAdvisorsCount = advisorsWithStats.filter(
    (a) => a.disponible && a.currentLoad < a.tope_maximo
  ).length;
  const onlineAdvisorsCount = advisorsWithStats.filter((a) => a.online === true).length;

  return {
    kpis: {
      enEspera: waitingTickets.length,
      sinResponder: unansweredTickets.length,
      criticosRojo: criticalCount,
      asesoresDisponibles: availableAdvisorsCount,
      asesoresEnLinea: onlineAdvisorsCount,
      totalAsesores: advisorsWithStats.length
    },
    liveUsersAvailable,
    autoAssign: {
      enabled: Boolean(settings.auto_assign_enabled),
      mode: settings.default_mode || 'least_load'
    },
    waitingTickets,
    unansweredTickets,
    allTickets: allProcessedTickets,
    advisors: advisorsWithStats,
    allAdvisorsConfig: Array.from(advisorStats.values()),
    departments,
    dryRun: Boolean(settings.dry_run),
    supervisorUserId: settings.supervisor_user_id || null,
    defaultMode: settings.default_mode || 'least_load',
    thresholds: {
      greenMaxMin: greenMax,
      yellowMaxMin: yellowMax,
      unansweredMin,
      protectionMin
    },
    connection: connectionState,
    lastUpdatedAt: lastUpdatedAt || new Date().toISOString()
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Convierte un periodo (día 'YYYY-MM-DD', mes 'YYYY-MM' o año 'YYYY') en un rango [start, end)
 * en la hora local del equipo donde corre el servidor.
 */
function periodRange(granularity, value) {
  const now = new Date();
  const v = String(value || '').trim();
  let start;
  let end;
  if (granularity === 'day') {
    const m = v ? v.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
    const [y, mo, d] = m
      ? [Number(m[1]), Number(m[2]), Number(m[3])]
      : [now.getFullYear(), now.getMonth() + 1, now.getDate()];
    start = new Date(y, mo - 1, d);
    end = new Date(y, mo - 1, d + 1);
  } else if (granularity === 'month') {
    const m = v ? v.match(/^(\d{4})-(\d{2})$/) : null;
    const [y, mo] = m ? [Number(m[1]), Number(m[2])] : [now.getFullYear(), now.getMonth() + 1];
    start = new Date(y, mo - 1, 1);
    end = new Date(y, mo, 1);
  } else if (granularity === 'year') {
    const m = v ? v.match(/^(\d{4})$/) : null;
    const y = m ? Number(m[1]) : now.getFullYear();
    start = new Date(y, 0, 1);
    end = new Date(y + 1, 0, 1);
  } else {
    throw new Error('Periodo inválido. Usa día, mes o año.');
  }
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Fecha del periodo inválida.');
  }
  return { start, end };
}

function bucketKeyFor(date, granularity) {
  if (granularity === 'day') return pad2(date.getHours());
  if (granularity === 'month') return localDateKey(date);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function listBuckets(granularity, start, end) {
  const out = [];
  if (granularity === 'day') {
    for (let h = 0; h < 24; h++) out.push(pad2(h));
  } else if (granularity === 'month') {
    for (let d = new Date(start); d < end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      out.push(localDateKey(d));
    }
  } else {
    for (let mo = 0; mo < 12; mo++) out.push(`${start.getFullYear()}-${pad2(mo + 1)}`);
  }
  return out;
}

const ORIGIN_LABELS = {
  manual: 'Manual (panel)',
  reparto: 'Reparto equitativo',
  liberar: 'Liberación de asesor',
  auto: 'Asignación automática',
  whaticket: 'Detectado en Whaticket'
};

/**
 * Agrega eventos de asignación por usuario y por intervalo (hora, día o mes).
 */
function aggregateEvents({ events, granularity, start, end, advisors, liveUsers, userId = null }) {
  const buckets = listBuckets(granularity, start, end);
  const advisorByUid = new Map(advisors.map((a) => [String(a.whaticket_user_id), a]));
  const usersMap = new Map();

  const ensureUser = (uid) => {
    if (!usersMap.has(uid)) {
      const adv = advisorByUid.get(uid);
      const live = liveUsers.get(uid);
      usersMap.set(uid, {
        userId: uid,
        nombre: adv ? adv.nombre_visible : live ? live.name : `Usuario ${uid.slice(0, 6)}`,
        tipo: adv ? adv.tipo : null,
        peso: adv ? adv.peso : null,
        fotoPerfil: (adv && adv.foto_url) || (live && live.profilePicUrl) || null,
        online: live ? live.online : null,
        total: 0,
        counts: Object.fromEntries(buckets.map((b) => [b, 0])),
        byOrigin: {}
      });
    }
    return usersMap.get(uid);
  };

  // Incluir siempre a los asesores configurados (aunque tengan 0)
  if (!userId) {
    for (const a of advisors.filter((x) => x.incluido)) ensureUser(String(a.whaticket_user_id));
  } else {
    ensureUser(String(userId));
  }

  const totals = Object.fromEntries(buckets.map((b) => [b, 0]));
  for (const ev of events) {
    const uid = String(ev.user_id);
    if (userId && uid !== String(userId)) continue;
    const d = new Date(ev.fecha_hora);
    if (Number.isNaN(d.getTime())) continue;
    const key = bucketKeyFor(d, granularity);
    const u = ensureUser(uid);
    u.total += 1;
    if (key in u.counts) u.counts[key] += 1;
    if (key in totals) totals[key] += 1;
    u.byOrigin[ev.origen] = (u.byOrigin[ev.origen] || 0) + 1;
  }

  const users = Array.from(usersMap.values()).sort(
    (a, b) => b.total - a.total || a.nombre.localeCompare(b.nombre)
  );
  return {
    buckets,
    totals,
    grandTotal: users.reduce((s, u) => s + u.total, 0),
    users
  };
}

function createServerApp({ dbPath, secretPath, host = '127.0.0.1', fetchImpl } = {}) {
  const appDb = new AppDatabase(dbPath, secretPath);
  const wtClient = new WhaticketClient(appDb, { fetchImpl });
  const publicDir = path.join(__dirname, '..', 'public');

  // Clientes SSE conectados
  const sseClients = new Set();
  let lastBoardState = null;
  let pollingTimer = null;
  const autoAssignCooldown = new Map(); // ticketId -> timestamp hasta el que no se reintenta

  // Bloqueo de fuerza bruta del PIN: 5 intentos fallidos -> 5 minutos bloqueado
  const pinFailures = new Map();
  function isPinLocked(ip) {
    const rec = pinFailures.get(ip);
    return Boolean(rec && rec.lockedUntil && rec.lockedUntil > Date.now());
  }
  function registerPinFailure(ip) {
    const rec = pinFailures.get(ip) || { count: 0, lockedUntil: 0 };
    rec.count += 1;
    if (rec.count >= 5) {
      rec.lockedUntil = Date.now() + 5 * 60000;
      rec.count = 0;
    }
    pinFailures.set(ip, rec);
  }

  // Rate limiting simple en memoria por IP (máx 45 escrituras por minuto)
  const writeRateMap = new Map();
  function checkRateLimit(ip) {
    const now = Date.now();
    const record = writeRateMap.get(ip) || { count: 0, resetAt: now + 60000 };
    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + 60000;
    }
    record.count += 1;
    writeRateMap.set(ip, record);
    return record.count <= 45;
  }

  function broadcastSse(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function countTodayByUser() {
    const { start, end } = periodRange('day');
    const counts = {};
    for (const ev of appDb.listAssignmentEvents({
      fromIso: start.toISOString(),
      toIso: end.toISOString()
    })) {
      counts[String(ev.user_id)] = (counts[String(ev.user_id)] || 0) + 1;
    }
    return counts;
  }

  function composeBoard(rawTickets) {
    return buildBoardState({
      rawTickets,
      appDb,
      connectionState: wtClient.connectionState,
      lastUpdatedAt: new Date().toISOString(),
      liveUsers: wtClient.liveUsersCache?.map || new Map(),
      liveUsersAvailable: Boolean(wtClient.liveUsersCache?.available),
      todayCounts: countTodayByUser()
    });
  }

  async function refreshBoardState({ forceRefresh = false } = {}) {
    const status = appDb.getSetupStatus(host);
    if (!status.configured) {
      lastBoardState = composeBoard([]);
      return lastBoardState;
    }

    try {
      const tickets = await wtClient.listTickets({ forceRefresh });
      // Estado en línea real de los usuarios (caché 45 s)
      await wtClient.getLiveUsers();
      // Detectar asignaciones hechas directamente en Whaticket (sobre datos reales, sin simulación)
      try {
        appDb.recordDetectedAssignments(wtClient.boardCache.tickets || []);
      } catch (err) {
        console.error('[Estadísticas] No se pudieron registrar asignaciones detectadas:', err.message);
      }
      lastBoardState = composeBoard(tickets);
      broadcastSse('board', lastBoardState);
      return lastBoardState;
    } catch (err) {
      lastBoardState = composeBoard(wtClient.boardCache.tickets || []);
      lastBoardState.error = err.message;
      broadcastSse('board', lastBoardState);
      return lastBoardState;
    }
  }

  /**
   * Asignación automática por reglas (se ejecuta en cada ciclo de polling).
   * Usa el modo por defecto (menor carga, turnos o ponderado), respeta tope, disponibilidad,
   * protección por actividad reciente, tiempo mínimo de espera, tipo de asesor y estado en línea.
   */
  async function runAutoAssign() {
    const s = appDb.getRawSettings();
    if (!s.auto_assign_enabled || !lastBoardState || !appDb.getSetupStatus(host).configured) return;

    const now = Date.now();
    const minWait = Number(s.auto_assign_min_wait || 0);
    const candidates = (lastBoardState.waitingTickets || []).filter(
      (t) => t.elapsedMinutes >= minWait && !((autoAssignCooldown.get(t.id) || 0) > now)
    );
    if (candidates.length === 0) return;
    if (!acquireLock()) return;

    try {
      const mode = s.default_mode || 'least_load';
      const plan = planDistribution({
        tickets: candidates,
        advisors: lastBoardState.advisors || [],
        mode,
        advisorType: s.auto_assign_type && s.auto_assign_type !== 'all' ? s.auto_assign_type : null,
        protectionMinutes: s.protection_min,
        force: false,
        roundRobinCursor: s.round_robin_cursor || 0,
        requireOnline: Boolean(s.auto_only_online)
      });
      if (plan.assignments.length === 0) return;

      const ticketMap = new Map(candidates.map((t) => [String(t.id), t]));
      for (const item of plan.assignments) {
        const ticket = ticketMap.get(String(item.ticketId)) || {
          id: item.ticketId,
          status: item.ticketStatus
        };
        try {
          await wtClient.assignTicket(ticket, { userId: item.toUserId });
          appDb.addAssignmentLog({
            ticketId: item.ticketId,
            clienteNombre: ticket.contact?.name || item.contactName || '',
            clienteNumero: ticket.contact?.number || '',
            asesorOrigen: item.fromAdvisorName || 'En espera',
            asesorDestino: item.toAdvisorName,
            asesorDestinoUserId: item.toUserId,
            accion: 'auto',
            resultado: s.dry_run ? 'simulacion' : 'ok'
          });
        } catch (err) {
          // No reintentar este ticket durante 5 minutos para no saturar la API
          autoAssignCooldown.set(String(item.ticketId), now + 5 * 60000);
          appDb.addAssignmentLog({
            ticketId: item.ticketId,
            clienteNombre: ticket.contact?.name || item.contactName || '',
            clienteNumero: ticket.contact?.number || '',
            asesorOrigen: item.fromAdvisorName || 'En espera',
            asesorDestino: item.toAdvisorName,
            asesorDestinoUserId: item.toUserId,
            accion: 'auto',
            resultado: 'error',
            mensajeError: err.message
          });
        }
      }
      if (mode === 'round_robin' || mode === 'weighted') {
        appDb.updateRoundRobinCursor(plan.nextRoundRobinCursor);
      }
      await refreshBoardState({ forceRefresh: true });
    } finally {
      releaseLock();
    }
  }

  function restartPollingTimer() {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
    const sec = Math.max(5, Number(appDb.getRawSettings().polling_sec || 20));
    pollingTimer = setInterval(() => {
      refreshBoardState({ forceRefresh: true })
        .then(() => runAutoAssign())
        .catch((err) => console.error('[Polling]', err.message));
    }, sec * 1000);
    if (pollingTimer.unref) pollingTimer.unref();
  }

  restartPollingTimer();

  // Handler HTTP compatible con Express o http.createServer directo
  async function handleRequest(req, res) {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;
    const method = req.method.toUpperCase();
    const clientIp = req.socket?.remoteAddress || '127.0.0.1';

    const sendJson = (statusCode, obj, extraHeaders = {}) => {
      const body = JSON.stringify(obj);
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders
      });
      res.end(body);
    };

    const readJsonBody = () =>
      new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 1024 * 1024) {
            reject(new Error('El cuerpo de la petición excede el tamaño permitido.'));
          }
        });
        req.on('end', () => {
          if (!raw.trim()) return resolve({});
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error('JSON inválido en la solicitud.'));
          }
        });
        req.on('error', reject);
      });

    // Regla de seguridad clave:
    // Mientras la app no esté configurada, el asistente solo es accesible desde localhost.
    const setupStatus = appDb.getSetupStatus(host);
    if (!setupStatus.configured && !isLocalhostIp(clientIp)) {
      if (pathname.startsWith('/api/')) {
        return sendJson(403, {
          error: 'Configura la app desde el equipo donde está instalada'
        });
      }
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Configura la app desde el equipo donde está instalada');
    }

    // Autenticación por PIN si está configurada o si HOST=0.0.0.0
    const rawSettings = appDb.getRawSettings();
    const pinRequired = Boolean(rawSettings.pin_hash) && setupStatus.configured;
    const cookies = parseCookies(req.headers.cookie || '');
    const sessionValid = pinRequired
      ? Boolean(verifySessionToken(cookies.panel_session, secretPath))
      : true;

    // Endpoints de autenticación por PIN
    if (pathname === '/api/auth/status' && method === 'GET') {
      return sendJson(200, {
        pinRequired,
        authenticated: sessionValid
      });
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      if (isPinLocked(clientIp)) {
        return sendJson(429, {
          error: 'Demasiados intentos de PIN fallidos. Espera 5 minutos antes de volver a intentar.'
        });
      }
      if (!checkRateLimit(clientIp)) {
        return sendJson(429, { error: 'Demasiados intentos. Espera un minuto.' });
      }
      try {
        const body = await readJsonBody();
        if (!appDb.verifyUserPin(String(body.pin || ''))) {
          registerPinFailure(clientIp);
          return sendJson(401, { error: 'PIN incorrecto.' });
        }
        pinFailures.delete(clientIp);
        const token = signSessionToken(
          { auth: true, exp: Date.now() + 12 * 3600 * 1000 },
          secretPath
        );
        return sendJson(
          200,
          { ok: true },
          {
            'Set-Cookie': `panel_session=${encodeURIComponent(
              token
            )}; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200`
          }
        );
      } catch (err) {
        return sendJson(400, { error: err.message });
      }
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      return sendJson(
        200,
        { ok: true },
        {
          'Set-Cookie': 'panel_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0'
        }
      );
    }

    // Si es una ruta /api/ protegida y requiere PIN, validar sesión (excepto /api/setup/status)
    if (pathname.startsWith('/api/') && pathname !== '/api/setup/status' && !sessionValid) {
      return sendJson(401, {
        error: 'Sesión bloqueada por PIN. Ingresa tu PIN para continuar.',
        pinRequired: true
      });
    }

    // Rate limiting en rutas de escritura
    if (pathname.startsWith('/api/') && method !== 'GET') {
      if (!checkRateLimit(clientIp)) {
        return sendJson(429, {
          error: 'Límite de operaciones por minuto alcanzado. Espera unos segundos.'
        });
      }
    }

    try {
      // --- RUTAS DE SETUP Y CONFIGURACIÓN ---
      if (pathname === '/api/setup/status' && method === 'GET') {
        return sendJson(200, {
          ...setupStatus,
          authenticated: sessionValid
        });
      }

      if (pathname === '/api/config' && method === 'GET') {
        return sendJson(200, appDb.getPublicConfig());
      }

      if (pathname === '/api/setup/test-connection' && method === 'POST') {
        const body = await readJsonBody();
        const result = await wtClient.testConnection({
          baseUrl: body.baseUrl,
          token: body.token
        });
        return sendJson(200, result);
      }

      if (pathname === '/api/setup/connection' && method === 'PUT') {
        const body = await readJsonBody();
        const cfg = appDb.saveConnection({
          baseUrl: body.baseUrl,
          token: body.token
        });
        wtClient.clearAuthError();
        wtClient.invalidateCache();
        return sendJson(200, cfg);
      }

      if (pathname === '/api/setup/token' && method === 'DELETE') {
        const cfg = appDb.clearToken();
        wtClient.invalidateCache();
        return sendJson(200, cfg);
      }

      if (pathname === '/api/setup/import' && method === 'POST') {
        let departments = [];
        try {
          departments = await wtClient.listDepartments();
        } catch {
          departments = [];
        }
        const users = await wtClient.listUsers(null, departments);
        const merged = appDb.mergeImportedEntities({ users, departments });
        return sendJson(200, {
          ok: true,
          usersCount: users.length,
          departmentsCount: departments.length,
          ...merged
        });
      }

      if (pathname === '/api/setup/advisors' && method === 'PUT') {
        const body = await readJsonBody();
        const cfg = appDb.saveAdvisorsConfig({
          advisors: Array.isArray(body.advisors) ? body.advisors : [],
          supervisorUserId: body.supervisorUserId
        });
        return sendJson(200, cfg);
      }

      if (pathname === '/api/setup/rules' && method === 'PUT') {
        const body = await readJsonBody();
        const cfg = appDb.saveRules(body);
        restartPollingTimer();
        return sendJson(200, cfg);
      }

      if (pathname === '/api/setup/access' && method === 'PUT') {
        const body = await readJsonBody();
        const cfg = appDb.saveAccess({
          pin: body.pin,
          clearPin: Boolean(body.clearPin),
          markConfigured: body.markConfigured !== false,
          host
        });
        const extraHeaders = {};
        if (appDb.getRawSettings().pin_hash) {
          const token = signSessionToken(
            { auth: true, exp: Date.now() + 12 * 3600 * 1000 },
            secretPath
          );
          extraHeaders['Set-Cookie'] = `panel_session=${encodeURIComponent(
            token
          )}; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200`;
        }
        return sendJson(200, cfg, extraHeaders);
      }

      // --- TABLERO Y STREAM SSE ---
      if (pathname === '/api/board' && method === 'GET') {
        const force = urlObj.searchParams.get('refresh') === 'true';
        const board = await refreshBoardState({ forceRefresh: force });
        return sendJson(200, board);
      }

      if (pathname === '/api/stream' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        });
        res.write(`event: connected\ndata: {"ok":true}\n\n`);
        if (lastBoardState) {
          res.write(`event: board\ndata: ${JSON.stringify(lastBoardState)}\n\n`);
        }
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // --- ACTUALIZACIÓN DE ASESOR INDIVIDUAL ---
      const advisorPatchMatch = pathname.match(/^\/api\/advisors\/(\d+)$/);
      if (advisorPatchMatch && method === 'PATCH') {
        const advisorId = Number(advisorPatchMatch[1]);
        const body = await readJsonBody();
        const updated = appDb.patchAdvisor(advisorId, body);
        const board = await refreshBoardState({ forceRefresh: false });
        return sendJson(200, { advisor: updated, board });
      }

      // --- REASIGNACIÓN MANUAL DE TICKETS ---
      if (pathname === '/api/tickets/assign' && method === 'POST') {
        const body = await readJsonBody();
        const ticketIds = Array.isArray(body.ticketIds) ? body.ticketIds.map(String) : [];
        if (ticketIds.length === 0) {
          return sendJson(400, { error: 'Debes seleccionar al menos un ticket.' });
        }

        // Resolver asesor destino: por advisorId (PK local), o por userId (UUID Whaticket, ej. supervisor "Tomar yo")
        const advisors = appDb.listAdvisors();
        let targetAdvisor = null;
        if (body.advisorId !== undefined && body.advisorId !== null && body.advisorId !== '') {
          targetAdvisor = advisors.find((a) => a.id === Number(body.advisorId));
        } else if (body.userId) {
          targetAdvisor = advisors.find(
            (a) => String(a.whaticket_user_id) === String(body.userId)
          ) || {
            id: null,
            whaticket_user_id: String(body.userId),
            nombre_visible: 'Supervisor'
          };
        }

        if (!targetAdvisor || !targetAdvisor.whaticket_user_id) {
          return sendJson(400, { error: 'Asesor destino no válido.' });
        }

        if (!acquireLock()) {
          return sendJson(409, {
            error: 'Hay otra operación de asignación en curso. Espera unos segundos.'
          });
        }

        try {
          const board = lastBoardState || (await refreshBoardState({ forceRefresh: false }));
          const ticketMap = new Map((board.allTickets || []).map((t) => [String(t.id), t]));
          const settings = appDb.getRawSettings();
          const force = Boolean(body.force);
          const results = [];

          for (const tId of ticketIds) {
            const ticket = ticketMap.get(tId) || { id: tId, status: 'pending' };
            if (!force && ticketIds.length > 1) {
              const prot = checkTicketProtection(ticket, settings.protection_min);
              if (prot.protected) {
                results.push({
                  ticketId: tId,
                  ok: false,
                  skippedProtected: true,
                  error: prot.reason
                });
                continue;
              }
            }

            try {
              await wtClient.assignTicket(ticket, {
                userId: targetAdvisor.whaticket_user_id,
                queueId: body.queueId !== undefined ? body.queueId : undefined
              });
              const outcome = settings.dry_run ? 'simulacion' : 'ok';
              appDb.addAssignmentLog({
                ticketId: tId,
                clienteNombre: ticket.contact?.name || '',
                clienteNumero: ticket.contact?.number || '',
                asesorOrigen: ticket.advisorName || 'En espera',
                asesorDestino: targetAdvisor.nombre_visible,
                asesorDestinoUserId: targetAdvisor.whaticket_user_id,
                accion: 'manual',
                resultado: outcome
              });
              results.push({ ticketId: tId, ok: true, simulated: Boolean(settings.dry_run) });
            } catch (err) {
              appDb.addAssignmentLog({
                ticketId: tId,
                clienteNombre: ticket.contact?.name || '',
                clienteNumero: ticket.contact?.number || '',
                asesorOrigen: ticket.advisorName || 'En espera',
                asesorDestino: targetAdvisor.nombre_visible,
                asesorDestinoUserId: targetAdvisor.whaticket_user_id,
                accion: 'manual',
                resultado: 'error',
                mensajeError: err.message
              });
              results.push({ ticketId: tId, ok: false, error: err.message });
            }
          }

          const updatedBoard = await refreshBoardState({ forceRefresh: true });
          return sendJson(200, {
            ok: true,
            dryRun: Boolean(settings.dry_run),
            results,
            board: updatedBoard
          });
        } finally {
          releaseLock();
        }
      }

      // --- REPARTO EQUITATIVO (CON SOPORTE DE VISTA PREVIA preview=true) ---
      if (pathname === '/api/distribute' && method === 'POST') {
        const body = await readJsonBody();
        const isPreview =
          urlObj.searchParams.get('preview') === 'true' || Boolean(body.preview);
        const settings = appDb.getRawSettings();
        const mode = body.mode || settings.default_mode || 'least_load';
        const advisorType = body.advisorType || null;
        const force = Boolean(body.force);

        const board = lastBoardState || (await refreshBoardState({ forceRefresh: false }));
        const requestedIds =
          Array.isArray(body.ticketIds) && body.ticketIds.length > 0
            ? new Set(body.ticketIds.map(String))
            : null;

        const candidateTickets = requestedIds
          ? (board.allTickets || []).filter((t) => requestedIds.has(String(t.id)))
          : board.waitingTickets || [];

        const plan = planDistribution({
          tickets: candidateTickets,
          advisors: board.advisors || [],
          mode,
          advisorType,
          protectionMinutes: settings.protection_min,
          force,
          roundRobinCursor: settings.round_robin_cursor || 0
        });

        if (isPreview) {
          return sendJson(200, {
            preview: true,
            dryRun: Boolean(settings.dry_run),
            ...plan
          });
        }

        if (!acquireLock()) {
          return sendJson(409, {
            error: 'Hay otra operación de reparto en curso. Espera unos segundos.'
          });
        }

        try {
          const results = [];
          const ticketMap = new Map(candidateTickets.map((t) => [String(t.id), t]));

          for (const item of plan.assignments) {
            const ticket = ticketMap.get(String(item.ticketId)) || {
              id: item.ticketId,
              status: item.ticketStatus
            };
            try {
              await wtClient.assignTicket(ticket, { userId: item.toUserId });
              const outcome = settings.dry_run ? 'simulacion' : 'ok';
              appDb.addAssignmentLog({
                ticketId: item.ticketId,
                clienteNombre: ticket.contact?.name || item.contactName || '',
                clienteNumero: ticket.contact?.number || '',
                asesorOrigen: item.fromAdvisorName || 'En espera',
                asesorDestino: item.toAdvisorName,
                asesorDestinoUserId: item.toUserId,
                accion: 'reparto',
                resultado: outcome
              });
              results.push({ ...item, ok: true, simulated: Boolean(settings.dry_run) });
            } catch (err) {
              appDb.addAssignmentLog({
                ticketId: item.ticketId,
                clienteNombre: ticket.contact?.name || item.contactName || '',
                clienteNumero: ticket.contact?.number || '',
                asesorOrigen: item.fromAdvisorName || 'En espera',
                asesorDestino: item.toAdvisorName,
                asesorDestinoUserId: item.toUserId,
                accion: 'reparto',
                resultado: 'error',
                mensajeError: err.message
              });
              results.push({ ...item, ok: false, error: err.message });
            }
          }

          if (mode === 'round_robin') {
            appDb.updateRoundRobinCursor(plan.nextRoundRobinCursor);
          }

          const updatedBoard = await refreshBoardState({ forceRefresh: true });
          return sendJson(200, {
            ok: true,
            dryRun: Boolean(settings.dry_run),
            ...plan,
            results,
            board: updatedBoard
          });
        } finally {
          releaseLock();
        }
      }

      // --- QUITARLE TODO A UN ASESOR (LIBERAR Y REDISTRIBUIR) ---
      const releaseMatch = pathname.match(/^\/api\/advisors\/(\d+)\/release$/);
      if (releaseMatch && method === 'POST') {
        const advisorId = Number(releaseMatch[1]);
        const body = await readJsonBody();
        const isPreview =
          urlObj.searchParams.get('preview') === 'true' || Boolean(body.preview);
        const settings = appDb.getRawSettings();
        const force = Boolean(body.force);

        const board = lastBoardState || (await refreshBoardState({ forceRefresh: false }));
        const targetAdvisor = appDb.listAdvisors().find((a) => a.id === advisorId);
        if (!targetAdvisor) {
          return sendJson(404, { error: 'Asesor no encontrado.' });
        }

        const plan = planAdvisorRelease({
          advisorToRelease: targetAdvisor,
          allTickets: board.allTickets || [],
          allAdvisors: board.advisors || [],
          mode: body.mode || settings.default_mode || 'least_load',
          protectionMinutes: settings.protection_min,
          force,
          roundRobinCursor: settings.round_robin_cursor || 0
        });

        if (isPreview) {
          return sendJson(200, {
            preview: true,
            advisorReleased: targetAdvisor.nombre_visible,
            dryRun: Boolean(settings.dry_run),
            ...plan
          });
        }

        if (!acquireLock()) {
          return sendJson(409, {
            error: 'Hay otra operación en curso. Espera unos segundos.'
          });
        }

        try {
          // Opcionalmente marcar al asesor como no disponible al quitarle todo si se solicita
          if (body.markUnavailable) {
            appDb.patchAdvisor(advisorId, { disponible: false });
          }

          const ticketMap = new Map((board.allTickets || []).map((t) => [String(t.id), t]));
          const results = [];

          for (const item of plan.assignments) {
            const ticket = ticketMap.get(String(item.ticketId)) || {
              id: item.ticketId,
              status: 'open'
            };
            try {
              await wtClient.assignTicket(ticket, { userId: item.toUserId });
              const outcome = settings.dry_run ? 'simulacion' : 'ok';
              appDb.addAssignmentLog({
                ticketId: item.ticketId,
                clienteNombre: ticket.contact?.name || item.contactName || '',
                clienteNumero: ticket.contact?.number || '',
                asesorOrigen: targetAdvisor.nombre_visible,
                asesorDestino: item.toAdvisorName,
                asesorDestinoUserId: item.toUserId,
                accion: 'liberar',
                resultado: outcome
              });
              results.push({ ...item, ok: true, simulated: Boolean(settings.dry_run) });
            } catch (err) {
              appDb.addAssignmentLog({
                ticketId: item.ticketId,
                clienteNombre: ticket.contact?.name || item.contactName || '',
                clienteNumero: ticket.contact?.number || '',
                asesorOrigen: targetAdvisor.nombre_visible,
                asesorDestino: item.toAdvisorName,
                asesorDestinoUserId: item.toUserId,
                accion: 'liberar',
                resultado: 'error',
                mensajeError: err.message
              });
              results.push({ ...item, ok: false, error: err.message });
            }
          }

          const updatedBoard = await refreshBoardState({ forceRefresh: true });
          return sendJson(200, {
            ok: true,
            advisorReleased: targetAdvisor.nombre_visible,
            dryRun: Boolean(settings.dry_run),
            ...plan,
            results,
            board: updatedBoard
          });
        } finally {
          releaseLock();
        }
      }

      // --- HISTORIAL (LOG) Y REINTENTO DE FALLIDOS ---
      if (pathname === '/api/log' && method === 'GET') {
        const logs = appDb.listLogs({
          dateFrom: urlObj.searchParams.get('dateFrom') || null,
          dateTo: urlObj.searchParams.get('dateTo') || null,
          advisor: urlObj.searchParams.get('advisor') || null,
          resultado: urlObj.searchParams.get('resultado') || null
        });
        return sendJson(200, { logs });
      }

      // --- VISTA GENERAL DE ASIGNACIONES (POR DÍA, MES Y AÑO) ---
      if (pathname === '/api/overview' && method === 'GET') {
        const granularity = urlObj.searchParams.get('granularity') || 'day';
        const value = urlObj.searchParams.get('value') || '';
        const userId = urlObj.searchParams.get('userId') || null;
        const settings = appDb.getRawSettings();
        const includeSimulated =
          urlObj.searchParams.get('includeSimulated') !== null
            ? urlObj.searchParams.get('includeSimulated') === 'true'
            : Boolean(settings.dry_run);

        const { start, end } = periodRange(granularity, value);
        const events = appDb.listAssignmentEvents({
          fromIso: start.toISOString(),
          toIso: end.toISOString(),
          userId: userId || null,
          includeSimulated
        });

        const advisors = appDb.listAdvisors();
        const advisorByUid = new Map(advisors.map((a) => [String(a.whaticket_user_id), a]));
        const liveUsers = wtClient.liveUsersCache?.map || new Map();
        const aggregated = aggregateEvents({
          events,
          granularity,
          start,
          end,
          advisors,
          liveUsers,
          userId: userId || null
        });

        // Construir tabla de usuario x día ordenada por mes (para ver por fila cada usuario y cuántos tickets se le asignaron ese día)
        const userDayMap = new Map();
        for (const ev of events) {
          const uid = String(ev.user_id);
          if (userId && uid !== String(userId)) continue;
          const d = new Date(ev.fecha_hora);
          if (Number.isNaN(d.getTime())) continue;
          const dayKey = localDateKey(d);
          const monthKey = dayKey.slice(0, 7);
          const composite = `${dayKey}__${uid}`;
          if (!userDayMap.has(composite)) {
            const adv = advisorByUid.get(uid);
            const live = liveUsers.get(uid);
            userDayMap.set(composite, {
              monthKey,
              dayKey,
              userId: uid,
              nombre: adv ? adv.nombre_visible : live ? live.name : `Usuario ${uid.slice(0, 6)}`,
              tipo: adv ? adv.tipo : 'General',
              nivel: adv ? adv.peso : 1,
              fotoPerfil: (adv && adv.foto_url) || (live && live.profilePicUrl) || null,
              online: live ? live.online : null,
              totalDia: 0,
              byOrigin: {}
            });
          }
          const rec = userDayMap.get(composite);
          rec.totalDia += 1;
          rec.byOrigin[ev.origen] = (rec.byOrigin[ev.origen] || 0) + 1;
        }
        const dailyUserRows = Array.from(userDayMap.values()).sort(
          (a, b) =>
            b.dayKey.localeCompare(a.dayKey) ||
            b.totalDia - a.totalDia ||
            a.nombre.localeCompare(b.nombre)
        );

        return sendJson(200, {
          granularity,
          value: value || (granularity === 'day' ? localDateKey(start) : granularity === 'month' ? `${start.getFullYear()}-${pad2(start.getMonth() + 1)}` : String(start.getFullYear())),
          startIso: start.toISOString(),
          endIso: end.toISOString(),
          includeSimulated,
          originLabels: ORIGIN_LABELS,
          ...aggregated,
          dailyUserRows
        });
      }

      // --- DETALLE DE TICKETS Y CANTIDAD DIARIA DE UN USUARIO (MODAL AL HACER CLIC EN EL NOMBRE) ---
      if (pathname === '/api/user-tickets' && method === 'GET') {
        const userId = String(urlObj.searchParams.get('userId') || '').trim();
        if (!userId) {
          return sendJson(400, { error: 'Se requiere userId.' });
        }
        const dateParam = urlObj.searchParams.get('date') || '';
        const { start: dayStart, end: dayEnd } = periodRange('day', dateParam);
        const selectedDate = localDateKey(dayStart);

        // Eventos del mes de la fecha seleccionada para mostrar también el resumen por día del mes
        const monthVal = selectedDate.slice(0, 7);
        const { start: monthStart, end: monthEnd } = periodRange('month', monthVal);

        const settings = appDb.getRawSettings();
        const includeSimulated = Boolean(settings.dry_run);

        const dayEvents = appDb.listAssignmentEvents({
          fromIso: dayStart.toISOString(),
          toIso: dayEnd.toISOString(),
          userId,
          includeSimulated: true
        });
        const monthEvents = appDb.listAssignmentEvents({
          fromIso: monthStart.toISOString(),
          toIso: monthEnd.toISOString(),
          userId,
          includeSimulated: true
        });

        const dailyCountsMap = {};
        for (const ev of monthEvents) {
          const dk = localDateKey(new Date(ev.fecha_hora));
          dailyCountsMap[dk] = (dailyCountsMap[dk] || 0) + 1;
        }
        const dailyBreakdown = Object.entries(dailyCountsMap)
          .map(([day, count]) => ({ day, count }))
          .sort((a, b) => b.day.localeCompare(a.day));

        const board = lastBoardState || (await refreshBoardState({ forceRefresh: false }));
        const advisorObj =
          (board.allAdvisorsConfig || []).find((a) => String(a.whaticket_user_id) === userId) ||
          appDb.listAdvisors().find((a) => String(a.whaticket_user_id) === userId) || {
            whaticket_user_id: userId,
            nombre_visible: `Usuario ${userId.slice(0, 6)}`,
            tipo: 'Digital',
            peso: 1,
            tope_maximo: 15,
            currentLoad: 0,
            unansweredCount: 0,
            assignedToday: 0
          };

        const activeTickets = (board.allTickets || []).filter(
          (t) => String(t.userId || '') === userId
        );

        const formattedDayEvents = dayEvents
          .slice()
          .reverse()
          .map((ev) => ({
            id: ev.id,
            fechaHora: ev.fecha_hora,
            ticketId: ev.ticket_id,
            clienteNombre: ev.cliente_nombre || 'Sin nombre',
            clienteNumero: ev.cliente_numero || '',
            origen: ev.origen,
            origenLabel: ORIGIN_LABELS[ev.origen] || ev.origen,
            simulado: Boolean(ev.simulado)
          }));

        return sendJson(200, {
          userId,
          selectedDate,
          month: monthVal,
          includeSimulated,
          advisor: {
            id: advisorObj.id || null,
            userId,
            nombre: advisorObj.nombre_visible,
            tipo: advisorObj.tipo || 'Digital',
            nivel: advisorObj.peso || 1,
            topeMaximo: advisorObj.tope_maximo || 15,
            currentLoad: advisorObj.currentLoad || activeTickets.length,
            unansweredCount: advisorObj.unansweredCount || 0,
            assignedToday: advisorObj.assignedToday || 0,
            online: advisorObj.online ?? null,
            whaticketStatus: advisorObj.whaticketStatus || null,
            away: advisorObj.away || null,
            fotoPerfil: advisorObj.fotoPerfil || advisorObj.foto_url || null
          },
          assignedOnDateCount: formattedDayEvents.length,
          activeTicketsCount: activeTickets.length,
          activeTickets,
          dayEvents: formattedDayEvents,
          dailyBreakdown
        });
      }

      // --- INFORMES MENSUALES POR USUARIO ---
      if (pathname === '/api/reports/monthly' && method === 'GET') {
        const monthVal = urlObj.searchParams.get('month') || '';
        const userId = urlObj.searchParams.get('userId') || null;
        const settings = appDb.getRawSettings();
        const includeSimulated =
          urlObj.searchParams.get('includeSimulated') !== null
            ? urlObj.searchParams.get('includeSimulated') === 'true'
            : Boolean(settings.dry_run);

        const { start, end } = periodRange('month', monthVal);
        const normalizedMonth = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}`;

        const events = appDb.listAssignmentEvents({
          fromIso: start.toISOString(),
          toIso: end.toISOString(),
          userId: userId || null,
          includeSimulated
        });

        const advisors = appDb.listAdvisors();
        const advisorByUid = new Map(advisors.map((a) => [String(a.whaticket_user_id), a]));
        const liveUsers = wtClient.liveUsersCache?.map || new Map();

        const aggregated = aggregateEvents({
          events,
          granularity: 'month',
          start,
          end,
          advisors,
          liveUsers,
          userId: userId || null
        });

        const detailedItems = events
          .slice()
          .reverse()
          .slice(0, 2000)
          .map((ev) => {
            const adv = advisorByUid.get(String(ev.user_id));
            const live = liveUsers.get(String(ev.user_id));
            return {
              id: ev.id,
              fechaHora: ev.fecha_hora,
              fechaDia: localDateKey(new Date(ev.fecha_hora)),
              ticketId: ev.ticket_id,
              userId: ev.user_id,
              advisorName: adv ? adv.nombre_visible : live ? live.name : `Usuario ${String(ev.user_id).slice(0, 6)}`,
              advisorType: adv ? adv.tipo : '-',
              clienteNombre: ev.cliente_nombre || 'Sin nombre',
              clienteNumero: ev.cliente_numero || '',
              origen: ev.origen,
              origenLabel: ORIGIN_LABELS[ev.origen] || ev.origen,
              simulado: Boolean(ev.simulado)
            };
          });

        return sendJson(200, {
          month: normalizedMonth,
          userId: userId || null,
          includeSimulated,
          originLabels: ORIGIN_LABELS,
          ...aggregated,
          items: detailedItems
        });
      }

      const retryMatch = pathname.match(/^\/api\/log\/(\d+)\/retry$/);
      if (retryMatch && method === 'POST') {
        const logId = Number(retryMatch[1]);
        const entry = appDb.getLogById(logId);
        if (!entry) {
          return sendJson(404, { error: 'Registro de historial no encontrado.' });
        }
        if (!entry.asesor_destino_user_id) {
          return sendJson(400, {
            error: 'Este registro no contiene un UUID de asesor destino para reintentar.'
          });
        }

        const settings = appDb.getRawSettings();
        const board = lastBoardState || (await refreshBoardState({ forceRefresh: false }));
        const ticket = (board.allTickets || []).find(
          (t) => String(t.id) === String(entry.ticket_id)
        ) || { id: entry.ticket_id, status: 'pending' };

        try {
          await wtClient.assignTicket(ticket, { userId: entry.asesor_destino_user_id });
          const outcome = settings.dry_run ? 'simulacion' : 'ok';
          appDb.addAssignmentLog({
            ticketId: entry.ticket_id,
            clienteNombre: entry.cliente_nombre || '',
            clienteNumero: entry.cliente_numero || '',
            asesorOrigen: entry.asesor_origen,
            asesorDestino: entry.asesor_destino,
            asesorDestinoUserId: entry.asesor_destino_user_id,
            accion: entry.accion,
            resultado: outcome
          });
          const updatedBoard = await refreshBoardState({ forceRefresh: true });
          return sendJson(200, { ok: true, board: updatedBoard });
        } catch (err) {
          appDb.addAssignmentLog({
            ticketId: entry.ticket_id,
            clienteNombre: entry.cliente_nombre || '',
            clienteNumero: entry.cliente_numero || '',
            asesorOrigen: entry.asesor_origen,
            asesorDestino: entry.asesor_destino,
            asesorDestinoUserId: entry.asesor_destino_user_id,
            accion: entry.accion,
            resultado: 'error',
            mensajeError: err.message
          });
          return sendJson(502, { error: err.message });
        }
      }

      // --- EXPORTAR CONTACTOS LIMPIOS DESDE WHATICKET (.xlsx / .csv) ---
      if (pathname === '/api/contacts/export' && method === 'POST') {
        const body = await readJsonBody();
        const format = String(body.format || 'xlsx').trim().toLowerCase();
        if (format !== 'xlsx' && format !== 'csv') {
          return sendJson(400, { error: 'Formato inválido. Usa "xlsx" o "csv".' });
        }

        const minClientMessages =
          body.minClientMessages !== undefined && body.minClientMessages !== null
            ? body.minClientMessages
            : DEFAULT_MIN_CLIENT_MESSAGES;

        const { contacts, summary } = await extractCleanContacts(wtClient, {
          minClientMessages,
          statuses: body.statuses
        });

        const buffer =
          format === 'csv' ? buildContactsCsv(contacts) : buildContactsXlsx(contacts);
        const filename = `contactos-whaticket-${localDateKey(new Date())}.${format}`;
        const contentType =
          format === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(buffer.length),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Export-Exported-Count': String(summary.exported),
          'X-Export-Discarded-Count': String(summary.discarded),
          'X-Export-Total-Tickets': String(summary.totalTickets),
          'X-Export-Filename': filename,
          'X-Export-Summary': encodeURIComponent(JSON.stringify(summary))
        });
        return res.end(buffer);
      }

      // --- ARCHIVOS ESTÁTICOS FRONTEND ---
      if (method === 'GET' || method === 'HEAD') {
        let relPath = pathname === '/' ? '/index.html' : pathname;
        const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
        const filePath = path.join(publicDir, safePath);

        if (filePath.startsWith(publicDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.svg': 'image/svg+xml',
            '.json': 'application/json; charset=utf-8'
          };
          res.writeHead(200, {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff'
          });
          return fs.createReadStream(filePath).pipe(res);
        }
      }

      return sendJson(404, { error: 'Ruta no encontrada.' });
    } catch (err) {
      const isValidation = /inválid|obligatori|debe|vacío|no encontrado/i.test(err.message || '');
      const status = err.status || (isValidation ? 400 : 500);
      return sendJson(status, {
        error: err.message || 'Error interno del servidor.'
      });
    }
  }

  // Usar Express si está instalado en node_modules, o servidor HTTP nativo de Node
  let serverHandler = handleRequest;
  try {
    const express = require('express');
    const expressApp = express();
    expressApp.disable('x-powered-by');
    expressApp.use((req, res) => handleRequest(req, res));
    serverHandler = expressApp;
  } catch {
    // Funciona de forma idéntica con http.createServer(handleRequest)
  }

  return {
    appDb,
    wtClient,
    handleRequest,
    createHttpServer() {
      return http.createServer(serverHandler);
    },
    stopPolling() {
      if (pollingTimer) clearInterval(pollingTimer);
    }
  };
}

module.exports = {
  createServerApp,
  buildBoardState
};
