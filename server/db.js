'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  encryptToken,
  decryptToken,
  maskToken,
  hashPin,
  verifyPin
} = require('./crypto');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'app.db');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_base_url TEXT NOT NULL DEFAULT 'https://api.whaticket.com/api/v1',
  api_token_enc TEXT,
  api_token_last4 TEXT,
  supervisor_user_id TEXT,
  pin_hash TEXT,
  dry_run INTEGER NOT NULL DEFAULT 1,
  green_max_min INTEGER NOT NULL DEFAULT 5,
  yellow_max_min INTEGER NOT NULL DEFAULT 15,
  unanswered_min INTEGER NOT NULL DEFAULT 5,
  protection_min INTEGER NOT NULL DEFAULT 3,
  polling_sec INTEGER NOT NULL DEFAULT 20,
  default_mode TEXT NOT NULL DEFAULT 'least_load',
  round_robin_cursor INTEGER NOT NULL DEFAULT 0,
  configured_at TEXT
);

INSERT OR IGNORE INTO settings (
  id, api_base_url, dry_run, green_max_min, yellow_max_min,
  unanswered_min, protection_min, polling_sec, default_mode, round_robin_cursor
) VALUES (
  1, 'https://api.whaticket.com/api/v1', 1, 5, 15, 5, 3, 20, 'least_load', 0
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6B7280',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS advisors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whaticket_user_id TEXT NOT NULL UNIQUE,
  nombre_visible TEXT NOT NULL,
  incluido INTEGER NOT NULL DEFAULT 1,
  tipo TEXT NOT NULL DEFAULT 'Digital' CHECK (tipo IN ('Digital', 'Sala')),
  disponible INTEGER NOT NULL DEFAULT 1,
  tope_maximo INTEGER NOT NULL DEFAULT 15
);

CREATE TABLE IF NOT EXISTS assignment_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha_hora TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  cliente_nombre TEXT,
  cliente_numero TEXT,
  asesor_origen TEXT,
  asesor_destino TEXT,
  asesor_destino_user_id TEXT,
  accion TEXT NOT NULL CHECK (accion IN ('manual', 'reparto', 'liberar', 'auto')),
  resultado TEXT NOT NULL CHECK (resultado IN ('ok', 'error', 'simulacion')),
  mensaje_error TEXT
);

-- Eventos de asignación (fuente de las estadísticas, vista general e informes)
-- origen: 'manual' | 'reparto' | 'liberar' | 'auto' (desde el panel) o 'whaticket' (detectado en Whaticket)
CREATE TABLE IF NOT EXISTS assignment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha_hora TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cliente_nombre TEXT,
  cliente_numero TEXT,
  origen TEXT NOT NULL,
  simulado INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_assignment_events_fecha ON assignment_events (fecha_hora);

