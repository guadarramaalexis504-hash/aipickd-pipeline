#!/bin/bash
# =============================================
# AIPickd — n8n Local Startup Script (Linux/Mac/WSL)
# =============================================

echo "============================================"
echo "  AIPickd - n8n Startup"
echo "============================================"
echo ""
echo "Iniciando n8n..."
echo ""
echo "n8n corre en: http://localhost:5678"
echo "Ctrl+C pa' detener"
echo ""

export N8N_ENCRYPTION_KEY="aipickd_enc_key_2026_guadarrama_secret"
export N8N_USER_FOLDER="$HOME/.n8n"
export N8N_PORT=5678
export N8N_PROTOCOL=http
export N8N_HOST=localhost

n8n start
