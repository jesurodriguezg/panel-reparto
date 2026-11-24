'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  encryptToken,
  decryptToken,
  maskToken,
  hashPin,
  verifyPin
} = require('../server/crypto');

const {
  checkTicketProtection,
  planDistribution,
  planAdvisorRelease
} = require('../server/distributionEngine');

const { AppDatabase } = require('../server/db');
const { WhaticketClient } = require('../server/whaticketClient');

test('Cifrado AES-256-GCM y enmascarado del token (nunca expone el token completo)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-crypto-'));
  const secretPath = path.join(tmpDir, '.secret');

  const rawToken = 'wt_live_9876543210abcdef_a1b2';
  const encrypted = encryptToken(rawToken, secretPath);

  assert.notEqual(encrypted, rawToken);
  assert.equal(encrypted.split(':').length, 3, 'Formato iv:authTag:cipher');

  const decrypted = decryptToken(encrypted, secretPath);
  assert.equal(decrypted, rawToken);

  const masked = maskToken(rawToken);
  assert.deepEqual(masked, {
    configurado: true,
    ultimos4: '••••a1b2'
  });

  const emptyMask = maskToken('');
  assert.deepEqual(emptyMask, {
    configurado: false,
    ultimos4: null
  });
});

test('Hash y verificación de PIN con scrypt', () => {
  const pin = '4829';
  const hashed = hashPin(pin);
  assert.ok(hashed.includes(':'));
  assert.equal(verifyPin('4829', hashed), true);
  assert.equal(verifyPin('0000', hashed), false);
});

test('Reparto en modo menor carga (least_load) respeta disponibilidad y tope máximo', () => {
  const advisors = [
    { id: 1, whaticket_user_id: 'u-1', nombre_visible: 'Claudia Díaz', tipo: 'Digital', disponible: true, currentLoad: 3, tope_maximo: 5 },
    { id: 2, whaticket_user_id: 'u-2', nombre_visible: 'Andrea', tipo: 'Digital', disponible: true, currentLoad: 1, tope_maximo: 5 },
    { id: 3, whaticket_user_id: 'u-3', nombre_visible: 'Emily', tipo: 'Sala', disponible: false, currentLoad: 0, tope_maximo: 5 }
  ];

  const tickets = [
    { id: 't-1', status: 'pending', contact: { name: 'Cliente 1' } },
    { id: 't-2', status: 'pending', contact: { name: 'Cliente 2' } },
    { id: 't-3', status: 'pending', contact: { name: 'Cliente 3' } },
    { id: 't-4', status: 'pending', contact: { name: 'Cliente 4' } }
  ];

  const plan = planDistribution({
    tickets,
    advisors,
    mode: 'least_load',
    protectionMinutes: 3
  });

  // Andrea empieza con carga 1 y Claudia con 3 -> Andrea debe recibir t-1 y t-2 (llega a 3), luego se reparten t-3 y t-4 (1 cada una, ambas terminan en 4). Emily no recibe porque no está disponible.
  assert.equal(plan.assignments.length, 4);
  const byAdvisor = Object.fromEntries(plan.summaryByAdvisor.map((s) => [s.nombre, s.cantidad]));
  assert.equal(byAdvisor['Andrea'], 3);
  assert.equal(byAdvisor['Claudia Díaz'], 1);
  assert.equal(byAdvisor['Emily'], undefined);
});

test('Reparto en modo turnos (round_robin) y respeto estricto de tope_maximo', () => {
  const advisors = [
    { id: 1, whaticket_user_id: 'u-1', nombre_visible: 'Leira', tipo: 'Digital', disponible: true, currentLoad: 4, tope_maximo: 5 },
    { id: 2, whaticket_user_id: 'u-2', nombre_visible: 'Yeimi', tipo: 'Digital', disponible: true, currentLoad: 3, tope_maximo: 5 }
  ];

  const tickets = [
    { id: 't-10', status: 'pending', contact: { name: 'C1' } },
    { id: 't-11', status: 'pending', contact: { name: 'C2' } },
    { id: 't-12', status: 'pending', contact: { name: 'C3' } },
    { id: 't-13', status: 'pending', contact: { name: 'C4' } }
  ];

  const plan = planDistribution({
    tickets,
    advisors,
    mode: 'round_robin',
    roundRobinCursor: 0
  });

  // Leira solo tiene cupo para 1 (4 -> 5) y Yeimi para 2 (3 -> 5). El 4to ticket debe quedar en skippedNoCapacity.
  assert.equal(plan.assignments.length, 3);
  assert.equal(plan.skippedNoCapacity.length, 1);
  assert.equal(plan.skippedNoCapacity[0].ticketId, 't-13');
});

