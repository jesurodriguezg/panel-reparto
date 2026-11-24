'use strict';

const { buildXlsxBuffer } = require('./xlsxBuilder');

// Constantes configurables para el filtro y consultas hacia la API de Whaticket
const DEFAULT_MIN_CLIENT_MESSAGES = 2; // 2 = más de 1 mensaje enviado por el cliente
const DEFAULT_EXPORT_STATUSES = ['open', 'pending', 'closed'];
const ALLOWED_STATUSES = new Set(['open', 'pending', 'closed']);
const DEFAULT_MAX_TICKET_PAGES = 15; // Hasta 1.500 tickets (100 por página)
const DEFAULT_MAX_MESSAGE_PAGES_PER_TICKET = 3;
const MESSAGE_FETCH_CONCURRENCY = 4;
const MESSAGE_BATCH_DELAY_MS = 120;

const SYSTEM_MESSAGE_TYPES = new Set([
  'system',
  'protocol',
  'e2e_notification',
  'notification_template',
  'gp2',
  'revoked'
]);

const STATUS_LABELS = {
  open: 'Abierto',
  pending: 'En espera',
  closed: 'Cerrado'
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatLocalDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Limpia y valida un número de WhatsApp colombiano de 10 dígitos (iniciado en 3).
 * Descarta grupos (@g.us o isGroup=true), canales ajenos a WhatsApp, @lid/@broadcast,
 * IDs internos y prefijos extranjeros distintos de +57 / 57.
 */
function cleanAndValidateColombianMobile(rawNumber, ticket = null) {
  if (ticket && ticket.isGroup === true) {
    return { ok: false, reason: 'group' };
  }

  if (ticket && ticket.channel) {
    const channel = String(ticket.channel).trim();
    if (channel && !/whatsapp|waba|baileys/i.test(channel)) {
      return { ok: false, reason: 'nonWhatsapp' };
    }
  }

  if (rawNumber === null || rawNumber === undefined) {
    return { ok: false, reason: 'invalidNumber' };
  }

  // Eliminar espacios invisibles y marcas direccionales Unicode
  let text = String(rawNumber)
    .replace(/[\u00A0\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .trim();

  if (!text) {
    return { ok: false, reason: 'invalidNumber' };
  }

  if (/@g\.us\b/i.test(text)) {
    return { ok: false, reason: 'group' };
  }

  if (text.includes('@')) {
    const jidMatch = text.match(/^([+\d\s().\-]+?)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/i);
    if (!jidMatch) {
      return { ok: false, reason: 'invalidNumber' };
    }
    text = jidMatch[1];
  }

  // Rechazar IDs internos con letras o símbolos inesperados (ej. ig_123, uuid, emails)
  if (/[^0-9+\s().\-]/.test(text)) {
    return { ok: false, reason: 'invalidNumber' };
  }

  // Quitar espacios, guiones, paréntesis y puntos
  let cleaned = text.replace(/[\s().\-]/g, '');

  if (cleaned.startsWith('+')) {
    // Exigir explícitamente +57 cuando viene signo '+' para no aceptar prefijos extranjeros
    if (!cleaned.startsWith('+57')) {
      return { ok: false, reason: 'invalidNumber' };
    }
    cleaned = cleaned.slice(3);
  } else if (cleaned.startsWith('57')) {
    cleaned = cleaned.slice(2);
  }

  if (!/^3\d{9}$/.test(cleaned)) {
    return { ok: false, reason: 'invalidNumber' };
  }

  return { ok: true, phone: cleaned };
}

/**
 * Determina si un mensaje corresponde a un mensaje entrante real del cliente
 * (excluye asesores, bots con fromMe=true, notas internas, eliminados y eventos de sistema).
 */
function isClientIncomingMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.fromMe !== false) return false;
  if (msg.isNote || msg.isPrivate || msg.isDeleted || msg.userId) return false;

  const msgType = String(msg.type || msg.mediaType || '').trim().toLowerCase();
  if (msgType && SYSTEM_MESSAGE_TYPES.has(msgType)) {
    return false;
  }

  return true;
}

/**
 * Cuenta mensajes entrantes del cliente en un ticket, paginando hacia atrás solo
 * si el mínimo configurado todavía no se alcanza.
 */
async function countClientMessagesForTicket(
  wtClient,
  ticketId,
  {
    minClientMessages = DEFAULT_MIN_CLIENT_MESSAGES,
    maxMessagePages = DEFAULT_MAX_MESSAGE_PAGES_PER_TICKET
  } = {}
) {
  const seenMsgIds = new Set();
  let clientCount = 0;
  let cursor = null;
  let cursorId = null;

  for (let page = 0; page < maxMessagePages; page++) {
    const res = await wtClient.getTicketMessages(ticketId, {
      cursor,
      cursorId,
      direction: 'before'
    });
    const messages = Array.isArray(res?.messages) ? res.messages : [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m) continue;
      if (m.id !== undefined && m.id !== null) {
        const key = String(m.id);
        if (seenMsgIds.has(key)) continue;
        seenMsgIds.add(key);
      }
      if (isClientIncomingMessage(m)) {
        clientCount += 1;
      }
    }

    if (clientCount >= minClientMessages || !res?.hasMoreBefore || messages.length === 0) {
      break;
    }

    const oldest = messages[0];
    if (!oldest?.createdAt || !oldest?.id) {
      break;
    }
    if (oldest.createdAt === cursor && oldest.id === cursorId) {
      break;
    }
    cursor = oldest.createdAt;
    cursorId = oldest.id;
  }

  return clientCount;
}

