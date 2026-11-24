'use strict';

/**
 * Cliente aislado para la API oficial de Whaticket (https://api.whaticket.com/api/v1).
 * Basado estrictamente en los endpoints reales documentados en openapi.json (docs/api-mapping.md):
 *  - GET /me
 *  - GET /tickets (con status, cursorUpdatedAt, cursorId)
 *  - GET /tickets/{ticketId}/messages
 *  - GET /queues y GET /queues/{queueId} (más intento compatible con GET /users)
 *  - POST /tickets/{ticketId}/assign (para tickets pending)
 *  - POST /tickets/{ticketId}/transfer (para tickets open)
 *  - POST /tickets/{ticketId}/set-queue (cambio de departamento)
 */

class WhaticketApiError extends Error {
  constructor(message, { status = 0, code = 'API_ERROR', details = null } = {}) {
    super(message);
    this.name = 'WhaticketApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class WhaticketClient {
  constructor(appDb, options = {}) {
    this.appDb = appDb;
    this.timeoutMs = options.timeoutMs || 10000;
    this.maxRetries = options.maxRetries ?? 2;
    this.boardCacheTtlMs = options.boardCacheTtlMs || 12000;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;

    // Estado de conexión y alertas (ej. 401 durante el uso normal)
    this.connectionState = {
      ok: false,
      authInvalid: false,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorMessage: null
    };

    // Caché en memoria (10-15 s) para evitar N+1 y sobrecarga de la API
    this.boardCache = {
      timestamp: 0,
      tickets: null
    };

    // Caché de último mensaje por ticketId -> { updatedAt, lastMessageObj }
    this.messageCache = new Map();

    // Estado simulado en memoria cuando DRY_RUN está activo
    this.dryRunOverrides = new Map(); // ticketId -> { userId, queueId, status, updatedAt }
  }

  invalidateCache() {
    this.boardCache.timestamp = 0;
    this.boardCache.tickets = null;
  }

  clearAuthError() {
    this.connectionState.authInvalid = false;
    this.connectionState.lastErrorMessage = null;
  }

  /**
   * Limpia prefijos accidentales ("Bearer "), comillas y espacios invisibles al pegar el token.
   */
  sanitizeToken(rawToken) {
    if (!rawToken) return '';
    return String(rawToken)
      .trim()
      .replace(/^["']+|["']+$/g, '')
      .replace(/^Bearer\s+/i, '')
      .replace(/\s+/g, '');
  }

  /**
   * Analiza el formato del token si parece ser un JWT (eyJ...) para diagnosticar
   * por qué Whaticket devolvió 401 (ej. token copiado incompleto o sesión web expirada).
   */
  diagnoseJwtToken(token) {
    if (!token || !token.startsWith('eyJ')) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[2]) {
      return 'El token parece estar incompleto o cortado (a un token JWT le faltan segmentos separados por punto "."). Asegúrate de copiar el token completo.';
    }
    try {
      const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
      const payload = JSON.parse(payloadJson);
      if (payload.exp && Number(payload.exp) * 1000 < Date.now()) {
        const expDate = new Date(Number(payload.exp) * 1000).toLocaleString('es-CO');
        return `Este token JWT expiró el ${expDate}. Asegúrate de generar un token permanente en Whaticket (Integraciones > Tokens) y no usar un token temporal de sesión del navegador.`;
      }
    } catch {
      return 'El contenido del token JWT parece estar truncado o mal copiado.';
    }
    return null;
  }

  /**
   * Obtiene las credenciales efectivas priorizando `customCreds`, luego la BD cifrada
   * y finalmente las variables de entorno opcionales `WHATICKET_API_URL` / `WHATICKET_API_TOKEN`.
   */
  getEffectiveCredentials(customCreds = null) {
    if (customCreds) return customCreds;
    const saved = this.appDb.getDecryptedCredentials();
    if (this.sanitizeToken(saved?.token)) {
      return saved;
    }
    const envUrl = String(process.env.WHATICKET_API_URL || '').trim();
    const envToken = this.sanitizeToken(process.env.WHATICKET_API_TOKEN || '');
    return {
      baseUrl: envUrl || saved.baseUrl || 'https://api.whaticket.com/api/v1',
      token: envToken || saved.token || null
    };
  }

  /**
   * Ejecuta una petición HTTP hacia la API de Whaticket con timeout de 10 s,
   * reintentos con backoff exponencial para 429/5xx y errores de red,
   * y traducción de errores al español.
   */
  async request(endpointPath, { method = 'GET', query = null, body = null, customCreds = null } = {}) {
    const creds = this.getEffectiveCredentials(customCreds);
    const baseUrl = String(creds.baseUrl || '').trim().replace(/\/+$/, '');
    const token = this.sanitizeToken(creds.token);

    if (!baseUrl) {
      throw new WhaticketApiError('La URL base de la API no está configurada.', {
        status: 400,
        code: 'MISSING_URL'
      });
    }
    if (!token) {
      throw new WhaticketApiError('El token de la API no está configurado.', {
        status: 401,
        code: 'MISSING_TOKEN'
      });
    }

    let urlObj;
    try {
      const normalizedPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
      urlObj = new URL(`${baseUrl}${normalizedPath}`);
      if (query && typeof query === 'object') {
        for (const [k, v] of Object.entries(query)) {
          if (v !== undefined && v !== null && v !== '') {
            urlObj.searchParams.set(k, String(v));
          }
        }
      }
    } catch {
      throw new WhaticketApiError('La URL base configurada tiene un formato inválido.', {
        status: 400,
        code: 'INVALID_URL'
      });
    }

    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const headers = {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        };
        const fetchOptions = {
          method,
          headers,
          signal: controller.signal
        };

        if (body !== null && body !== undefined && method !== 'GET') {
          headers['Content-Type'] = 'application/json';
          fetchOptions.body = JSON.stringify(body);
        }

        const response = await this.fetchImpl(urlObj.toString(), fetchOptions);
        clearTimeout(timer);

        let payload = null;
        const contentType = response.headers?.get?.('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
        } else {
          const text = await response.text().catch(() => '');
          try {
            payload = JSON.parse(text);
          } catch {
            payload = { raw: text.slice(0, 200) };
          }
        }

        if (response.ok) {
          this.connectionState.ok = true;
          this.connectionState.authInvalid = false;
          this.connectionState.lastSuccessAt = new Date().toISOString();
          this.connectionState.lastErrorMessage = null;
          return payload;
        }

        // Manejo explícito de códigos HTTP
        if (response.status === 401 || response.status === 403) {
          const apiDetail =
            payload?.error || payload?.message || payload?.code || null;
          const jwtHint = response.status === 401 ? this.diagnoseJwtToken(token) : null;
          let msg;
          if (response.status === 401) {
            if (customCreds) {
              msg =
                jwtHint ||
                `Whaticket rechazó el token (401${apiDetail ? ': ' + apiDetail : ''}). Verifica que sea un token activo creado en Integraciones > Tokens (no un token de sesión web ni de conexión QR) y que esté copiado completo.`;
            } else {
              msg = 'El token ya no es válido, actualízalo en Configuración';
            }
          } else {
            msg = `El token no tiene permisos suficientes en Whaticket para consultar ${endpointPath}${
              apiDetail ? ' (' + apiDetail + ')' : ''
            }. Revisa los permisos del perfil asociado al token.`;
          }
          if (!customCreds && response.status === 401) {
            this.connectionState.ok = false;
            this.connectionState.authInvalid = true;
            this.connectionState.lastErrorAt = new Date().toISOString();
            this.connectionState.lastErrorMessage = msg;
          }
          throw new WhaticketApiError(msg, {
            status: response.status,
            code: response.status === 401 ? 'INVALID_TOKEN' : 'FORBIDDEN',
            details: payload
          });
        }

        if (response.status === 429 || response.status >= 500) {
          if (attempt < this.maxRetries) {
            attempt += 1;
            let backoffMs = Math.min(4000, 400 * Math.pow(2, attempt));
            if (response.status === 429) {
              const retryAfterRaw = response.headers?.get?.('retry-after');
              const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
              if (Number.isFinite(retryAfterSec) && retryAfterSec > 0 && retryAfterSec <= 5) {
                backoffMs = Math.round(retryAfterSec * 1000);
              }
            }
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          const msg =
            response.status === 429
              ? 'Límite de peticiones de Whaticket alcanzado (429). Intenta de nuevo en unos segundos.'
              : `Error del servidor de Whaticket (${response.status}).`;
          this.connectionState.lastErrorAt = new Date().toISOString();
          this.connectionState.lastErrorMessage = msg;
          throw new WhaticketApiError(msg, {
            status: response.status,
            code: response.status === 429 ? 'RATE_LIMIT' : 'SERVER_ERROR',
            details: payload
          });
        }

        // Errores 400 / 404 / 422
        const apiErrorCode = payload?.error || payload?.code || payload?.message || '';
        throw new WhaticketApiError(
          `Error de Whaticket (${response.status}): ${apiErrorCode || 'Solicitud rechazada'}`,
          {
            status: response.status,
            code: String(apiErrorCode || 'BAD_REQUEST'),
            details: payload
          }
        );
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof WhaticketApiError) {
          throw err;
        }

        const isTimeout = err.name === 'AbortError' || /abort|timeout/i.test(err.message || '');
        if (attempt < this.maxRetries) {
          attempt += 1;
          const backoffMs = Math.min(3000, 350 * Math.pow(2, attempt));
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        const friendlyMsg = isTimeout
          ? 'Tiempo de espera agotado (10 s) al conectar con Whaticket.'
          : 'Sin conexión o URL incorrecta al intentar contactar la API de Whaticket.';
        if (!customCreds) {
          this.connectionState.ok = false;
          this.connectionState.lastErrorAt = new Date().toISOString();
          this.connectionState.lastErrorMessage = friendlyMsg;
        }
        throw new WhaticketApiError(friendlyMsg, {
          status: 0,
          code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR'
        });
      }
    }
  }

  /**
   * Prueba real de solo lectura para el Paso 1 del asistente:
   * Verifica GET /me y obtiene departamentos (GET /queues) y usuarios.
   */
  async testConnection({ baseUrl, token } = {}) {
    const saved = this.appDb.getDecryptedCredentials();
    const effectiveCreds = {
      baseUrl: baseUrl || saved.baseUrl,
      token: token || saved.token
    };

    const me = await this.request('/me', { customCreds: effectiveCreds });
    let departments = [];
    let queuesWarning = null;
    try {
      departments = await this.listDepartments(effectiveCreds);
    } catch (err) {
      queuesWarning = err.message;
    }
    const users = await this.listUsers(effectiveCreds, departments, me);

    return {
      ok: true,
      companyName: me?.company?.name || 'Whaticket',
      tokenName: me?.name || 'Token API',
      permissions: Array.isArray(me?.permissions) ? me.permissions : [],
      usersCount: users.length,
      departmentsCount: departments.length,
      users,
      departments,
      warning: queuesWarning
    };
  }

  /**
   * Lista los departamentos (colas) desde GET /queues.
   */
  async listDepartments(customCreds = null) {
    const data = await this.request('/queues', { customCreds });
    const queues = Array.isArray(data?.queues)
      ? data.queues
      : Array.isArray(data)
      ? data
      : [];
    return queues.map((q) => ({
      id: String(q.id),
      name: String(q.name || 'Departamento'),
      color: String(q.color || '#6B7280')
    }));
  }

  /**
   * Lista los usuarios (asesores) de Whaticket.
   * Intenta primero GET /users (mencionado en la guía de ayuda) y luego consolida
   * con GET /queues/{queueId} (propiedad users[] documentada en openapi.json) y GET /me.
   */
  async listUsers(customCreds = null, preloadedDepartments = null, meData = null) {
    const usersMap = new Map();

    // 1. GET /users (openapi.json: permiso users:view) -> incluye status online/offline y awayPeriod
    try {
      const direct = await this.request('/users', { customCreds });
      const arr = Array.isArray(direct?.users)
        ? direct.users
        : Array.isArray(direct)
        ? direct
        : [];
      for (const u of arr) {
        if (u && u.id) {
          usersMap.set(String(u.id), WhaticketClient.normalizeUser(u));
        }
      }
    } catch {
      // Si el token no tiene users:view, continuamos con GET /queues/{queueId}
    }

    // 2. Extraer usuarios asociados a cada departamento mediante GET /queues/{queueId} (openapi.json)
    const departments = preloadedDepartments || (await this.listDepartments(customCreds));
    for (const dept of departments) {
      try {
        const detail = await this.request(`/queues/${encodeURIComponent(dept.id)}`, {
          customCreds
        });
        const queueUsers = Array.isArray(detail?.users) ? detail.users : [];
        for (const u of queueUsers) {
          if (u && u.id && !usersMap.has(String(u.id))) {
            usersMap.set(String(u.id), {
              id: String(u.id),
              name: String(u.name || 'Asesor')
            });
          }
        }
      } catch {
        // Ignorar si un departamento individual falla
      }
    }

    // 3. Incluir usuario asociado al token en GET /me si existe
    try {
      const me = meData || (await this.request('/me', { customCreds }));
      if (me?.user?.id && !usersMap.has(String(me.user.id))) {
        usersMap.set(String(me.user.id), {
          id: String(me.user.id),
          name: String(me.user.name || 'Supervisor')
        });
      }
    } catch {
      // Ignorar
    }

    return Array.from(usersMap.values());
  }

  /**
   * Normaliza un usuario de GET /users. status: online | offline | pending | seatless.
   * Campos de foto opcionales (la API v1 no documenta foto de usuario; se leen si existen).
   */
  static normalizeUser(u) {
    const status = u.status ? String(u.status) : null;
    const away = u.awayPeriod && typeof u.awayPeriod === 'object' ? u.awayPeriod : null;
    const photo = u.profilePicUrl || u.profileImage || u.avatarUrl || u.avatar || null;
    return {
      id: String(u.id),
      name: String(u.name || 'Asesor'),
      email: u.email ? String(u.email) : null,
      status,
      online: status ? status === 'online' && !away : null,
      away: away ? { reason: away.reason || null, startedAt: away.startedAt || null } : null,
      isActive: u.isActive === undefined ? true : Boolean(u.isActive),
      profilePicUrl: typeof photo === 'string' && /^https?:\/\//i.test(photo) ? photo : null
    };
  }

  /**
   * Estado en vivo de los usuarios (en línea / ausente) con caché de 45 s
   * para no consumir el límite de 600 peticiones/minuto.
   * Devuelve Map userId -> usuario normalizado. Si falla, conserva el último valor conocido.
   */
  async getLiveUsers({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.liveUsersCache && now - this.liveUsersCache.timestamp < 45000) {
      return this.liveUsersCache.map;
    }
    try {
      const data = await this.request('/users');
      const arr = Array.isArray(data?.users) ? data.users : Array.isArray(data) ? data : [];
      const map = new Map(arr.filter((u) => u && u.id).map((u) => [String(u.id), WhaticketClient.normalizeUser(u)]));
      this.liveUsersCache = { timestamp: now, map, available: true };
    } catch {
      this.liveUsersCache = {
        timestamp: now,
        map: this.liveUsersCache?.map || new Map(),
        available: false
      };
    }
    return this.liveUsersCache.map;
  }

  /**
   * Obtiene el último mensaje real de un ticket desde GET /tickets/{ticketId}/messages.
   * Devuelve { id, body, fromMe, senderType: 'cliente'|'asesor', userId, createdAt }
   */
  async getLastMessage(ticketId, ticketUpdatedAt = null) {
    const key = String(ticketId);
    const cached = this.messageCache.get(key);
    if (cached && ticketUpdatedAt && cached.updatedAt === ticketUpdatedAt) {
      return cached.lastMessageObj;
    }

    const data = await this.request(`/tickets/${encodeURIComponent(key)}/messages`);
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    // Filtrar notas internas y mensajes eliminados; el arreglo viene en orden cronológico
    const visibleMessages = messages.filter((m) => !m.isNote && !m.isDeleted);
    const last =
      visibleMessages.length > 0
        ? visibleMessages[visibleMessages.length - 1]
        : messages[messages.length - 1] || null;

    const lastMessageObj = last
      ? {
          id: String(last.id),
          body: String(last.body || ''),
          fromMe: Boolean(last.fromMe),
          senderType: last.fromMe ? 'asesor' : 'cliente',
          userId: last.userId || null,
          createdAt: last.createdAt || ticketUpdatedAt || new Date().toISOString()
        }
      : null;

    this.messageCache.set(key, {
      updatedAt: ticketUpdatedAt || new Date().toISOString(),
      lastMessageObj
    });

    return lastMessageObj;
  }

  /**
   * Lista los tickets abiertos y pendientes paginando por cursor (cursorUpdatedAt + cursorId)
   * y enriquece el último mensaje evitando el problema N+1.
   */
  async listTickets({ statuses = ['open', 'pending'], maxPages = 3, forceRefresh = false } = {}) {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.boardCache.tickets &&
      now - this.boardCache.timestamp < this.boardCacheTtlMs
    ) {
      return this.applyDryRunOverrides(this.boardCache.tickets);
    }

    const statusParam = Array.isArray(statuses) ? statuses.join(',') : String(statuses);
    const allTickets = [];
    let cursorUpdatedAt = null;
    let cursorId = null;

    for (let page = 0; page < maxPages; page++) {
      const query = { status: statusParam };
      if (cursorUpdatedAt && cursorId) {
        query.cursorUpdatedAt = cursorUpdatedAt;
        query.cursorId = cursorId;
      }

      const res = await this.request('/tickets', { query });
      const batch = Array.isArray(res?.tickets) ? res.tickets : [];
      allTickets.push(...batch);

      if (!res?.hasMore || batch.length === 0) {
        break;
      }
      const lastTicket = batch[batch.length - 1];
      if (!lastTicket?.updatedAt || !lastTicket?.id) {
        break;
      }
      cursorUpdatedAt = lastTicket.updatedAt;
      cursorId = lastTicket.id;
    }

    // Evitar N+1: determinar qué tickets necesitan consultar GET /tickets/{id}/messages
    const ticketsNeedingMessageFetch = [];
    const enriched = allTickets.map((t) => {
      const cached = this.messageCache.get(String(t.id));
      if (cached && cached.updatedAt === t.updatedAt && cached.lastMessageObj) {
        return { ...t, lastMessageObj: cached.lastMessageObj };
      }

      // Heurística sin llamada extra cuando el ticket tiene unreadMessages > 0 o está pending sin asesor
      if (Number(t.unreadMessages) > 0 || (t.status === 'pending' && !t.userId)) {
        const inferred = {
          id: `inferred-${t.id}`,
          body: String(t.lastMessage || ''),
          fromMe: false,
          senderType: 'cliente',
          userId: null,
          createdAt: t.lastReceivedMessageAt || t.updatedAt || t.createdAt
        };
        this.messageCache.set(String(t.id), {
          updatedAt: t.updatedAt,
          lastMessageObj: inferred
        });
        return { ...t, lastMessageObj: inferred };
      }

      ticketsNeedingMessageFetch.push(t);
      return {
        ...t,
        lastMessageObj: {
          id: `fallback-${t.id}`,
          body: String(t.lastMessage || ''),
          fromMe: false,
          senderType: 'cliente',
          userId: t.userId || null,
          createdAt: t.lastReceivedMessageAt || t.updatedAt || t.createdAt
        }
      };
    });

    // Consultar mensajes solo para los tickets abiertos que cambiaron (máximo 15 por ciclo, de 5 en 5)
    const toFetch = ticketsNeedingMessageFetch.slice(0, 15);
    const concurrency = 5;
    for (let i = 0; i < toFetch.length; i += concurrency) {
      const slice = toFetch.slice(i, i + concurrency);
      await Promise.all(
        slice.map(async (t) => {
          try {
            const msgObj = await this.getLastMessage(t.id, t.updatedAt);
            if (msgObj) {
              const target = enriched.find((item) => item.id === t.id);
              if (target) {
                target.lastMessageObj = msgObj;
              }
            }
          } catch {
            // Conservar fallback si un ticket individual da 422/404
          }
        })
      );
    }

    this.boardCache = {
      timestamp: Date.now(),
      tickets: enriched
    };

    return this.applyDryRunOverrides(enriched);
  }

