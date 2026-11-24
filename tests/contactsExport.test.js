'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');

const { AppDatabase } = require('../server/db');
const { WhaticketClient } = require('../server/whaticketClient');
const { createServerApp } = require('../server/app');
const { crc32 } = require('../server/xlsxBuilder');
const {
  DEFAULT_MIN_CLIENT_MESSAGES,
  cleanAndValidateColombianMobile,
  isClientIncomingMessage,
  extractCleanContacts,
  buildContactsCsv,
  buildContactsXlsx
} = require('../server/contactsExporter');

/**
 * Lector ZIP minimalista para verificar integridad CRC-32 y descomprimir entradas .xlsx en pruebas.
 */
function parseAndVerifyZip(buffer) {
  assert.equal(buffer[0], 0x50);
  assert.equal(buffer[1], 0x4b);
  assert.equal(buffer[2], 0x03);
  assert.equal(buffer[3], 0x04);

  const entries = new Map();
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;

    const method = buffer.readUInt16LE(offset + 8);
    const expectedCrc = buffer.readUInt32LE(offset + 14);
    const compSize = buffer.readUInt32LE(offset + 18);
    const uncompSize = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLen).toString('utf8');
    const dataStart = nameStart + nameLen + extraLen;
    const compData = buffer.subarray(dataStart, dataStart + compSize);

    assert.equal(method, 8, `Entrada ${name} debe usar DEFLATE`);
    const rawData = zlib.inflateRawSync(compData);
    assert.equal(rawData.length, uncompSize, `Tamaño descomprimido de ${name}`);
    assert.equal(crc32(rawData), expectedCrc, `CRC-32 válido para ${name}`);

    entries.set(name, rawData.toString('utf8'));
    offset = dataStart + compSize;
  }

  return entries;
}

function invokeMockHttp(handler, { method = 'GET', url = '/', headers = {}, body = null, remoteAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { host: '127.0.0.1:3000', ...headers };
    req.socket = { remoteAddress };

    let statusCode = 200;
    let resHeaders = {};
    const chunks = [];

    const res = {
      writeHead(code, hdrs = {}) {
        statusCode = code;
        for (const [k, v] of Object.entries(hdrs)) {
          resHeaders[k.toLowerCase()] = v;
        }
        return this;
      },
      write(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        resolve({
          status: statusCode,
          headers: resHeaders,
          body: Buffer.concat(chunks)
        });
      }
    };

    Promise.resolve(handler(req, res)).catch(reject);

    process.nextTick(() => {
      if (body !== null && body !== undefined) {
        const str = typeof body === 'string' ? body : JSON.stringify(body);
        req.emit('data', Buffer.from(str, 'utf8'));
      }
      req.emit('end');
    });
  });
}

test('Limpieza y validación estricta de celulares colombianos de WhatsApp', () => {
  // Casos válidos
  assert.deepEqual(cleanAndValidateColombianMobile('+57 300 123 4567'), {
    ok: true,
    phone: '3001234567'
  });
  assert.deepEqual(cleanAndValidateColombianMobile('57 (301) 555-0192'), {
    ok: true,
    phone: '3015550192'
  });
  assert.deepEqual(cleanAndValidateColombianMobile('310-456-7890'), {
    ok: true,
    phone: '3104567890'
  });
  assert.deepEqual(cleanAndValidateColombianMobile('573201234567@s.whatsapp.net'), {
    ok: true,
    phone: '3201234567'
  });
  assert.deepEqual(cleanAndValidateColombianMobile('3001234567:12@c.us'), {
    ok: true,
    phone: '3001234567'
  });
  assert.deepEqual(
    cleanAndValidateColombianMobile('\u200B+57 315.987.6543\u00A0', { channel: 'whatsapp', isGroup: false }),
    { ok: true, phone: '3159876543' }
  );

  // Casos descartados: grupos
  assert.deepEqual(cleanAndValidateColombianMobile('573001234567-1600000@g.us'), {
    ok: false,
    reason: 'group'
  });
  assert.deepEqual(cleanAndValidateColombianMobile('573001234567', { isGroup: true, channel: 'whatsapp' }), {
    ok: false,
    reason: 'group'
  });

  // Casos descartados: otros canales
  assert.deepEqual(cleanAndValidateColombianMobile('573001234567', { channel: 'instagram' }), {
    ok: false,
    reason: 'nonWhatsapp'
  });
  assert.deepEqual(cleanAndValidateColombianMobile('573001234567', { channel: 'facebook' }), {
    ok: false,
    reason: 'nonWhatsapp'
  });

  // Casos descartados: @lid, @broadcast, IDs internos, prefijos extranjeros, fijos, longitudes
  for (const invalid of [
    '',
    null,
    '1234567890@lid',
    'status@broadcast',
    'ig_3001234567',
    'usr-abc-123',
    '+34 3001234567',
    '+1 3055551234',
    '6056601234',
    '576012345678',
    '2001234567',
    '300123456',
    '30012345678'
  ]) {
    assert.deepEqual(
      cleanAndValidateColombianMobile(invalid),
      { ok: false, reason: 'invalidNumber' },
      `Debe rechazar: ${String(invalid)}`
    );
  }
});