function normalizeStatuses(statuses) {
  if (statuses === undefined || statuses === null) {
    return [...DEFAULT_EXPORT_STATUSES];
  }
  const rawList = Array.isArray(statuses)
    ? statuses
    : String(statuses)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  const filtered = [...new Set(rawList.map((s) => String(s).trim().toLowerCase()))].filter((s) =>
    ALLOWED_STATUSES.has(s)
  );
  if (filtered.length === 0) {
    throw new Error('Debes seleccionar al menos un estado válido (open, pending o closed).');
  }
  return filtered;
}

function normalizeMinClientMessages(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_MIN_CLIENT_MESSAGES;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error('El mínimo de mensajes del cliente debe ser un número entero entre 1 y 50.');
  }
  return parsed;
}

function getTicketActivityMs(ticket) {
  const iso = ticket?.lastReceivedMessageAt || ticket?.updatedAt || ticket?.createdAt || '';
  const ms = iso ? new Date(iso).getTime() : 0;
  return Number.isNaN(ms) ? 0 : ms;
}

function pickPreferredName(currentName, candidateName) {
  const cleanCandidate = String(candidateName || '').trim();
  if (!currentName) return cleanCandidate;
  if (!cleanCandidate) return currentName;
  // Preferir un nombre real frente a un texto que solo repite el número
  const currentIsDigits = /^\+?\d+$/.test(currentName.replace(/[\s\-()]/g, ''));
  const candidateIsDigits = /^\+?\d+$/.test(cleanCandidate.replace(/[\s\-()]/g, ''));
  if (currentIsDigits && !candidateIsDigits) return cleanCandidate;
  return currentName;
}

/**
 * Consulta tickets en Whaticket, limpia/valida números colombianos de WhatsApp,
 * deduplica por teléfono y filtra por cantidad mínima de mensajes entrantes del cliente.
 * No escribe ni modifica tablas de base de datos.
 */
async function extractCleanContacts(wtClient, options = {}) {
  const minClientMessages = normalizeMinClientMessages(options.minClientMessages);
  const statuses = normalizeStatuses(options.statuses);
  const maxTicketPages = Math.max(1, Number(options.maxTicketPages || DEFAULT_MAX_TICKET_PAGES));
  const maxMessagePages = Math.max(
    1,
    Number(options.maxMessagePages || DEFAULT_MAX_MESSAGE_PAGES_PER_TICKET)
  );
  const concurrency = Math.max(1, Number(options.concurrency || MESSAGE_FETCH_CONCURRENCY));
  const batchDelayMs =
    options.batchDelayMs !== undefined ? Math.max(0, Number(options.batchDelayMs)) : MESSAGE_BATCH_DELAY_MS;

  const { tickets: rawTickets } = await wtClient.listTicketsRaw({
    statuses,
    maxPages: maxTicketPages
  });

  const reasons = {
    group: 0,
    nonWhatsapp: 0,
    invalidNumber: 0,
    duplicate: 0,
    insufficientMessages: 0,
    fetchError: 0
  };

  // Paso 1: limpieza y agrupación por teléfono sin hacer llamadas a /messages todavía
  const contactsByPhone = new Map();

  for (const t of rawTickets) {
    const check = cleanAndValidateColombianMobile(t?.contact?.number, t);
    if (!check.ok) {
      if (check.reason === 'group') reasons.group += 1;
      else if (check.reason === 'nonWhatsapp') reasons.nonWhatsapp += 1;
      else reasons.invalidNumber += 1;
      continue;
    }

    const phone = check.phone;
    const rawName = String(t?.contact?.name || '').trim();
    if (!contactsByPhone.has(phone)) {
      contactsByPhone.set(phone, {
        phone,
        name: rawName,
        tickets: [t]
      });
    } else {
      const group = contactsByPhone.get(phone);
      group.name = pickPreferredName(group.name, rawName);
      group.tickets.push(t);
    }
  }

  // Ordenar los tickets de cada contacto del más reciente al más antiguo
  for (const group of contactsByPhone.values()) {
    group.tickets.sort((a, b) => getTicketActivityMs(b) - getTicketActivityMs(a));
  }

  // Paso 2: consultar /messages en lotes concurrentes controlados
  const groups = Array.from(contactsByPhone.values());
  const exportedRows = [];

  for (let i = 0; i < groups.length; i += concurrency) {
    const batch = groups.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (group) => {
        let totalClientMessages = 0;
        let succeededFetches = 0;
        let failedFetches = 0;

        for (const t of group.tickets) {
          const neededForThreshold = Math.max(1, minClientMessages - totalClientMessages);
          try {
            const count = await countClientMessagesForTicket(wtClient, t.id, {
              minClientMessages: neededForThreshold,
              maxMessagePages
            });
            totalClientMessages += count;
            succeededFetches += 1;
            if (totalClientMessages >= minClientMessages) {
              break;
            }
          } catch (err) {
            if (err && (err.status === 401 || err.status === 403 || err.code === 'INVALID_TOKEN' || err.code === 'FORBIDDEN')) {
              throw err;
            }
            failedFetches += 1;
          }
        }

        return {
          group,
          totalClientMessages,
          succeededFetches,
          failedFetches
        };
      })
    );

    for (const item of batchResults) {
      const { group, totalClientMessages, succeededFetches, failedFetches } = item;
      const ticketCount = group.tickets.length;
      if (ticketCount > 1) {
        reasons.duplicate += ticketCount - 1;
      }

      if (totalClientMessages >= minClientMessages) {
        const latestTicket = group.tickets[0];
        const activityIso =
          latestTicket?.lastReceivedMessageAt ||
          latestTicket?.updatedAt ||
          latestTicket?.createdAt ||
          '';
        exportedRows.push({
          nombre: group.name || 'Sin nombre',
          telefono: group.phone,
          mensajesCliente: totalClientMessages,
          estado: STATUS_LABELS[latestTicket?.status] || String(latestTicket?.status || ''),
          ultimaActividad: formatLocalDateTime(activityIso),
          _activityMs: getTicketActivityMs(latestTicket)
        });
      } else if (succeededFetches === 0 && failedFetches > 0) {
        reasons.fetchError += 1;
      } else {
        reasons.insufficientMessages += 1;
      }
    }

    if (batchDelayMs > 0 && i + concurrency < groups.length) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
    }
  }

  exportedRows.sort(
    (a, b) => b._activityMs - a._activityMs || a.nombre.localeCompare(b.nombre, 'es')
  );

  const contacts = exportedRows.map(({ _activityMs, ...row }) => row);
  const totalTickets = rawTickets.length;
  const exported = contacts.length;
  const discarded = totalTickets - exported;

  return {
    contacts,
    summary: {
      totalTickets,
      uniqueValidNumbers: contactsByPhone.size,
      exported,
      discarded,
      minClientMessages,
      statuses,
      reasons
    }
  };
}

