'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createServerApp } = require('../server/app');

function createMockWhaticketFetch() {
  const calls = [];
  const ticketsState = [
    {
      id: 'tk-101',
      status: 'pending',
      channel: 'whatsapp',
      unreadMessages: 2,
      queueId: null, // Ticket sin departamento asignado
      userId: null,
      lastMessage: 'Hola, precio de la Hero Hunk 160R',
      lastReceivedMessageAt: new Date(Date.now() - 18 * 60000).toISOString(),
      updatedAt: new Date(Date.now() - 18 * 60000).toISOString(),
      createdAt: new Date(Date.now() - 20 * 60000).toISOString(),
      contact: { id: 'c-1', name: 'Carlos Pérez', number: '573001112233' }
    },
    {
      id: 'tk-102',
      status: 'open',
      channel: 'instagram',
      unreadMessages: 0,
      queueId: 'q-digital',
      userId: 'u-claudia',
      lastMessage: '¿Aceptan financiación con Credi Ruedas?',
      lastReceivedMessageAt: new Date(Date.now() - 8 * 60000).toISOString(),
      updatedAt: new Date(Date.now() - 8 * 60000).toISOString(),
      createdAt: new Date(Date.now() - 30 * 60000).toISOString(),
      contact: { id: 'c-2', name: 'Laura Gómez', number: '573014445566' }
    }
  ];

  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api\/v1/, '');
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path: p, body });

    const jsonRes = (status, data) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => data
    });

    if (p === '/me' && method === 'GET') {
      return jsonRes(200, {
        name: 'Token Supervisor',
        company: { id: 'comp-1', name: 'Motos Alfa Cartagena' },
        permissions: ['tickets:view', 'tickets:viewAll', 'tickets:viewPending', 'tickets:acceptPending', 'tickets:transfer', 'queues:view'],
        user: { id: 'u-sup', name: 'Adner Supervisor' }
      });
    }

    if (p === '/queues' && method === 'GET') {
      return jsonRes(200, {
        queues: [
          { id: 'q-digital', name: 'Digital', color: '#3B5BDB' },
          { id: 'q-sala', name: 'Sala', color: '#16A34A' }
        ]
      });
    }

    if (p === '/queues/q-digital' && method === 'GET') {
      return jsonRes(200, {
        id: 'q-digital',
        name: 'Digital',
        users: [
          { id: 'u-claudia', name: 'Claudia Díaz' },
          { id: 'u-andrea', name: 'Andrea' }
        ]
      });
    }

    if (p === '/queues/q-sala' && method === 'GET') {
      return jsonRes(200, {
        id: 'q-sala',
        name: 'Sala',
        users: [
          { id: 'u-javier', name: 'Javier' }
        ]
      });
    }

    if (p === '/tickets' && method === 'GET') {
      return jsonRes(200, { tickets: ticketsState, hasMore: false });
    }

    if (p === '/tickets/tk-102/messages' && method === 'GET') {
      return jsonRes(200, {
        messages: [
          {
            id: 'm-1',
            body: '¿Aceptan financiación con Credi Ruedas?',
            fromMe: false,
            userId: null,
            isNote: false,
            isDeleted: false,
            createdAt: new Date(Date.now() - 8 * 60000).toISOString()
          }
        ],
        hasMoreBefore: false,
        hasMoreAfter: false
      });
    }

    if (p === '/tickets/tk-101/assign' && method === 'POST') {
      ticketsState[0].status = 'open';
      ticketsState[0].userId = body.userId;
      return jsonRes(200, ticketsState[0]);
    }

    if (p === '/tickets/tk-102/transfer' && method === 'POST') {
      ticketsState[1].userId = body.userId;
      return jsonRes(200, ticketsState[1]);
    }

    return jsonRes(404, { error: 'Not found' });
  };

  return { fetchImpl, calls };
}