test('Filtro de mensajes entrantes del cliente ignora asesores, bots, notas y eventos del sistema', () => {
  assert.equal(isClientIncomingMessage({ id: '1', fromMe: false, body: 'Hola' }), true);
  assert.equal(isClientIncomingMessage({ id: '2', fromMe: false, body: '', type: 'image' }), true);

  assert.equal(isClientIncomingMessage({ id: '3', fromMe: true, userId: 'u-1', body: 'Respuesta asesor' }), false);
  assert.equal(isClientIncomingMessage({ id: '4', fromMe: true, userId: null, body: 'Bot automático' }), false);
  assert.equal(isClientIncomingMessage({ id: '5', fromMe: false, isNote: true, body: 'Nota' }), false);
  assert.equal(isClientIncomingMessage({ id: '6', fromMe: false, isPrivate: true, body: 'Privada' }), false);
  assert.equal(isClientIncomingMessage({ id: '7', fromMe: false, isDeleted: true, body: 'Borrado' }), false);
  assert.equal(isClientIncomingMessage({ id: '8', fromMe: false, userId: 'u-2', body: 'Con asesor' }), false);
  assert.equal(isClientIncomingMessage({ id: '9', fromMe: false, type: 'system', body: 'Evento' }), false);
  assert.equal(isClientIncomingMessage({ id: '10', fromMe: false, mediaType: 'e2e_notification' }), false);
});

