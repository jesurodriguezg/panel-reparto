@echo off
cd /d "%~dp0"
title Panel de Reparto - Motos Alfa
echo ===================================================
echo   PANEL DE REPARTO - MOTOS ALFA (HERO MOTOCORP)
echo ===================================================
echo.
if not exist "server\index.js" (
    echo [IMPORTANTE] Primero debes EXTRAER / DESCOMPRIMIR toda la carpeta del archivo ZIP.
    echo No ejecutes iniciar.bat desde adentro del archivo .zip comprimido.
    pause
    exit /b 1
)
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js no esta instalado en este equipo.
    echo Descargalo desde https://nodejs.org/ e intenta de nuevo.
    pause
    exit /b 1
)
if not exist "node_modules" (
    echo Verificando dependencias opcionales...
    call npm install --no-audit --no-fund
    if %errorlevel% neq 0 (
        echo [AVISO] Continuando con el motor nativo de Node.js incorporado...
    )
)
echo.
echo Iniciando servidor y abriendo http://localhost:3000 en tu navegador...
node server\index.js
pause
