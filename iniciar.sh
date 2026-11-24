#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "==================================================="
echo "  PANEL DE REPARTO - MOTOS ALFA (HERO MOTOCORP)"
echo "==================================================="

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js no está instalado. Instala Node.js 20+ desde https://nodejs.org/"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Instalando dependencias..."
  npm install --no-audit --no-fund || echo "[AVISO] Continuando con el motor nativo de Node.js incorporado..."
fi

exec node server/index.js
