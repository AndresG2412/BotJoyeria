@echo off
title Iniciador del Bot de WhatsApp
echo ========================================================
echo   Ejecutor del Bot (Para VPS Windows)
echo ========================================================
echo.

IF NOT EXIST "node_modules\" (
    echo [*] Primera ejecucion detectada. 
    echo Procediendo a instalar dependencias por primera vez...
    call npm install
    echo.
)

echo [*] Compilando el codigo para aplicar los ultimos cambios...
call npm run build
echo.

echo [*] Iniciando el Bot de WhatsApp en primer plano...
echo Recuerda NO cerrar esta ventana negra.
echo.
node dist/app.js

pause