test('Regla de protección: no mueve tickets con actividad en los últimos N minutos salvo force=true', () => {
  const nowMs = Date.parse('2026-11-17T15:00:00.000Z');
  const recentTicket = {
    id: 't-prot',
    status: 'open',
    userId: 'u-old',
    updatedAt: '2026-11-17T14:58:30.000Z', // hace 1.5 min (< 3 min)
    contact: { name: 'Cliente Activo' }
  };

  const protCheck = checkTicketProtection(recentTicket, 3, nowMs);
  assert.equal(protCheck.protected, true);

  const advisors = [
    { id: 1, whaticket_user_id: 'u-new', nombre_visible: 'Yina', tipo: 'Digital', disponible: true, currentLoad: 0, tope_maximo: 10 }
  ];

  const planNormal = planDistribution({
    tickets: [recentTicket],
    advisors,
    protectionMinutes: 3,
    force: false,
    nowMs
  });
  assert.equal(planNormal.assignments.length, 0);
  assert.equal(planNormal.skippedProtected.length, 1);

  const planForced = planDistribution({
    tickets: [recentTicket],
    advisors,
    protectionMinutes: 3,
    force: true,
    nowMs
  });
  assert.equal(planForced.assignments.length, 1);
  assert.equal(planForced.assignments[0].toUserId, 'u-new');
});

test('Liberar asesor ("Quitarle todo"): redistribuye todos sus tickets entre los demás disponibles', () => {
  const nowMs = Date.parse('2026-11-17T15:00:00.000Z');
  const allAdvisors = [
    { id: 1, whaticket_user_id: 'u-saliente', nombre_visible: 'Javier', tipo: 'Sala', disponible: true, currentLoad: 2, tope_maximo: 10 },
    { id: 2, whaticket_user_id: 'u-dest-1', nombre_visible: 'David', tipo: 'Sala', disponible: true, currentLoad: 1, tope_maximo: 10 },
    { id: 3, whaticket_user_id: 'u-dest-2', nombre_visible: 'Karen', tipo: 'Digital', disponible: true, currentLoad: 1, tope_maximo: 10 }
  ];

  const allTickets = [
    { id: 'tk-1', status: 'open', userId: 'u-saliente', updatedAt: '2026-11-17T14:40:00.000Z', contact: { name: 'Moto 1' } },
    { id: 'tk-2', status: 'open', userId: 'u-saliente', updatedAt: '2026-11-17T14:45:00.000Z', contact: { name: 'Moto 2' } },
    { id: 'tk-3', status: 'open', userId: 'u-dest-1', updatedAt: '2026-11-17T14:40:00.000Z', contact: { name: 'Moto 3' } }
  ];

  const releasePlan = planAdvisorRelease({
    advisorToRelease: allAdvisors[0],
    allTickets,
    allAdvisors,
    mode: 'least_load',
    protectionMinutes: 3,
    nowMs
  });

  assert.equal(releasePlan.assignments.length, 2);
  // Ningún ticket debe volver a u-saliente
  assert.ok(releasePlan.assignments.every((a) => a.toUserId !== 'u-saliente'));
});

test('Cliente Whaticket usa /assign para pending, /transfer para open y respeta DRY_RUN', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-db-'));
  const dbPath = path.join(tmpDir, 'app.db');
  const secretPath = path.join(tmpDir, '.secret');

  const appDb = new AppDatabase(dbPath, secretPath);
  appDb.saveConnection({ baseUrl: 'https://api.whaticket.com/api/v1', token: 'token_test_1234' });

  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ id: 't-1', status: 'open' })
    };
  };

  const client = new WhaticketClient(appDb, { fetchImpl: fakeFetch });

  // 1. Por defecto dry_run = 1: no debe llamar al endpoint HTTP
  const simRes = await client.assignTicket({ id: 't-1', status: 'pending' }, { userId: 'u-10' });
  assert.equal(simRes.simulated, true);
  assert.equal(calls.length, 0);

  // 2. Desactivar dry_run -> debe llamar POST /tickets/t-1/assign para pending y POST /tickets/t-2/transfer para open
  appDb.saveRules({ dryRun: false });
  await client.assignTicket({ id: 't-1', status: 'pending' }, { userId: 'u-10' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/tickets/t-1/assign'));
  assert.deepEqual(calls[0].body, { userId: 'u-10' });

  await client.assignTicket({ id: 't-2', status: 'open' }, { userId: 'u-20', queueId: 'q-1' });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith('/tickets/t-2/transfer'));
  assert.deepEqual(calls[1].body, { userId: 'u-20', queueId: 'q-1' });
});
