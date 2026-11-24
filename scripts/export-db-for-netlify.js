'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AppDatabase, DEFAULT_DB_PATH } = require('../server/db');
const { DEFAULT_SECRET_PATH } = require('../server/crypto');

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'netlify-seed.json');

function main() {
  if (!fs.existsSync(DEFAULT_DB_PATH)) {
    console.error(`[ERROR] No se encontró la base de datos local en: ${DEFAULT_DB_PATH}`);
    process.exit(1);
  }

  const db = new AppDatabase(DEFAULT_DB_PATH, DEFAULT_SECRET_PATH);
  const snapshot = db.exportStateSnapshot();

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
  const sizeKb = (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1);

  const hasSecret =
    fs.existsSync(DEFAULT_SECRET_PATH) &&
    Buffer.from(fs.readFileSync(DEFAULT_SECRET_PATH, 'utf8').trim(), 'hex').length === 32;

  console.log('==============================================================');
  console.log('  EXPORTACIÓN DE BASE DE DATOS LOCAL PARA NETLIFY BLOBS');
  console.log('==============================================================');
  console.log(`  Archivo generado:   ${OUTPUT_PATH} (${sizeKb} KB)`);
  console.log(`  Motor origen:       ${db.backend.type}`);
  console.log(`  Departamentos:      ${snapshot.departments.length}`);
  console.log(`  Asesores:           ${snapshot.advisors.length}`);
  console.log(`  Historial (logs):   ${snapshot.assignment_log.length}`);
  console.log(`  Eventos:            ${snapshot.assignment_events.length}`);
  console.log(`  Dueños de tickets:  ${Object.keys(snapshot.ticket_owner).length}`);
  console.log(`  Clave data/.secret: ${hasSecret ? 'OK (32 bytes hex listos para PANEL_SECRET_KEY)' : 'No encontrada'}`);
  console.log('==============================================================');
  console.log('  Próximos pasos (después de vincular tu sitio en Netlify):');
  console.log('  1) Subir datos a Netlify Blobs:');
  console.log('     npx netlify blobs:set panel-reparto-data state data/netlify-seed.json');
  console.log('  2) Configurar PANEL_SECRET_KEY en Netlify (Variables de entorno, marcado como Secret)');
  console.log('     copiando el contenido de data/.secret (NO lo subas a GitHub).');
  console.log('==============================================================');
}

main();