  applyDryRunOverrides(tickets) {
    const settings = this.appDb.getRawSettings();
    if (!settings.dry_run || this.dryRunOverrides.size === 0) {
      return tickets;
    }
    return tickets.map((t) => {
      const over = this.dryRunOverrides.get(String(t.id));
      if (!over) return t;
      return {
        ...t,
        userId: over.userId !== undefined ? over.userId : t.userId,
        queueId: over.queueId !== undefined ? over.queueId : t.queueId,
        status: over.status || t.status,
        updatedAt: over.updatedAt || t.updatedAt
      };
    });
  }

  /**
   * Cambia el asesor (userId) y/o departamento (queueId) de un ticket usando
   * los endpoints reales de openapi.json:
   *  - Si status === 'pending': POST /tickets/{ticketId}/assign ({ userId })
   *    y opcionalmente POST /tickets/{ticketId}/set-queue ({ queueId })
   *  - Si status === 'open': POST /tickets/{ticketId}/transfer ({ userId, queueId, transferNote })
   *  - Si solo cambia queueId sin userId: POST /tickets/{ticketId}/set-queue ({ queueId })
   */
  async assignTicket(ticketOrId, { userId, queueId = undefined, transferNote = undefined } = {}) {
    const ticketId = typeof ticketOrId === 'object' ? ticketOrId.id : ticketOrId;
    const currentStatus =
      typeof ticketOrId === 'object' && ticketOrId.status ? ticketOrId.status : 'pending';

    const settings = this.appDb.getRawSettings();
    if (settings.dry_run) {
      const simulated = {
        id: String(ticketId),
        userId: userId || null,
        queueId: queueId !== undefined ? queueId : ticketOrId?.queueId ?? null,
        status: userId ? 'open' : currentStatus,
        updatedAt: new Date().toISOString(),
        simulated: true
      };
      this.dryRunOverrides.set(String(ticketId), simulated);
      return simulated;
    }

    // Si solo se cambia el departamento sin cambiar usuario
    if (!userId && queueId !== undefined) {
      const updated = await this.request(`/tickets/${encodeURIComponent(ticketId)}/set-queue`, {
        method: 'POST',
        body: { queueId }
      });
      this.invalidateCache();
      return updated;
    }

    if (!userId) {
      throw new WhaticketApiError('Se requiere el UUID del asesor (userId) para asignar el ticket.', {
        status: 400,
        code: 'MISSING_USER_ID'
      });
    }

    let result;
    if (currentStatus === 'pending') {
      try {
        result = await this.request(`/tickets/${encodeURIComponent(ticketId)}/assign`, {
          method: 'POST',
          body: { userId }
        });
        if (queueId !== undefined && queueId !== null) {
          result = await this.request(`/tickets/${encodeURIComponent(ticketId)}/set-queue`, {
            method: 'POST',
            body: { queueId }
          });
        }
      } catch (err) {
        // Si otro asesor lo abrió justo antes del clic, openapi.json devuelve ERR_OTHER_OPEN_TICKET
        if (err.code && err.code.includes('ERR_OTHER_OPEN_TICKET')) {
          const transferBody = { userId };
          if (queueId !== undefined) transferBody.queueId = queueId;
          if (transferNote) transferBody.transferNote = transferNote;
          result = await this.request(`/tickets/${encodeURIComponent(ticketId)}/transfer`, {
            method: 'POST',
            body: transferBody
          });
        } else {
          throw err;
        }
      }
    } else {
      // Ticket 'open': usar POST /tickets/{ticketId}/transfer
      try {
        const transferBody = { userId };
        if (queueId !== undefined) transferBody.queueId = queueId;
        if (transferNote) transferBody.transferNote = transferNote;
        result = await this.request(`/tickets/${encodeURIComponent(ticketId)}/transfer`, {
          method: 'POST',
          body: transferBody
        });
      } catch (err) {
        // Si el ticket pasó a pending justo antes, openapi.json devuelve ERR_TRANSFER_PENDING_TICKET
        if (err.code && err.code.includes('ERR_TRANSFER_PENDING_TICKET')) {
          result = await this.request(`/tickets/${encodeURIComponent(ticketId)}/assign`, {
            method: 'POST',
            body: { userId }
          });
          if (queueId !== undefined && queueId !== null) {
            result = await this.request(`/tickets/${encodeURIComponent(ticketId)}/set-queue`, {
              method: 'POST',
              body: { queueId }
            });
          }
        } else {
          throw err;
        }
      }
    }

    this.invalidateCache();
    return result;
  }