-- Último asesor conocido de cada ticket (para detectar reasignaciones hechas en Whaticket)
CREATE TABLE IF NOT EXISTS ticket_owner (
  ticket_id TEXT PRIMARY KEY,
  user_id TEXT,
  updated_at TEXT
);
`;

const ASSIGNMENT_LOG_COLUMNS =
  'id, fecha_hora, ticket_id, cliente_nombre, cliente_numero, asesor_origen, asesor_destino, asesor_destino_user_id, accion, resultado, mensaje_error';

/**
 * Migraciones idempotentes para bases de datos creadas con versiones anteriores.
 */
function migrateSqlDatabase(db) {
  const addColumn = (table, column, definition) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };

  addColumn('advisors', 'peso', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('advisors', 'foto_url', 'TEXT');
  addColumn('settings', 'auto_assign_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('settings', 'auto_assign_min_wait', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('settings', 'auto_assign_type', "TEXT NOT NULL DEFAULT 'all'");
  addColumn('settings', 'auto_only_online', 'INTEGER NOT NULL DEFAULT 1');

  // Ampliar el CHECK de assignment_log.accion para admitir 'auto'
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assignment_log'")
    .get();
  if (row && !String(row.sql).includes("'auto'")) {
    db.exec(`
      BEGIN;
      ALTER TABLE assignment_log RENAME TO assignment_log_old;
      CREATE TABLE assignment_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha_hora TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        cliente_nombre TEXT,
        cliente_numero TEXT,
        asesor_origen TEXT,
        asesor_destino TEXT,
        asesor_destino_user_id TEXT,
        accion TEXT NOT NULL CHECK (accion IN ('manual', 'reparto', 'liberar', 'auto')),
        resultado TEXT NOT NULL CHECK (resultado IN ('ok', 'error', 'simulacion')),
        mensaje_error TEXT
      );
      INSERT INTO assignment_log (${ASSIGNMENT_LOG_COLUMNS})
        SELECT ${ASSIGNMENT_LOG_COLUMNS} FROM assignment_log_old;
      DROP TABLE assignment_log_old;
      COMMIT;
    `);
  }
}

/**
 * Motor nativo de respaldo en puro Node.js (sin dependencias externas ni compiladores C++)
 * por si en un equipo Windows falla la instalación de better-sqlite3.
 */
function createPureNodeStore(dbPath, { memoryOnly = false } = {}) {
  const defaultState = {
    settings: {
      id: 1,
      api_base_url: 'https://api.whaticket.com/api/v1',
      api_token_enc: null,
      api_token_last4: null,
      supervisor_user_id: null,
      pin_hash: null,
      dry_run: 1,
      green_max_min: 5,
      yellow_max_min: 15,
      unanswered_min: 5,
      protection_min: 3,
      polling_sec: 20,
      default_mode: 'least_load',
      round_robin_cursor: 0,
      configured_at: null,
      auto_assign_enabled: 0,
      auto_assign_min_wait: 0,
      auto_assign_type: 'all',
      auto_only_online: 1
    },
    departments: [],
    advisors: [],
    assignment_log: [],
    assignment_events: [],
    ticket_owner: {},
    seq: { advisors: 0, assignment_log: 0, assignment_events: 0 }
  };

  let state = JSON.parse(JSON.stringify(defaultState));
  let dirty = false;

  const normalizeState = (parsed) => {
    const p = parsed && typeof parsed === 'object' ? parsed : {};
    const advisors = Array.isArray(p.advisors) ? p.advisors : [];
    const logs = Array.isArray(p.assignment_log) ? p.assignment_log : [];
    const events = Array.isArray(p.assignment_events) ? p.assignment_events : [];
    const maxId = (arr) => arr.reduce((m, r) => Math.max(m, Number(r?.id) || 0), 0);
    return {
      settings: { ...defaultState.settings, ...(p.settings || {}) },
      departments: Array.isArray(p.departments) ? p.departments : [],
      advisors,
      assignment_log: logs,
      assignment_events: events,
      ticket_owner: p.ticket_owner && typeof p.ticket_owner === 'object' ? p.ticket_owner : {},
      seq: {
        advisors: Math.max(Number(p.seq?.advisors) || 0, maxId(advisors)),
        assignment_log: Math.max(Number(p.seq?.assignment_log) || 0, maxId(logs)),
        assignment_events: Math.max(Number(p.seq?.assignment_events) || 0, maxId(events))
      }
    };
  };

  const load = () => {
    if (memoryOnly) return;
    if (!fs.existsSync(dbPath)) {
      save(false);
      return;
    }
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      if (raw && raw.trim().startsWith('{')) {
        state = normalizeState(JSON.parse(raw));
      } else {
        save(false);
      }
    } catch {
      save(false);
    }
  };

  const save = (markDirty = true) => {
    if (markDirty) dirty = true;
    if (memoryOnly) return;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify(state, null, 2), 'utf8');
  };

  load();

  return {
    engine: 'node-native-store',
    isDirty() {
      return dirty;
    },
    resetDirty() {
      dirty = false;
    },
    getStateSnapshot() {
      load();
      return JSON.parse(JSON.stringify(state));
    },
    replaceStateSnapshot(incoming) {
      state = normalizeState(incoming);
      dirty = false;
      if (!memoryOnly) {
        save(false);
      }
    },
    getSettings() {
      load();
      return { ...state.settings };
    },
    updateSettings(patch) {
      load();
      Object.assign(state.settings, patch);
      save();
    },
    upsertDepartment(dept) {
      load();
      const idx = state.departments.findIndex((d) => String(d.id) === String(dept.id));
      if (idx >= 0) {
        state.departments[idx] = { ...state.departments[idx], ...dept };
      } else {
        state.departments.push({ ...dept });
      }
      save();
    },
    listDepartments() {
      load();
      return [...state.departments].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''))
      );
    },
    findAdvisorByUserId(uid) {
      load();
      return state.advisors.find((a) => String(a.whaticket_user_id) === String(uid)) || null;
    },
    findAdvisorById(id) {
      load();
      return state.advisors.find((a) => Number(a.id) === Number(id)) || null;
    },
    insertAdvisor(adv) {
      load();
      state.seq.advisors += 1;
      const record = { id: state.seq.advisors, ...adv };
      state.advisors.push(record);
      save();
      return record.id;
    },
    updateAdvisorByUserId(uid, patch) {
      load();
      const target = state.advisors.find((a) => String(a.whaticket_user_id) === String(uid));
      if (target) {
        Object.assign(target, patch);
        save();
      }
    },
    updateAdvisorById(id, patch) {
      load();
      const target = state.advisors.find((a) => Number(a.id) === Number(id));
      if (target) {
        Object.assign(target, patch);
        save();
      }
    },
    listAdvisors() {
      load();
      return [...state.advisors].sort((a, b) =>
        String(a.nombre_visible || '').localeCompare(String(b.nombre_visible || ''))
      );
    },
    insertLog(entry) {
      load();
      state.seq.assignment_log += 1;
      const record = { id: state.seq.assignment_log, ...entry };
      state.assignment_log.push(record);
      save();
      return record.id;
    },
    getLogById(id) {
      load();
      return state.assignment_log.find((l) => Number(l.id) === Number(id)) || null;
    },
    listLogs({ dateFrom, dateTo, advisor, resultado, limit = 200 } = {}) {
      load();
      let rows = [...state.assignment_log];
      if (dateFrom) {
        const minIso = `${dateFrom}T00:00:00.000Z`;
        rows = rows.filter((r) => r.fecha_hora >= minIso);
      }
      if (dateTo) {
        const maxIso = `${dateTo}T23:59:59.999Z`;
        rows = rows.filter((r) => r.fecha_hora <= maxIso);
      }
      if (advisor) {
        const needle = String(advisor).toLowerCase();
        rows = rows.filter(
          (r) =>
            String(r.asesor_origen || '').toLowerCase().includes(needle) ||
            String(r.asesor_destino || '').toLowerCase().includes(needle)
        );
      }
      if (resultado) {
        rows = rows.filter((r) => r.resultado === resultado);
      }
      rows.sort((a, b) => Number(b.id) - Number(a.id));
      return rows.slice(0, limit);
    },
    insertEvents(events, ownerUpdates) {
      load();
      for (const ev of events) {
        state.seq.assignment_events += 1;
        state.assignment_events.push({ id: state.seq.assignment_events, ...ev });
      }
      for (const [ticketId, owner] of Object.entries(ownerUpdates || {})) {
        state.ticket_owner[ticketId] = owner;
      }
      save();
    },
    getTicketOwners() {
      load();
      return { ...state.ticket_owner };
    },
    listEvents({ fromIso, toIso, userId, includeSimulated }) {
      load();
      return state.assignment_events
        .filter(
          (e) =>
            (!fromIso || e.fecha_hora >= fromIso) &&
            (!toIso || e.fecha_hora < toIso) &&
            (!userId || String(e.user_id) === String(userId)) &&
            (includeSimulated || !e.simulado)
        )
        .sort((a, b) => String(a.fecha_hora).localeCompare(String(b.fecha_hora)));
    }
  };
}

function createDatabaseBackend(dbPath = DEFAULT_DB_PATH, options = {}) {
  if (options.forcePure) {
    return {
      type: 'pure',
      store: createPureNodeStore(dbPath, { memoryOnly: Boolean(options.memoryOnly) })
    };
  }

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 1. Intentar better-sqlite3 (si está instalado y compilado)
  try {
    const BetterSqlite3 = require('better-sqlite3');
    const db = new BetterSqlite3(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA_SQL);
    try {
      migrateSqlDatabase(db);
    } catch (err) {
      console.error('[DB] Error al migrar la base de datos:', err.message);
    }
    return {
      type: 'sql',
      get: (sql, p = []) => db.prepare(sql).get(...p) || null,
      all: (sql, p = []) => db.prepare(sql).all(...p),
      run: (sql, p = []) => {
        const info = db.prepare(sql).run(...p);
        return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
      }
    };
  } catch {}

  // 2. Intentar node:sqlite (incorporado en Node.js 22.5+)
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA_SQL);
    try {
      migrateSqlDatabase(db);
    } catch (err) {
      console.error('[DB] Error al migrar la base de datos:', err.message);
    }
    return {
      type: 'sql',
      get: (sql, p = []) => db.prepare(sql).get(...p) || null,
      all: (sql, p = []) => db.prepare(sql).all(...p),
      run: (sql, p = []) => {
        const info = db.prepare(sql).run(...p);
        return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
      }
    };
  } catch {}

  // 3. Respaldo universal 100% puro Node.js (nunca falla en Windows sin herramientas C++)
  // Si app.db ya es un archivo SQLite, nunca lo sobrescribimos: usamos app.db.json
  let pureDbPath = dbPath;
  try {
    if (fs.existsSync(dbPath)) {
      const head = fs.readFileSync(dbPath).subarray(0, 15).toString('utf8');
      if (head.startsWith('SQLite format')) pureDbPath = `${dbPath}.json`;
    }
  } catch {}
  return {
    type: 'pure',
    store: createPureNodeStore(pureDbPath)
  };
}

class AppDatabase {
  constructor(dbPath = DEFAULT_DB_PATH, secretPath = undefined, options = {}) {
    this.dbPath = dbPath;
    this.secretPath = secretPath;
    this.backend = createDatabaseBackend(dbPath, options);
    this.cachedSettings = null;
    this.reload();
  }

  isDirty() {
    return this.backend.type === 'pure' ? this.backend.store.isDirty() : false;
  }

  resetDirty() {
    if (this.backend.type === 'pure') {
      this.backend.store.resetDirty();
    }
  }

  importStateSnapshot(snapshot) {
    if (this.backend.type !== 'pure') {
      throw new Error('importStateSnapshot solo aplica para el motor en memoria/JSON.');
    }
    this.backend.store.replaceStateSnapshot(snapshot);
    this.reload();
  }

  exportStateSnapshot() {
    if (this.backend.type === 'pure') {
      return this.backend.store.getStateSnapshot();
    }
    const settings = this.backend.get('SELECT * FROM settings WHERE id = 1') || {};
    const departments = this.backend.all('SELECT * FROM departments ORDER BY name ASC');
    const advisors = this.backend.all('SELECT * FROM advisors ORDER BY id ASC');
    const assignment_log = this.backend.all('SELECT * FROM assignment_log ORDER BY id ASC');
    const assignment_events = this.backend.all('SELECT * FROM assignment_events ORDER BY id ASC');
    const ticketOwnerRows = this.backend.all('SELECT * FROM ticket_owner');
    const ticket_owner = {};
    for (const r of ticketOwnerRows) {
      if (r && r.ticket_id) {
        ticket_owner[String(r.ticket_id)] = {
          user_id: r.user_id || null,
          updated_at: r.updated_at || null
        };
      }
    }
    const maxId = (arr) => arr.reduce((m, r) => Math.max(m, Number(r?.id) || 0), 0);
    return {
      settings,
      departments,
      advisors,
      assignment_log,
      assignment_events,
      ticket_owner,
      seq: {
        advisors: maxId(advisors),
        assignment_log: maxId(assignment_log),
        assignment_events: maxId(assignment_events)
      }
    };
  }

  reload() {
    if (this.backend.type === 'sql') {
      this.cachedSettings = this.backend.get('SELECT * FROM settings WHERE id = 1');
    } else {
      this.cachedSettings = this.backend.store.getSettings();
    }
    return this.cachedSettings;
  }

  getRawSettings() {
    if (!this.cachedSettings) {
      this.reload();
    }
    return this.cachedSettings;
  }

  getPublicConfig() {
    const s = this.getRawSettings();
    const tokenMask = maskToken(s.api_token_last4);
    const advisors = this.listAdvisors();
    const departments = this.listDepartments();

    return {
      apiBaseUrl: s.api_base_url,
      token: tokenMask,
      supervisorUserId: s.supervisor_user_id || '',
      hasPin: Boolean(s.pin_hash),
      dryRun: Boolean(s.dry_run),
      thresholds: {
        greenMaxMin: Number(s.green_max_min),
        yellowMaxMin: Number(s.yellow_max_min)
      },
      unansweredMin: Number(s.unanswered_min),
      protectionMin: Number(s.protection_min),
      pollingSec: Number(s.polling_sec),
      defaultMode: s.default_mode || 'least_load',
      autoAssign: {
        enabled: Boolean(s.auto_assign_enabled),
        minWaitMin: Number(s.auto_assign_min_wait || 0),
        advisorType: s.auto_assign_type || 'all',
        onlyOnline: s.auto_only_online === undefined ? true : Boolean(s.auto_only_online)
      },
      configuredAt: s.configured_at || null,
      advisors,
      departments
    };
  }

  getSetupStatus(host = '127.0.0.1') {
    const s = this.getRawSettings();
    const advisors = this.listAdvisors();
    const step1Done = Boolean(s.api_base_url && s.api_token_enc);
    const step2Done = advisors.some((a) => a.incluido);
    const step3Done = Boolean(s.green_max_min && s.yellow_max_min && s.unanswered_min);
    const isNetworkHost = host === '0.0.0.0' || host === '::';
    const step4Done = Boolean(s.pin_hash);
    // La app solo se considera configurada cuando además existe un PIN de acceso
    const isConfigured = Boolean(s.configured_at && step1Done && s.pin_hash);

    return {
      configured: isConfigured,
      configuredAt: s.configured_at || null,
      requirePinForNetwork: isNetworkHost,
      hasPin: Boolean(s.pin_hash),
      steps: {
        step1_connection: step1Done,
        step2_advisors: step2Done,
        step3_rules: step3Done,
        step4_access: step4Done
      }
    };
  }

  getDecryptedCredentials() {
    const s = this.getRawSettings();
    let token = null;
    if (s.api_token_enc) {
      try {
        token = decryptToken(s.api_token_enc, this.secretPath);
      } catch {
        token = null;
      }
    }
    return {
      baseUrl: s.api_base_url || 'https://api.whaticket.com/api/v1',
      token
    };
  }

  saveConnection({ baseUrl, token }) {
    const cleanUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) {
      throw new Error('La URL base debe comenzar con http:// o https://');
    }

    const current = this.getRawSettings();
    let tokenEnc = current.api_token_enc;
    let tokenLast4 = current.api_token_last4;

    if (token !== undefined && token !== null && String(token).trim() !== '') {
      const cleanToken = String(token)
        .trim()
        .replace(/^["']+|["']+$/g, '')
        .replace(/^Bearer\s+/i, '')
        .replace(/\s+/g, '');
      tokenEnc = encryptToken(cleanToken, this.secretPath);
      tokenLast4 = cleanToken.slice(-4);
    }

    if (!tokenEnc) {
      throw new Error('Debes ingresar un token de API válido.');
    }

    if (this.backend.type === 'sql') {
      this.backend.run(
        'UPDATE settings SET api_base_url = ?, api_token_enc = ?, api_token_last4 = ? WHERE id = 1',
        [cleanUrl, tokenEnc, tokenLast4]
      );
    } else {
      this.backend.store.updateSettings({
        api_base_url: cleanUrl,
        api_token_enc: tokenEnc,
        api_token_last4: tokenLast4
      });
    }
    this.reload();
    return this.getPublicConfig();
  }

  clearToken() {
    if (this.backend.type === 'sql') {
      this.backend.run(
        'UPDATE settings SET api_token_enc = NULL, api_token_last4 = NULL WHERE id = 1',
        []
      );
    } else {
      this.backend.store.updateSettings({
        api_token_enc: null,
        api_token_last4: null
      });
    }
    this.reload();
    return this.getPublicConfig();
  }

  mergeImportedEntities({ users = [], departments = [] }) {
    const nowIso = new Date().toISOString();
    for (const dept of departments) {
      if (!dept || !dept.id) continue;
      if (this.backend.type === 'sql') {
        this.backend.run(
          `INSERT INTO departments (id, name, color, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             color = excluded.color,
             updated_at = excluded.updated_at`,
          [String(dept.id), String(dept.name || 'Departamento'), String(dept.color || '#6B7280'), nowIso]
        );
      } else {
        this.backend.store.upsertDepartment({
          id: String(dept.id),
          name: String(dept.name || 'Departamento'),
          color: String(dept.color || '#6B7280'),
          updated_at: nowIso
        });
      }
    }

    for (const u of users) {
      if (!u || !u.id) continue;
      const incomingPhoto =
        u.profilePicUrl && /^https?:\/\//i.test(String(u.profilePicUrl))
          ? String(u.profilePicUrl)
          : null;
      if (this.backend.type === 'sql') {
        const existing = this.backend.get(
          'SELECT * FROM advisors WHERE whaticket_user_id = ?',
          [String(u.id)]
        );
        if (!existing) {
          this.backend.run(
            `INSERT INTO advisors (whaticket_user_id, nombre_visible, incluido, tipo, disponible, tope_maximo, peso, foto_url)
             VALUES (?, ?, 1, 'Digital', 1, 15, 1, ?)`,
            [String(u.id), String(u.name || 'Asesor'), incomingPhoto]
          );
        } else if (!existing.foto_url && incomingPhoto) {
          this.backend.run(
            'UPDATE advisors SET foto_url = ? WHERE whaticket_user_id = ?',
            [incomingPhoto, String(u.id)]
          );
        }
      } else {
        const existing = this.backend.store.findAdvisorByUserId(String(u.id));
        if (!existing) {
          this.backend.store.insertAdvisor({
            whaticket_user_id: String(u.id),
            nombre_visible: String(u.name || 'Asesor'),
            incluido: 1,
            tipo: 'Digital',
            disponible: 1,
            tope_maximo: 15,
            peso: 1,
            foto_url: incomingPhoto
          });
        } else if (!existing.foto_url && incomingPhoto) {
          this.backend.store.updateAdvisorByUserId(String(u.id), {
            foto_url: incomingPhoto
          });
        }
      }
    }

    return {
      advisors: this.listAdvisors(),
      departments: this.listDepartments()
    };
  }

  listAdvisors() {
    const rows =
      this.backend.type === 'sql'
        ? this.backend.all('SELECT * FROM advisors ORDER BY nombre_visible ASC')
        : this.backend.store.listAdvisors();
    return rows.map((r) => ({
      id: Number(r.id),
      whaticket_user_id: String(r.whaticket_user_id),
      nombre_visible: String(r.nombre_visible),
      incluido: Boolean(r.incluido),
      tipo: r.tipo === 'Sala' ? 'Sala' : 'Digital',
      disponible: Boolean(r.disponible),
      tope_maximo: Number(r.tope_maximo),
      peso: Math.max(1, Number(r.peso) || 1),
      nivel: Math.max(1, Number(r.peso) || 1),
      foto_url: r.foto_url ? String(r.foto_url) : null
    }));
  }

  listDepartments() {
    return this.backend.type === 'sql'
      ? this.backend.all('SELECT * FROM departments ORDER BY name ASC')
      : this.backend.store.listDepartments();
  }

  /**
   * Valida la foto de perfil: URL http(s) o imagen embebida (data:image/...;base64) de máx. ~300 KB.
   */
  static sanitizePhoto(value) {
    if (value === undefined) return undefined;
    if (value === null || String(value).trim() === '') return null;
    const v = String(value).trim();
    if (/^https?:\/\/[^\s"'<>]+$/i.test(v) && v.length <= 2000) return v;
    if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= 400000) {
      return v;
    }
    throw new Error('La foto de perfil debe ser una URL http(s) válida o una imagen PNG/JPG/WEBP de máximo 300 KB.');
  }

  writeAdvisor(existing, fields) {
    if (this.backend.type === 'sql') {
      if (existing) {
        this.backend.run(
          `UPDATE advisors
           SET nombre_visible = ?, incluido = ?, tipo = ?, disponible = ?, tope_maximo = ?, peso = ?, foto_url = ?
           WHERE whaticket_user_id = ?`,
          [
            fields.nombre_visible,
            fields.incluido,
            fields.tipo,
            fields.disponible,
            fields.tope_maximo,
            fields.peso,
            fields.foto_url,
            fields.whaticket_user_id
          ]
        );
      } else {
        this.backend.run(
          `INSERT INTO advisors (whaticket_user_id, nombre_visible, incluido, tipo, disponible, tope_maximo, peso, foto_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            fields.whaticket_user_id,
            fields.nombre_visible,
            fields.incluido,
            fields.tipo,
            fields.disponible,
            fields.tope_maximo,
            fields.peso,
            fields.foto_url
          ]
        );
      }
    } else if (existing) {
      this.backend.store.updateAdvisorByUserId(fields.whaticket_user_id, fields);
    } else {
      this.backend.store.insertAdvisor(fields);
    }
  }

  findAdvisorRawByUserId(uid) {
    return this.backend.type === 'sql'
      ? this.backend.get('SELECT * FROM advisors WHERE whaticket_user_id = ?', [String(uid)])
      : this.backend.store.findAdvisorByUserId(String(uid));
  }

  saveAdvisorsConfig({ advisors = [], supervisorUserId = null }) {
    for (const a of advisors) {
      if (!a.whaticket_user_id) continue;
      const uid = String(a.whaticket_user_id).trim();
      const existing = this.findAdvisorRawByUserId(uid);
      const photo = AppDatabase.sanitizePhoto(a.foto_url);
      this.writeAdvisor(existing, {
        whaticket_user_id: uid,
        nombre_visible: String(a.nombre_visible || '').trim() || 'Asesor',
        incluido: a.incluido ? 1 : 0,
        tipo: a.tipo === 'Sala' ? 'Sala' : 'Digital',
        disponible: a.disponible ? 1 : 0,
        tope_maximo: Math.max(1, Math.min(200, Number(a.tope_maximo) || 15)),
        peso: Math.max(1, Math.min(20, Math.round(Number(a.nivel ?? a.peso) || 1))),
        foto_url: photo === undefined ? (existing ? existing.foto_url || null : null) : photo
      });
    }

    if (supervisorUserId !== undefined) {
      const supVal = supervisorUserId ? String(supervisorUserId).trim() : null;
      if (this.backend.type === 'sql') {
        this.backend.run('UPDATE settings SET supervisor_user_id = ? WHERE id = 1', [supVal]);
      } else {
        this.backend.store.updateSettings({ supervisor_user_id: supVal });
      }
    }

    this.reload();
    return this.getPublicConfig();
  }

  patchAdvisor(id, patch = {}) {
    const existing =
      this.backend.type === 'sql'
        ? this.backend.get('SELECT * FROM advisors WHERE id = ?', [Number(id)])
        : this.backend.store.findAdvisorById(Number(id));
    if (!existing) {
      throw new Error('Asesor no encontrado.');
    }
    const photo = AppDatabase.sanitizePhoto(patch.foto_url);
    this.writeAdvisor(existing, {
      whaticket_user_id: String(existing.whaticket_user_id),
      nombre_visible:
        patch.nombre_visible !== undefined
          ? String(patch.nombre_visible).trim() || existing.nombre_visible
          : existing.nombre_visible,
      incluido: patch.incluido !== undefined ? (patch.incluido ? 1 : 0) : existing.incluido,
      tipo: patch.tipo !== undefined ? (patch.tipo === 'Sala' ? 'Sala' : 'Digital') : existing.tipo,
      disponible:
        patch.disponible !== undefined ? (patch.disponible ? 1 : 0) : existing.disponible,
      tope_maximo:
        patch.tope_maximo !== undefined
          ? Math.max(1, Math.min(200, Number(patch.tope_maximo) || 15))
          : existing.tope_maximo,
      peso:
        patch.nivel !== undefined || patch.peso !== undefined
          ? Math.max(1, Math.min(20, Math.round(Number(patch.nivel ?? patch.peso) || 1)))
          : Math.max(1, Number(existing.peso) || 1),
      foto_url: photo === undefined ? existing.foto_url || null : photo
    });
    return this.listAdvisors().find((a) => a.id === Number(id));
  }

  saveRules({
    greenMaxMin,
    yellowMaxMin,
    unansweredMin,
    protectionMin,
    pollingSec,
    defaultMode,
    dryRun,
    autoAssignEnabled,
    autoAssignMinWait,
    autoAssignType,
    autoOnlyOnline
  }) {
    const current = this.getRawSettings();
    const green = Math.max(1, Math.min(120, Number(greenMaxMin ?? 5)));
    const yellow = Math.max(green + 1, Math.min(240, Number(yellowMaxMin ?? 15)));
    const unanswered = Math.max(1, Math.min(240, Number(unansweredMin ?? 5)));
    const protection = Math.max(0, Math.min(60, Number(protectionMin ?? 3)));
    const polling = Math.max(5, Math.min(300, Number(pollingSec ?? 20)));
    const mode = ['round_robin', 'weighted'].includes(defaultMode) ? defaultMode : 'least_load';
    const dry = dryRun === undefined ? 1 : dryRun ? 1 : 0;
    const autoEnabled =
      autoAssignEnabled === undefined ? Number(current.auto_assign_enabled || 0) : autoAssignEnabled ? 1 : 0;
    const autoMinWait = Math.max(
      0,
      Math.min(240, Number(autoAssignMinWait ?? current.auto_assign_min_wait ?? 0) || 0)
    );
    const autoType = ['Digital', 'Sala'].includes(autoAssignType)
      ? autoAssignType
      : autoAssignType === undefined
      ? current.auto_assign_type || 'all'
      : 'all';
    const onlyOnline =
      autoOnlyOnline === undefined
        ? current.auto_only_online === undefined
          ? 1
          : Number(current.auto_only_online)
        : autoOnlyOnline
        ? 1
        : 0;

    const patch = {
      green_max_min: green,
      yellow_max_min: yellow,
      unanswered_min: unanswered,
      protection_min: protection,
      polling_sec: polling,
      default_mode: mode,
      dry_run: dry,
      auto_assign_enabled: autoEnabled,
      auto_assign_min_wait: autoMinWait,
      auto_assign_type: autoType,
      auto_only_online: onlyOnline
    };

    if (this.backend.type === 'sql') {
      const keys = Object.keys(patch);
      this.backend.run(
        `UPDATE settings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`,
        keys.map((k) => patch[k])
      );
    } else {
      this.backend.store.updateSettings(patch);
    }
    this.reload();
    return this.getPublicConfig();
  }

  saveAccess({ pin, markConfigured = true }) {
    const current = this.getRawSettings();
    let pinHash = current.pin_hash;

    if (pin !== undefined && pin !== null && String(pin).trim() !== '') {
      pinHash = hashPin(String(pin).trim());
    }

    // El PIN de acceso es obligatorio siempre (también en uso local)
    if (!pinHash) {
      throw new Error('El PIN de acceso es obligatorio. Ingresa un PIN de al menos 4 caracteres.');
    }

    const configuredAt = markConfigured
      ? current.configured_at || new Date().toISOString()
      : current.configured_at;

    if (this.backend.type === 'sql') {
      this.backend.run('UPDATE settings SET pin_hash = ?, configured_at = ? WHERE id = 1', [
        pinHash,
        configuredAt
      ]);
    } else {
      this.backend.store.updateSettings({
        pin_hash: pinHash,
        configured_at: configuredAt
      });
    }
    this.reload();
    return this.getPublicConfig();
  }

  /**
   * Registra eventos de asignación (desde el panel). Si no es simulación,
   * actualiza el último dueño conocido para no contarlo dos veces al detectar en Whaticket.
   */
  addAssignmentEvents(events = []) {
    const clean = events
      .filter((e) => e && e.ticketId && e.userId)
      .map((e) => ({
        fecha_hora: e.fecha || new Date().toISOString(),
        ticket_id: String(e.ticketId),
        user_id: String(e.userId),
        cliente_nombre: e.clienteNombre || '',
        cliente_numero: e.clienteNumero || '',
        origen: String(e.origen || 'manual'),
        simulado: e.simulado ? 1 : 0
      }));
    if (clean.length === 0) return 0;

    const ownerUpdates = {};
    for (const ev of clean) {
      if (!ev.simulado) {
        ownerUpdates[ev.ticket_id] = { user_id: ev.user_id, updated_at: ev.fecha_hora };
      }
    }

    if (this.backend.type === 'sql') {
      for (const ev of clean) {
        this.backend.run(
          `INSERT INTO assignment_events (fecha_hora, ticket_id, user_id, cliente_nombre, cliente_numero, origen, simulado)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [ev.fecha_hora, ev.ticket_id, ev.user_id, ev.cliente_nombre, ev.cliente_numero, ev.origen, ev.simulado]
        );
      }
      for (const [ticketId, o] of Object.entries(ownerUpdates)) {
        this.backend.run(
          `INSERT INTO ticket_owner (ticket_id, user_id, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(ticket_id) DO UPDATE SET user_id = excluded.user_id, updated_at = excluded.updated_at`,
          [ticketId, o.user_id, o.updated_at]
        );
      }
    } else {
      this.backend.store.insertEvents(clean, ownerUpdates);
    }
    return clean.length;
  }

  /**
   * Compara los tickets reales de Whaticket con el último dueño conocido y registra
   * como evento 'whaticket' cada asignación o reasignación hecha fuera del panel.
   */
  recordDetectedAssignments(tickets = []) {
    let owners;
    if (this.backend.type === 'sql') {
      owners = {};
      for (const r of this.backend.all('SELECT ticket_id, user_id FROM ticket_owner')) {
        owners[String(r.ticket_id)] = { user_id: r.user_id };
      }
    } else {
      owners = this.backend.store.getTicketOwners();
    }

    const events = [];
    for (const t of tickets) {
      if (!t || !t.id || !t.userId) continue;
      const known = owners[String(t.id)];
      if (known && String(known.user_id) === String(t.userId)) continue;
      events.push({
        // Primera vez que vemos el ticket: usamos su fecha de creación como mejor estimación
        fecha: known ? new Date().toISOString() : t.createdAt || new Date().toISOString(),
        ticketId: t.id,
        userId: t.userId,
        clienteNombre: t.contact?.name || '',
        clienteNumero: t.contact?.number || '',
        origen: 'whaticket',
        simulado: false
      });
    }
    return this.addAssignmentEvents(events);
  }

  listAssignmentEvents({ fromIso = null, toIso = null, userId = null, includeSimulated = false } = {}) {
    if (this.backend.type === 'pure') {
      return this.backend.store.listEvents({ fromIso, toIso, userId, includeSimulated });
    }
    const clauses = [];
    const params = [];
    if (fromIso) {
      clauses.push('fecha_hora >= ?');
      params.push(fromIso);
    }
    if (toIso) {
      clauses.push('fecha_hora < ?');
      params.push(toIso);
    }
    if (userId) {
      clauses.push('user_id = ?');
      params.push(String(userId));
    }
    if (!includeSimulated) {
      clauses.push('simulado = 0');
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.backend.all(
      `SELECT * FROM assignment_events ${whereSql} ORDER BY fecha_hora ASC LIMIT 20000`,
      params
    );
  }

  verifyUserPin(pin) {
    const s = this.getRawSettings();
    if (!s.pin_hash) return true;
    return verifyPin(pin, s.pin_hash);
  }

  updateRoundRobinCursor(nextCursor) {
    const val = Number(nextCursor) || 0;
    if (this.backend.type === 'sql') {
      this.backend.run('UPDATE settings SET round_robin_cursor = ? WHERE id = 1', [val]);
    } else {
      this.backend.store.updateSettings({ round_robin_cursor: val });
    }
    this.reload();
  }

  addAssignmentLog({
    ticketId,
    clienteNombre = '',
    clienteNumero = '',
    asesorOrigen = null,
    asesorDestino = null,
    asesorDestinoUserId = null,
    accion = 'manual',
    resultado = 'ok',
    mensajeError = null
  }) {
    const nowIso = new Date().toISOString();
    // Toda asignación exitosa (o simulada) alimenta las estadísticas e informes
    if ((resultado === 'ok' || resultado === 'simulacion') && asesorDestinoUserId) {
      this.addAssignmentEvents([
        {
          fecha: nowIso,
          ticketId,
          userId: asesorDestinoUserId,
          clienteNombre,
          clienteNumero,
          origen: accion,
          simulado: resultado === 'simulacion'
        }
      ]);
    }
    if (this.backend.type === 'sql') {
      const res = this.backend.run(
        `INSERT INTO assignment_log (
          fecha_hora, ticket_id, cliente_nombre, cliente_numero,
          asesor_origen, asesor_destino, asesor_destino_user_id,
          accion, resultado, mensaje_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nowIso,
          String(ticketId),
          clienteNombre || '',
          clienteNumero || '',
          asesorOrigen || 'Sin asignar',
          asesorDestino || 'Sin asignar',
          asesorDestinoUserId || null,
          accion,
          resultado,
          mensajeError || null
        ]
      );
      return res.lastInsertRowid;
    } else {
      return this.backend.store.insertLog({
        fecha_hora: nowIso,
        ticket_id: String(ticketId),
        cliente_nombre: clienteNombre || '',
        cliente_numero: clienteNumero || '',
        asesor_origen: asesorOrigen || 'Sin asignar',
        asesor_destino: asesorDestino || 'Sin asignar',
        asesor_destino_user_id: asesorDestinoUserId || null,
        accion,
        resultado,
        mensaje_error: mensajeError || null
      });
    }
  }

  getLogById(id) {
    return this.backend.type === 'sql'
      ? this.backend.get('SELECT * FROM assignment_log WHERE id = ?', [Number(id)])
      : this.backend.store.getLogById(Number(id));
  }

  listLogs({ dateFrom = null, dateTo = null, advisor = null, resultado = null, limit = 200 } = {}) {
    if (this.backend.type === 'pure') {
      return this.backend.store.listLogs({ dateFrom, dateTo, advisor, resultado, limit });
    }
    const clauses = [];
    const params = [];

    if (dateFrom) {
      clauses.push('fecha_hora >= ?');
      params.push(`${dateFrom}T00:00:00.000Z`);
    }
    if (dateTo) {
      clauses.push('fecha_hora <= ?');
      params.push(`${dateTo}T23:59:59.999Z`);
    }
    if (advisor) {
      clauses.push('(asesor_origen LIKE ? OR asesor_destino LIKE ?)');
      params.push(`%${advisor}%`, `%${advisor}%`);
    }
    if (resultado) {
      clauses.push('resultado = ?');
      params.push(resultado);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT * FROM assignment_log ${whereSql} ORDER BY id DESC LIMIT ?`;
    params.push(Math.min(1000, Number(limit) || 200));
    return this.backend.all(sql, params);
  }
}

module.exports = {
  AppDatabase,
  DEFAULT_DB_PATH
};