function escapeCsvFormulaSafe(value) {
  let str = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Genera el contenido CSV con UTF-8 BOM y la columna de teléfono formateada como texto
 * (="3001234567") para evitar notación científica al abrir en Excel.
 */
function buildContactsCsv(contacts = []) {
  const headers = [
    'Nombre',
    'Teléfono',
    'Mensajes del cliente',
    'Estado',
    'Última actividad'
  ];

  const lines = [headers.map((h) => escapeCsvFormulaSafe(h)).join(',')];

  for (const c of contacts) {
    const phoneDigits = String(c.telefono || '').replace(/\D/g, '');
    // En RFC 4180 CSV, ="3001234567" se serializa como "=""3001234567""" para forzar texto en Excel
    const phoneCsvCell = `"=""${phoneDigits}"""`;
    const row = [
      escapeCsvFormulaSafe(c.nombre || 'Sin nombre'),
      phoneCsvCell,
      String(Number(c.mensajesCliente || 0)),
      escapeCsvFormulaSafe(c.estado || ''),
      escapeCsvFormulaSafe(c.ultimaActividad || '')
    ];
    lines.push(row.join(','));
  }

  return Buffer.from(`\uFEFF${lines.join('\r\n')}`, 'utf8');
}

/**
 * Genera el archivo .xlsx en memoria con la columna Teléfono en formato texto (@).
 */
function buildContactsXlsx(contacts = []) {
  return buildXlsxBuffer({
    sheetName: 'Contactos Whaticket',
    columns: [
      { key: 'nombre', header: 'Nombre', width: 30, type: 'text' },
      { key: 'telefono', header: 'Teléfono', width: 16, type: 'text' },
      { key: 'mensajesCliente', header: 'Mensajes del cliente', width: 22, type: 'number' },
      { key: 'estado', header: 'Estado', width: 15, type: 'text' },
      { key: 'ultimaActividad', header: 'Última actividad', width: 22, type: 'text' }
    ],
    rows: contacts
  });
}

module.exports = {
  DEFAULT_MIN_CLIENT_MESSAGES,
  DEFAULT_EXPORT_STATUSES,
  DEFAULT_MAX_TICKET_PAGES,
  DEFAULT_MAX_MESSAGE_PAGES_PER_TICKET,
  MESSAGE_FETCH_CONCURRENCY,
  MESSAGE_BATCH_DELAY_MS,
  cleanAndValidateColombianMobile,
  isClientIncomingMessage,
  countClientMessagesForTicket,
  extractCleanContacts,
  buildContactsCsv,
  buildContactsXlsx
};
