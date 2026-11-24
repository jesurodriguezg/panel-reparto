'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const { createServerApp } = require('./app');

// Cargar .env opcional (PORT, HOST y respaldo opcional de credenciales Whaticket)
const ALLOWED_ENV_KEYS = new Set(['PORT', 'HOST', 'WHATICKET_API_URL', 'WHATICKET_API_TOKEN']);
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (ALLOWED_ENV_KEYS.has(k) && !process.env[k]) {
        process.env[k] = v;
      }
    }
  }
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const { createHttpServer } = createServerApp({ host: HOST });
const server = createHttpServer();

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log(`[AVISO] El puerto ${PORT} ya está en uso. Abriendo http://localhost:${PORT} ...`);
    openBrowser(`http://localhost:${PORT}`);
  } else {
    console.error('[ERROR] No se pudo iniciar el servidor:', err.message);
  }
});

function openBrowser(url) {
  if (process.env.NO_OPEN_BROWSER === '1') return;
  const platform = process.platform;
  if (platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log('==============================================================');
  console.log('  PANEL DE REPARTO - MOTOS ALFA (HERO MOTOCORP CARTAGENA)');
  console.log(`  Servidor listo y escuchando en: ${url}`);
  console.log(`  Modo de red (HOST):             ${HOST}`);
  console.log('==============================================================');
  openBrowser(url);
});