test('Extracción completa: paginación de tickets y mensajes, deduplicación, conteos exactos y respaldo .env', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-export-extract-'));
  const appDb = new AppDatabase(path.join(tmpDir, 'app.db'), path.join(tmpDir, '.secret'));

  // Probar respaldo .env cuando no hay token guardado en BD
  const prevEnvUrl = process.env.WHATICKET_API_URL;
  const prevEnvToken = process.env.WHATICKET_API_TOKEN;
  process.env.WHATICKET_API_URL = 'https://api.whaticket.com/api/v1';
  process.env.WHATICKET_API_TOKEN = 'env_fallback_token_777';

  const seenAuthHeaders = [];

  try {
    const page1Tickets = [
      // Contacto 1 (ticket reciente con 1 mensaje cliente + 1 bot) -> se sumará con tk-dup (1 mensaje más) = 2
      {
        id: 'tk-1',
        status: 'open',
        channel: 'whatsapp',
        isGroup: false,
        updatedAt: '2026-11-20T15:00:00.000Z',
        contact: { name: 'Ana María', number: '+57 300 111 2233' }
      },
      // Contacto 2: cumple umbral 2 en página anterior (hasMoreBefore)
      {
        id: 'tk-2',
        status: 'closed',
        channel: 'whatsapp',
        isGroup: false,
        updatedAt: '2026-11-20T14:00:00.000Z',
        contact: { name: 'Luis Carlos', number: '573114445566@s.whatsapp.net' }
      },
      // Descartado: grupo
      {
        id: 'tk-grp',
        status: 'open',
        channel: 'whatsapp',
        isGroup: true,
        updatedAt: '2026-11-20T13:00:00.000Z',
        contact: { name: 'Grupo Motos', number: '573001112233-111@g.us' }
      },
      // Descartado: canal Instagram
      {
        id: 'tk-ig',
        status: 'open',
        channel: 'instagram',
        isGroup: false,
        updatedAt: '2026-11-20T12:00:00.000Z',
        contact: { name: 'IG Lead', number: '573009998877' }
      }
    ];

    const page2Tickets = [
      // Duplicado de Ana María en formato distinto con 1 mensaje cliente
      {
        id: 'tk-dup',
        status: 'closed',
        channel: 'whatsapp',
        isGroup: false,
        updatedAt: '2026-11-19T10:00:00.000Z',
        contact: { name: '3001112233', number: '573001112233' }
      },
      // Descartado por pocos mensajes del cliente (solo 1 mensaje cliente y 3 de bot/asesor)
      {
        id: 'tk-few',
        status: 'pending',
        channel: 'whatsapp',
        isGroup: false,
        updatedAt: '2026-11-19T09:00:00.000Z',
        contact: { name: 'Un Solo Mensaje', number: '3127778899' }
      },
      // Descartado por número inválido (fijo / @lid)
      {
        id: 'tk-bad',
        status: 'open',
        channel: 'whatsapp',
        isGroup: false,
        updatedAt: '2026-11-19T08:00:00.000Z',
        contact: { name: 'LID', number: '987654321@lid' }
      }
    ];

    const fakeFetch = async (url, opts = {}) => {
      seenAuthHeaders.push(opts.headers?.Authorization || '');
      const u = new URL(url);
      const p = u.pathname.replace(/^\/api\/v1/, '');

      const jsonRes = (status, data) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        json: async () => data
      });

      if (p === '/tickets') {
        if (!u.searchParams.get('cursorId')) {
          return jsonRes(200, { tickets: page1Tickets, hasMore: true });
        }
        return jsonRes(200, { tickets: page2Tickets, hasMore: false });
      }

      if (p === '/tickets/tk-1/messages') {
        return jsonRes(200, {
          messages: [
            { id: 'm-1a', fromMe: false, body: 'Hola, info por favor' },
            { id: 'm-1b', fromMe: true, userId: null, body: 'Bienvenido al bot' }
          ],
          hasMoreBefore: false
        });
      }

      if (p === '/tickets/tk-dup/messages') {
        return jsonRes(200, {
          messages: [{ id: 'm-d1', fromMe: false, body: 'Quiero la Hunk 160' }],
          hasMoreBefore: false
        });
      }

      if (p === '/tickets/tk-2/messages') {
        if (!u.searchParams.get('cursorId')) {
          return jsonRes(200, {
            messages: [
              { id: 'm-2b', fromMe: false, body: 'Mensaje 2', createdAt: '2026-11-20T13:55:00.000Z' },
              { id: 'm-2c', fromMe: true, userId: 'u-1', body: 'Ya te atiendo', createdAt: '2026-11-20T13:58:00.000Z' }
            ],
            hasMoreBefore: true
          });
        }
        return jsonRes(200, {
          messages: [
            { id: 'm-2a', fromMe: false, body: 'Mensaje 1 antiguo', createdAt: '2026-11-20T13:50:00.000Z' }
          ],
          hasMoreBefore: false
        });
      }

      if (p === '/tickets/tk-few/messages') {
        return jsonRes(200, {
          messages: [
            { id: 'm-f1', fromMe: false, body: 'Precio' },
            { id: 'm-f2', fromMe: true, userId: null, body: 'Bot 1' },
            { id: 'm-f3', fromMe: true, userId: 'u-1', body: 'Asesor 1' },
            { id: 'm-f4', fromMe: false, isNote: true, body: 'Nota interna' }
          ],
          hasMoreBefore: false
        });
      }

      return jsonRes(404, { error: 'Not found' });
    };

    const client = new WhaticketClient(appDb, { fetchImpl: fakeFetch });
    assert.equal(DEFAULT_MIN_CLIENT_MESSAGES, 2);

    // Con umbral por defecto (2)
    const result = await extractCleanContacts(client, { batchDelayMs: 0 });
    assert.ok(seenAuthHeaders.every((h) => h === 'Bearer env_fallback_token_777'));
    assert.equal(client.boardCache.tickets, null, 'No debe contaminar boardCache');
    assert.equal(client.messageCache.size, 0, 'No debe contaminar messageCache');

    assert.equal(result.contacts.length, 2);
    assert.equal(result.contacts[0].telefono, '3001112233');
    assert.equal(result.contacts[0].nombre, 'Ana María');
    assert.equal(result.contacts[0].mensajesCliente, 2);
    assert.equal(result.contacts[1].telefono, '3114445566');
    assert.equal(result.contacts[1].mensajesCliente, 2);

    assert.equal(result.summary.totalTickets, 7);
    assert.equal(result.summary.exported, 2);
    assert.equal(result.summary.discarded, 5);
    assert.equal(result.summary.exported + result.summary.discarded, result.summary.totalTickets);
    assert.deepEqual(result.summary.reasons, {
      group: 1,
      nonWhatsapp: 1,
      invalidNumber: 1,
      duplicate: 1,
      insufficientMessages: 1,
      fetchError: 0
    });

    // Con umbral más estricto (3 mensajes del cliente) -> ningún contacto alcanza 3
    const strictResult = await extractCleanContacts(client, {
      minClientMessages: 3,
      batchDelayMs: 0
    });
    assert.equal(strictResult.contacts.length, 0);
    assert.equal(strictResult.summary.discarded, 7);
    assert.equal(strictResult.summary.reasons.insufficientMessages, 3);
  } finally {
    if (prevEnvUrl === undefined) delete process.env.WHATICKET_API_URL;
    else process.env.WHATICKET_API_URL = prevEnvUrl;
    if (prevEnvToken === undefined) delete process.env.WHATICKET_API_TOKEN;
    else process.env.WHATICKET_API_TOKEN = prevEnvToken;
  }
});