  /**
   * Lista tickets sin modificar la caché en vivo del tablero ni su caché de mensajes.
   * Pagina mediante cursor (cursorUpdatedAt + cursorId) y deduplica por id.
   */
  async listTicketsRaw({ statuses = ['open', 'pending', 'closed'], maxPages = 15 } = {}) {
    const statusParam = Array.isArray(statuses) ? statuses.join(',') : String(statuses);
    const seenIds = new Set();
    const tickets = [];
    let cursorUpdatedAt = null;
    let cursorId = null;
    let pagesFetched = 0;
    let hasMore = false;

    for (let page = 0; page < maxPages; page++) {
      const query = { status: statusParam };
      if (cursorUpdatedAt && cursorId) {
        query.cursorUpdatedAt = cursorUpdatedAt;
        query.cursorId = cursorId;
      }

      const res = await this.request('/tickets', { query });
      pagesFetched += 1;
      const batch = Array.isArray(res?.tickets) ? res.tickets : [];
      for (const t of batch) {
        if (!t || !t.id) continue;
        const idKey = String(t.id);
        if (!seenIds.has(idKey)) {
          seenIds.add(idKey);
          tickets.push(t);
        }
      }

      hasMore = Boolean(res?.hasMore);
      if (!hasMore || batch.length === 0) {
        hasMore = false;
        break;
      }
      const lastTicket = batch[batch.length - 1];
      if (!lastTicket?.updatedAt || !lastTicket?.id) {
        break;
      }
      cursorUpdatedAt = lastTicket.updatedAt;
      cursorId = lastTicket.id;
    }

    return {
      tickets,
      pagesFetched,
      hasMore
    };
  }

  /**
   * Obtiene mensajes de un ticket sin alterar la caché del tablero en vivo.
   * Soporta paginación por cursor según openapi.json.
   */
  async getTicketMessages(ticketId, { cursor = null, cursorId = null, direction = 'before' } = {}) {
    const query = {};
    if (cursor) query.cursor = cursor;
    if (cursorId) query.cursorId = cursorId;
    if (cursor && direction) query.direction = direction;

    const data = await this.request(`/tickets/${encodeURIComponent(String(ticketId))}/messages`, {
      query: Object.keys(query).length > 0 ? query : null
    });

    return {
      messages: Array.isArray(data?.messages) ? data.messages : [],
      hasMoreBefore: Boolean(data?.hasMoreBefore),
      hasMoreAfter: Boolean(data?.hasMoreAfter)
    };
  }
}

module.exports = {
  WhaticketClient,
  WhaticketApiError
};