test('Flujo integral E2E: Asistente 4 pasos, PIN en red local, tablero, reparto equitativo, liberar y log', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-e2e-'));
  const dbPath = path.join(tmpDir, 'app.db');
  const secretPath = path.join(tmpDir, '.secret');
  const { fetchImpl, calls } = createMockWhaticketFetch();

  const appInstance = createServerApp({
    dbPath,
    secretPath,
    host: '0.0.0.0',
    fetchImpl
  });

  const server = appInstance.createHttpServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Paso 1: Probar conexión y guardar credenciales
    let res = await fetch(`${baseUrl}/api/setup/test-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://api.whaticket.com/api/v1',
        token: 'wt_real_token_9988'
      })
    });
    assert.equal(res.status, 200);
    const testData = await res.json();
    assert.equal(testData.ok, true);
    assert.equal(testData.departmentsCount, 2);
    assert.equal(testData.usersCount, 4); // Claudia, Andrea, Javier, Adner Supervisor

    res = await fetch(`${baseUrl}/api/setup/connection`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://api.whaticket.com/api/v1',
        token: 'wt_real_token_9988'
      })
    });
    assert.equal(res.status, 200);
    const connCfg = await res.json();
    assert.equal(connCfg.token.configurado, true);
    assert.equal(connCfg.token.ultimos4, '••••9988');

    // 2. Paso 2: Importar y guardar asesores + supervisor
    res = await fetch(`${baseUrl}/api/setup/import`, { method: 'POST' });
    assert.equal(res.status, 200);
    const imp = await res.json();
    assert.equal(imp.advisors.length, 4);

    res = await fetch(`${baseUrl}/api/setup/advisors`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        advisors: imp.advisors,
        supervisorUserId: 'u-sup'
      })
    });
    assert.equal(res.status, 200);

    // 3. Paso 3: Guardar reglas (desactivar dryRun para probar escrituras reales)
    res = await fetch(`${baseUrl}/api/setup/rules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        greenMaxMin: 5,
        yellowMaxMin: 15,
        unansweredMin: 5,
        protectionMin: 3,
        pollingSec: 20,
        defaultMode: 'least_load',
        dryRun: false
      })
    });
    assert.equal(res.status, 200);

    // 4. Paso 4: Exige PIN cuando HOST=0.0.0.0
    res = await fetch(`${baseUrl}/api/setup/access`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markConfigured: true })
    });
    assert.equal(res.status, 400);

    res = await fetch(`${baseUrl}/api/setup/access`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234', markConfigured: true })
    });
    assert.equal(res.status, 200);
    const setCookieHeader = res.headers.get('set-cookie');
    assert.ok(setCookieHeader && setCookieHeader.includes('panel_session='));
    const cookieVal = setCookieHeader.split(';')[0];

    // Verificar que sin cookie devuelve 401
    res = await fetch(`${baseUrl}/api/board`);
    assert.equal(res.status, 401);

    // 5. Leer tablero autenticado
    res = await fetch(`${baseUrl}/api/board?refresh=true`, {
      headers: { Cookie: cookieVal }
    });
    assert.equal(res.status, 200);
    const board = await res.json();
    assert.equal(board.kpis.enEspera, 1);
    assert.equal(board.waitingTickets[0].hasNoDepartment, true);
    assert.equal(board.kpis.criticosRojo, 1);

    // 6. Reparto equitativo con preview y ejecución
    res = await fetch(`${baseUrl}/api/distribute?preview=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieVal },
      body: JSON.stringify({ mode: 'least_load', preview: true })
    });
    assert.equal(res.status, 200);
    const preview = await res.json();
    assert.equal(preview.assignments.length, 1);

    res = await fetch(`${baseUrl}/api/distribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieVal },
      body: JSON.stringify({ mode: 'least_load' })
    });
    assert.equal(res.status, 200);
    const distRes = await res.json();
    assert.equal(distRes.ok, true);
    assert.ok(calls.some((c) => c.path === '/tickets/tk-101/assign' && c.method === 'POST'));

    // 7. Consultar historial, vista general e informe mensual
    res = await fetch(`${baseUrl}/api/log`, { headers: { Cookie: cookieVal } });
    assert.equal(res.status, 200);
    const logData = await res.json();
    assert.equal(logData.logs.length, 1);
    assert.equal(logData.logs[0].accion, 'reparto');
    assert.equal(logData.logs[0].resultado, 'ok');

    res = await fetch(`${baseUrl}/api/overview?granularity=day`, { headers: { Cookie: cookieVal } });
    assert.equal(res.status, 200);
    const ovData = await res.json();
    assert.ok(ovData.grandTotal >= 1);

    res = await fetch(`${baseUrl}/api/reports/monthly`, { headers: { Cookie: cookieVal } });
    assert.equal(res.status, 200);
    const repData = await res.json();
    assert.ok(repData.grandTotal >= 1);
  } finally {
    appInstance.stopPolling();
    await new Promise((resolve) => server.close(resolve));
  }
});
