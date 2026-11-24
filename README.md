# Panel de Reparto — Motos Alfa (Hero MotoCorp Cartagena)

Aplicación web local en español para el **supervisor de ventas** de **Motos Alfa**. Conecta en tiempo real con la [API oficial de Whaticket (`v1`)](https://api.whaticket.com/api/v1/openapi.json), detecta tickets **En espera** (incluyendo los que llegan sin departamento asignado) y **Sin responder**, y permite reasignarlos o repartirlos equitativamente entre asesores de **Digital** y **Sala** con un clic.

## Características principales

* **Cero configuración por archivos**: No requiere editar archivos `.env` ni código. Al abrir la aplicación por primera vez se lanza automáticamente el **Asistente de Configuración de 4 pasos**.

* **Seguridad en reposo y en tránsito**:

  * El token de Whaticket se cifra en disco con **AES-256-GCM** (`data/app.db`) usando una clave aleatoria generada en `data/.secret`.

  * El token **nunca regresa al navegador** (solo se informa `{ configurado: true, ultimos4: "••••a1b2" }`).

  * El PIN de acceso se guarda con hash `scrypt` y protege las sesiones con cookie `HttpOnly` cuando se publica en red local (`HOST=0.0.0.0`).

  * Todos los nombres y mensajes de clientes se renderizan con `textContent` (protección total contra XSS).

* **Modo Simulación (`DRY_RUN`)**: Activado por defecto en la primera configuración para probar el reparto sin modificar datos reales en Whaticket.

* **Sin dependencias externas en el navegador**: HTML, CSS y JavaScript vanilla puro, fuentes del sistema e iconos inline, con **modo claro y modo oscuro** sin parpadeo.

## Requisitos previos

* **Sistema operativo**: Windows 10/11, macOS o Ubuntu / Linux.

* **Node.js**: Versión **20 LTS o superior** instalada ([descargar desde nodejs.org](https://nodejs.org/)).

## Cómo iniciar la aplicación (paso a paso)

### Opción A: Inicio con doble clic (recomendado)

* **En Windows**: Haz doble clic en `iniciar.bat`.

* **En Linux / macOS**: Ejecuta `./iniciar.sh` desde la terminal.

El script instalará las dependencias automáticamente la primera vez, arrancará el servidor local y abrirá el navegador en `http://localhost:3000`.

### Opción B: Desde la terminal

1. Abre una terminal en la carpeta del proyecto e instala las dependencias:

   ```
   npm install
   
   ```

2. Inicia el servidor:

   ```
   npm start
   
   ```

3. Abre tu navegador en **`http://localhost:3000`**.

## Completar el Asistente de Configuración (4 pasos)

1. **Paso 1 — Conexión con Whaticket**:

   * Verifica la URL base (`https://api.whaticket.com/api/v1`).

   * Pega tu token creado en Whaticket (**Integraciones > Tokens**, asegurándote de que el perfil asociado tenga permisos en *Chats* y *Departamentos*).

   * Haz clic en **"Probar conexión"**. Verás la cantidad de usuarios y departamentos detectados y se habilitará el botón **"Siguiente"**.

2. **Paso 2 — Asesores y departamentos**:

   * Marca qué usuarios participan como asesores, su área (**Digital** o **Sala**), disponibilidad y su **tope máximo** de tickets abiertos/pendientes.

   * Elige quién es el **usuario supervisor** para el botón **"Tomar yo"**.

3. **Paso 3 — Reglas y Semáforo**:

   * Define los minutos para el semáforo (**Verde**, **Amarillo**, **Rojo**), minutos para considerar un ticket **Sin responder**, minutos de **protección** (para no mover conversaciones activas en los últimos *N* minutos) y el modo de reparto (**Menor carga** o **Turnos**).

   * Mantén activo el **Modo simulación (`DRY_RUN`)** mientras realizas tus primeras pruebas y desactívalo en **Configuración** cuando quieras aplicar cambios reales en Whaticket.

4. **Paso 4 — Acceso y seguridad**:

   * Configura un PIN de acceso (obligatorio si usas `HOST=0.0.0.0` en la red local del concesionario) y haz clic en **"Guardar y abrir el tablero"**.

## Ejecutar las pruebas unitarias

Para verificar la suite de pruebas unitarias (cifrado AES-256-GCM, enmascarado de token, hash de PIN, reparto por menor carga, turnos, topes, protección, liberar asesor y cliente API):

```
npm test

```

## Estructura del proyecto

* `server/index.js`: Punto de entrada del servidor HTTP.

* `server/app.js`: Rutas de la API propia (`/api/board`, `/api/tickets/assign`, `/api/distribute`, `/api/advisors/:id/release`, `/api/setup/*`, `/api/config`, `/api/log`, `/api/stream`).

* `server/whaticketClient.js`: Cliente aislado de la API de Whaticket con timeout de 10 s, backoff exponencial, caché en memoria y manejo de errores 401/429/5xx.

* `server/distributionEngine.js`: Motor puro de reparto equitativo, protección por actividad reciente y liberación de asesores.

* `server/db.js`: Persistencia SQLite en `data/app.db` y recarga en caliente.

* `server/crypto.js`: Cifrado AES-256-GCM con clave en `data/.secret` y hash `scrypt`.

* `public/`: Interfaz web vanilla (`index.html`, `styles.css`, `app.js`).

* `docs/api-mapping.md`: Documentación exacta de los endpoints de `openapi.json` utilizados.

* `tests/distributionAndCrypto.test.js`: Pruebas unitarias automatizadas.