test('Generación .csv y .xlsx: formato texto para teléfonos, escape XML/fórmulas e integridad ZIP/CRC-32', () => {
  const sampleContacts = [
    {
      nombre: '=CMD|" /C calc"!A0 & <María>\x00',
      telefono: '3001234567',
      mensajesCliente: 4,
      estado: 'Abierto',
      ultimaActividad: '2026-11-20 10:15:00'
    },
    {
      nombre: 'Carlos "Motos" Pérez',
      telefono: '3159876543',
      mensajesCliente: 2,
      estado: 'Cerrado',
      ultimaActividad: '2026-11-19 08:00:00'
    }
  ];

  // Verificar CSV
  const csvBuf = buildContactsCsv(sampleContacts);
  const csvText = csvBuf.toString('utf8');
  assert.ok(csvText.startsWith('\uFEFF'), 'Debe iniciar con UTF-8 BOM');
  const csvLines = csvText.slice(1).split('\r\n');
  assert.equal(csvLines[0], '"Nombre","Teléfono","Mensajes del cliente","Estado","Última actividad"');
  assert.ok(csvLines[1].includes('"\'=CMD|"" /C calc""!A0 & <María>\x00"'));
  assert.ok(csvLines[1].includes(',"=""3001234567""",4,'));
  assert.ok(csvLines[2].includes(',"=""3159876543""",2,'));

  // Verificar XLSX (ZIP + OOXML + estilos de texto @)
  const xlsxBuf = buildContactsXlsx(sampleContacts);
  const entries = parseAndVerifyZip(xlsxBuf);

  for (const requiredEntry of [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/worksheets/sheet1.xml'
  ]) {
    assert.ok(entries.has(requiredEntry), `Falta entrada OOXML: ${requiredEntry}`);
  }

  const stylesXml = entries.get('xl/styles.xml');
  assert.ok(stylesXml.includes('numFmtId="49"'), 'xl/styles.xml debe definir numFmtId="49" (@ texto)');

  const sheetXml = entries.get('xl/worksheets/sheet1.xml');
  assert.ok(sheetXml.includes('<c r="B2" t="inlineStr" s="2"><is><t>3001234567</t></is></c>'));
  assert.ok(sheetXml.includes('<c r="B3" t="inlineStr" s="2"><is><t>3159876543</t></is></c>'));
  assert.ok(sheetXml.includes('<c r="C2" t="n" s="0"><v>4</v></c>'));
  assert.ok(sheetXml.includes('&amp; &lt;María&gt;'), 'Debe escapar entidades XML');
  assert.ok(!sheetXml.includes('\x00'), 'Debe eliminar caracteres de control XML ilegales');
});

