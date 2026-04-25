@echo off
REM =============================================
REM AIPickd — n8n Local Startup Script
REM =============================================

cd /d "C:\Users\guada\Downloads\Negocio\n8n-local"

echo.
echo ============================================
echo   AIPickd - n8n Startup
echo ============================================
echo.
echo Iniciando n8n desde: %cd%
echo.
echo NOTA IMPORTANTE:
echo - n8n corre en: http://localhost:5678
echo - Manten esta ventana ABIERTA mientras uses n8n
echo - Si cierras esta ventana, n8n se detiene
echo.
echo Para detener n8n: Ctrl+C en esta ventana
echo.
echo ============================================
echo.

REM Configurar encriptación key (para persistencia de credentials)
set N8N_ENCRYPTION_KEY=aipickd_enc_key_2026_guadarrama_secret
set N8N_USER_FOLDER=%USERPROFILE%\.n8n
set N8N_PORT=5678
set N8N_PROTOCOL=http
set N8N_HOST=localhost

REM Iniciar n8n desde el install local
call npx n8n start

pause
