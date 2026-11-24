# Mapeo de la API de Whaticket (`docs/api-mapping.md`)

Documento generado en el **Paso 0** a partir de la especificación oficial [OpenAPI JSON de Whaticket (`v1.0.0`)](https://api.whaticket.com/api/v1/openapi.json) (`openapi: "3.0.0"`, `info.title: "Whaticket - API"`, `servers: [{"url": "/api/v1"}]`) y de la [Guía completa de la API de Whaticket](https://help.whaticket.com/es/articles/api-de-whaticket-guia-completa).

## 1. Esquema de autenticación y límites generales

- **URL base por defecto:** `https://api.whaticket.com/api/v1`
- **Esquema OpenAPI (`components.securitySchemes.bearerAuth`):**
  - `type`: `"http"`
  - `scheme`: `"bearer"`
  - `bearerFormat`: `"JWT"`
- **Encabezado requerido en cada petición:**
  ```http
  Authorization: Bearer <TOKEN_DE_API>
  Accept: application/json
  Content-Type: application/json
  ```
- **Límite de tasa (Rate Limit):** Hasta **600 solicitudes por minuto por empresa** sumando todas las rutas, tokens y aplicaciones conectadas ([Guía completa de la API de Whaticket](https://help.whaticket.com/es/articles/api-de-whaticket-guia-completa)).
- **Verificación de token (`GET /me`):**
  - **Ruta:** `GET /me` (tag `Discovery`, `x-permissions: []`).
  - **Respuesta `200` (`CurrentCredential`):**
    ```json
    {
      "name": "Token Panel de Reparto",
      "company": { "id": "uuid", "name": "Motos Alfa" },
      "permissions": [
        "tickets:view",
        "tickets:viewAll",
        "tickets:viewPending",
        "tickets:acceptPending",
        "tickets:transfer",
        "tickets:changeQueue",
        "queues:view"
      ],
      "user": { "id": "uuid", "name": "Supervisor" }
    }
    ```
    *(Nota: `user` es `null` cuando el token está vinculado directamente a un perfil de permisos en lugar de un usuario nominal).*

## 2. Endpoints requeridos para el Panel de Reparto

### A. Listar tickets con filtro por estado y paginación
- **Método y ruta:** `GET /tickets`
- **Permisos requeridos (`x-permissions`):** `["tickets:view", "tickets:viewAll"]` y adicionalmente `tickets:viewPending` para incluir tickets en estado `pending` (En espera).
- **Parámetros Query soportados (según `openapi.json`):**
  | Parámetro | Tipo | Descripción |
  | :--- | :--- | :--- |
  | `status` | `string` | Estados separados por coma: `open`, `pending`, `closed`. Para el tablero consultamos `status=open,pending`. |
  | `channels` | `string` | Canales separados por coma (ej. `whatsapp`, `facebook`, `instagram`). |
  | `queueIds` | `string` | UUIDs de departamentos/colas separados por coma. |
  | `userIds` | `string` | UUIDs de asesores separados por coma. |
  | `snoozed` | `string` | Enum `"true"` o `"false"`. |
  | `searchParam` | `string` | Busca por nombre del contacto o dígitos finales del teléfono. |
  | `cursorUpdatedAt` | `string (date-time)` | `updatedAt` del último ticket de la página anterior (paginación por cursor). Debe enviarse junto con `cursorId`. |
  | `cursorId` | `string (uuid)` | `id` del último ticket de la página anterior. |
- **Paginación:** Devuelve hasta **100 tickets por página**, ordenados por `updatedAt` descendente y luego `id`.
- **Estructura de respuesta `200`:**
  ```json
  {
    "tickets": [
      {
        "id": "uuid-ticket",
        "status": "pending",
        "channel": "whatsapp",
        "unreadMessages": 2,
        "isGroup": false,
        "queueId": null,
        "kanbanColumnId": null,
        "userId": null,
        "connectionExternalId": "uuid-conexion",
        "lastMessage": "Hola, quiero cotizar la Hunk 160R",
        "lastReceivedMessageAt": "2026-11-17T14:55:10.000Z",
        "snoozedUntil": null,
        "createdAt": "2026-11-17T14:50:00.000Z",
        "updatedAt": "2026-11-17T14:55:10.000Z",
        "contact": {
          "id": "uuid-contacto",
          "name": "Carlos Pérez",
          "number": "573001234567",
          "email": "",
          "treatmentName": null,
          "profilePicUrl": null,
          "tags": []
        }
      }
    ],
    "hasMore": false
  }
  ```

### B. Obtener el último mensaje de un ticket (autor, texto y fecha)
- **Hallazgo en `Ticket` (`GET /tickets`):**
  - El objeto `Ticket` incluye `lastMessage` (`string | null`), `lastReceivedMessageAt` (`date-time | null`, instante del último mensaje enviado por el cliente), `updatedAt` (`date-time`) y `unreadMessages` (`integer`).
  - Sin embargo, `Ticket` **no incluye un booleano directo `fromMe`** para distinguir con certeza absoluta en todos los casos si el último mensaje fue del cliente o del asesor.
- **Endpoint de mensajes del ticket:** `GET /tickets/{ticketId}/messages`
  - **Permisos requeridos:** `["tickets:view", "tickets:viewAll"]`.
  - **Parámetros Query opcionales:** `cursor` (`date-time`), `cursorId` (`uuid`), `direction` (`"before"` | `"after"`, por defecto `"before"`), `aroundMessageId` (`uuid`).
  - **Comportamiento sin cursor:** Devuelve los **20 mensajes más recientes** en **orden cronológico** (el último elemento del arreglo `messages` es el mensaje más reciente).
  - **Esquema `TicketMessage`:**
    | Campo | Tipo | Significado en el negocio |
    | :--- | :--- | :--- |
    | `id` | `string` | Identificador del mensaje. |
    | `body` | `string` | Texto del mensaje. |
    | `fromMe` | `boolean` | `false` = enviado por el **cliente**; `true` = enviado por el **asesor / sistema**. |
    | `userId` | `string \| null` | UUID del asesor que envió el mensaje (`null` si fue cliente, bot o campaña). |
    | `isNote` | `boolean` | `true` si es una nota interna (se filtra al evaluar respuesta al cliente). |
    | `isDeleted` | `boolean` | `true` si el mensaje fue eliminado. |
    | `createdAt` | `string (date-time)` | Fecha y hora exacta del mensaje. |
- **Estrategia implementada en `whaticketClient.js` para evitar N+1:**
  1. Si el ticket tiene `unreadMessages > 0`, o si está `pending` sin asesor y tiene `lastReceivedMessageAt`, se infiere directamente que el último mensaje es del cliente (`fromMe: false`, `text: ticket.lastMessage`, `createdAt: ticket.lastReceivedMessageAt || ticket.updatedAt`).
  2. Si `ticket.lastReceivedMessageAt` existe y es al menos 2 segundos anterior a `ticket.updatedAt` con `unreadMessages === 0`, o cuando necesitamos confirmar dirección de mensaje y ventana de protección en tickets activos, se consulta `GET /tickets/{ticketId}/messages` **únicamente** para los tickets cuyo `updatedAt` haya cambiado respecto al caché en memoria (`messageCache` indexado por `ticketId -> updatedAt`), con un límite de concurrencia de 5 peticiones simultáneas.

### C. Listar departamentos (colas) y usuarios (asesores)
- **Departamentos (`GET /queues` y `GET /queues/{queueId}`):**
  - `GET /queues` (permiso `queues:view`) devuelve `{ "queues": [{ "id": "uuid", "name": "Digital", "color": "#3B5BDB" }] }`.
  - `GET /queues/{queueId}` (permiso `queues:view`) devuelve `QueueDetail`:
    ```json
    {
      "id": "uuid-cola",
      "name": "Ventas Digital",
      "color": "#3B5BDB",
      "greetingMessage": "...",
      "isAutoAssignmentEnabled": false,
      "assignToOfflineUsers": false,
      "connections": [
        { "id": "uuid-conn", "name": "WhatsApp Principal", "channel": "whatsapp" }
      ],
      "users": [
        { "id": "uuid-user-1", "name": "Claudia Díaz", "isAutoAssignmentEnabled": true }
      ]
    }
    ```
- **Usuarios (`GET /users` y extracción desde `GET /queues/{queueId}`):**
  - **Observación importante del Paso 0:** En el artículo oficial [Guía completa de la API de Whaticket](https://help.whaticket.com/es/articles/api-de-whaticket-guia-completa) se menciona `GET /users`, pero en el archivo público `https://api.whaticket.com/api/v1/openapi.json` (`v1.0.0`) no aparece declarada la ruta `GET /users` dentro de `paths`; en su lugar, la especificación OpenAPI expone la lista de usuarios dentro del detalle de cada departamento (`GET /queues/{queueId}` -> propiedad `users[]`) y el usuario propietario del token en `GET /me` (`user`).
  - **Solución implementada sin inventar rutas:** `whaticketClient.listUsers()` intenta primero `GET /users` (por compatibilidad si la instancia la habilita) y, si responde `404`/`405` o no está presente, extrae y deduplica automáticamente todos los usuarios desde `GET /queues/{queueId}` para cada departamento devuelto por `GET /queues`, sumando además el `user` de `GET /me`. Asimismo, el Paso 2 del asistente permite añadir manualmente un usuario por su UUID copiado desde **Equipo** en Whaticket (por ejemplo, si el supervisor no pertenece a ningún departamento).

### D. Cambiar el usuario (asesor) y/o el departamento de un ticket
En `openapi.json`, `GET /tickets/{ticketId}` es de solo lectura. El cambio de asesor y/o departamento se realiza mediante **tres rutas `POST` específicas según el estado actual del ticket**:

1. **Asignar un ticket que está `pending` (En espera) o `resolved`:**
   - **Ruta:** `POST /tickets/{ticketId}/assign`
   - **Permisos:** `["tickets:view", "tickets:viewAll", "tickets:viewPending", "tickets:acceptPending"]`
   - **Body JSON:**
     ```json
     { "userId": "uuid-del-asesor" }
     ```
   - **Nota de la API:** Cambia el ticket de `pending` a `open` asignado a `userId`. Si se invoca sobre un ticket que ya está `open`, devuelve `400 ERR_OTHER_OPEN_TICKET`. No acepta `queueId` en el body; si también se desea asignar departamento, se encadena con `POST /tickets/{ticketId}/set-queue`.

2. **Transferir/reasignar un ticket que ya está `open` (con asesor):**
   - **Ruta:** `POST /tickets/{ticketId}/transfer`
   - **Permisos:** `["tickets:view", "tickets:viewAll", "tickets:transfer"]`
   - **Body JSON:**
     ```json
     {
       "userId": "uuid-del-asesor-destino",
       "queueId": "uuid-del-departamento-opcional",
       "transferNote": "Reasignado desde Panel de Reparto"
     }
     ```
   - **Nota de la API:** `userId` es obligatorio (`required: ["userId"]`). Si se invoca sobre un ticket `pending`, la API responde `400 ERR_TRANSFER_PENDING_TICKET`.

3. **Cambiar el departamento (`queueId`) de un ticket:**
   - **Ruta:** `POST /tickets/{ticketId}/set-queue`
   - **Permisos:** `["tickets:view", "tickets:viewAll", "tickets:changeQueue"]`
   - **Body JSON:**
     ```json
     { "queueId": "uuid-del-departamento-o-null" }
     ```

4. **Comportamiento de `whaticketClient.assignTicket(ticket, { userId, queueId, transferNote })`:**
   - Selecciona automáticamente la ruta exacta de `openapi.json` según `ticket.status`:
     - Si `ticket.status === 'pending'` (o no tiene `userId` y está pendiente): llama a `POST /tickets/{ticketId}/assign` con `{ userId }`. Si además se especificó `queueId`, llama a continuación a `POST /tickets/{ticketId}/set-queue` con `{ queueId }`.
     - Si `ticket.status === 'open'`: llama a `POST /tickets/{ticketId}/transfer` con `{ userId, ...(queueId !== undefined ? { queueId } : {}), ...(transferNote ? { transferNote } : {}) }`. Si la API devuelve `ERR_TRANSFER_PENDING_TICKET` porque el estado cambió entre el último polling y el clic, hace fallback automático a `POST /tickets/{ticketId}/assign`.
     - Si `ticket.status === 'open'` y en `POST /tickets/{ticketId}/assign` devolviera `ERR_OTHER_OPEN_TICKET`, hace fallback automático a `POST /tickets/{ticketId}/transfer`.