test('Integración HTTP POST /api/contacts/export: PIN, descarga .xlsx/.csv y cero tablas nuevas en BD', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-export-http-'));
  const dbPath = path.join(tmpDir, 'app.db');
  const secretPath = path.join(tmpDir, '.secret');

  const fakeFetch = async (url) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api\/v1/, '');
    const jsonRes = (status, data) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => data
    });

    if (p === '/tickets') {
      return jsonRes(200, {
        tickets: [
          {
            id: 'tk-10',
            status: 'open',
            channel: 'whatsapp',
            isGroup: false,
            updatedAt: '2026-11-20T11:00:00.000Z',
            contact: { name: 'Sofía Castro', number: '+57 302 123 4567' }
          },
          {
            id: 'tk-11',
            status: 'closed',
            channel: 'whatsapp',
            isGroup: false,
            updatedAt: '2026-11-20T10:00:00.000Z',
            contact: { name: 'Solo Uno', number: '3049998877' }
          }
        ],
        hasMore: false
      });
    }

    if (p === '/tickets/tk-10/messages') {
      return jsonRes(200, {
        messages: [
          { id: 'm1', fromMe: false, body: 'Hola' },
          { id: 'm2', fromMe: false, body: 'Me interesa la moto' }
        ],
        hasMoreBefore: false
      });
    }

    if (p === '/tickets/tk-11/messages') {
      return jsonRes(200, {
        messages: [{ id: 'm3', fromMe: false, body: 'Buenas' }],
        hasMoreBefore: false
      });
    }

    return jsonRes(404, { error: 'Not found' });
  };

  const appInstance = createServerApp({
    dbPath,
    secretPath,
    host: '127.0.0.1',
    fetchImpl: fakeFetch
  });

  try {
    // Configurar credenciales y PIN en la BD existente
    appInstance.appDb.saveConnection({
      baseUrl: 'https://api.whaticket.com/api/v1',
      token: 'wt_token_export_test'
    });
    appInstance.appDb.saveAccess({ pin: '1234', markConfigured: true, host: '127.0.0.1' });

    // 1. Sin cookie de sesión -> 401
    const unauthRes = await invokeMockHttp(appInstance.handleRequest, {
      method: 'POST',
      url: '/api/contacts/export',
      headers: { 'content-type': 'application/json' },
      body: { format: 'xlsx' }
    });
    assert.equal(unauthRes.status, 401);
    const unauthJson = JSON.parse(unauthRes.body.toString('utf8'));
    assert.equal(unauthJson.pinRequired, true);

    // 2. Iniciar sesión con PIN
    const loginRes = await invokeMockHttp(appInstance.handleRequest, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      body: { pin: '1234' }
    });
    assert.equal(loginRes.status, 200);
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0];

    // 3. Formato inválido -> 400
    const badFmtRes = await invokeMockHttp(appInstance.handleRequest, {
      method: 'POST',
      url: '/api/contacts/export',
      headers: { 'content-type': 'application/json', cookie },
      body: { format: 'pdf' }
    });
    assert.equal(badFmtRes.status, 400);

    // 4. Descarga .xlsx autenticado
    const xlsxRes = await invokeMockHttp(appInstance.handleRequest, {
      method: 'POST',
      url: '/api/contacts/export',
      headers: { 'content-type': 'application/json', cookie },
      body: { format: 'xlsx', minClientMessages: 2 }
    });
    assert.equal(xlsxRes.status, 200);
    assert.equal(
      xlsxRes.headers['content-type'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    assert.equal(xlsxRes.headers['x-export-exported-count'], '1');
    assert.equal(xlsxRes.headers['x-export-discarded-count'], '1');
    const entries = parseAndVerifyZip(xlsxRes.body);
    assert.ok(entries.get('xl/worksheets/sheet1.xml').includes('3021234567'));

    // 5. Descarga .csv autenticado
    const csvRes = await invokeMockHttp(appInstance.handleRequest, {
      method: 'POST',
      url: '/api/contacts/export',
      headers: { 'content-type': 'application/json', cookie },
      body: { format: 'csv', minClientMessages: 2 }
    });
    assert.equal(csvRes.status, 200);
    assert.equal(csvRes.headers['content-type'], 'text/csv; charset=utf-8');
    const csvStr = csvRes.body.toString('utf8');
    assert.ok(csvStr.includes('"=""3021234567"""'));

    // 6. Verificar que NO se crearon tablas nuevas en la base de datos
    if (appInstance.appDb.backend.type === 'sql') {
      const tables = appInstance.appDb.backend
        .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .map((r) => r.name)
        .sort();
      assert.deepEqual(tables, [
        'advisors',
        'assignment_events',
        'assignment_log',
        'departments',
        'settings',
        'ticket_owner'
      ]);
    } else {
      const pureJson = JSON.parse(fs.readFileSync(`${dbPath}`, 'utf8'));
      assert.deepEqual(Object.keys(pureJson).sort(), [
        'advisors',
        'assignment_events',
        'assignment_log',
        'departments',
        'seq',
        'settings',
        'ticket_owner'
      ]);
    }
  } finally {
    appInstance.stopPolling();
  }
});
