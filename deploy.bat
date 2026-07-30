@echo off
echo ==============================================
echo   Bot de Ecommerce - Autodespliegue a VPS
echo ==============================================

:: ====================================
:: VARIABLES (Edita esto con tus datos)
:: ====================================
set VPS_USER=root
set VPS_IP=tu_direccion_ip_vps
set REPO_PATH=/ruta/a/tu/repositorio/en/el/vps/ecommerce-bot

echo.
echo [1] Subiendo tus cambios locales a GitHub...
git add .
git commit -m "Autodespliegue a VPS"
git push origin main

echo.
echo [2] Conectando a tu servidor VPS por SSH y desplegando cambios...
:: Este comando se conecta a tu VPS, baja el código de la rama main, instala nuevos paquetes de ser necesario, compila y reinicia el proceso del bot de WhatsApp.
ssh %VPS_USER%@%VPS_IP% "cd %REPO_PATH% && git pull origin main && npm install && npm run build && pm2 restart whatsapp-bot --update-env"

echo.
echo ==============================================
echo   Despliegue finalizado exitosamente!
echo ==============================================
pause
