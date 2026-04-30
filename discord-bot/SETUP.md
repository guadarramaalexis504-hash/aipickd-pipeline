# AIPickd Discord Bot — Setup en 10 minutos

## Paso 1: Crear el bot en Discord (5 min)

1. Ve a https://discord.com/developers/applications
2. Click **"New Application"** → nombre: "AIPickd Bot"
3. En el menú izquierdo → **Bot**
4. Click **"Add Bot"** → confirmar
5. En **"Privileged Gateway Intents"** activa:
   - ✅ SERVER MEMBERS INTENT
   - ✅ MESSAGE CONTENT INTENT
6. Click **"Reset Token"** → copia el token → guárdalo (es tu DISCORD_BOT_TOKEN)
7. En el menú → **OAuth2 → URL Generator**:
   - Scopes: ✅ bot
   - Bot Permissions: ✅ Send Messages, ✅ Read Message History, ✅ View Channels, ✅ Read Messages/View Channels
8. Copia la URL generada y ábrela para invitar el bot a tu servidor de AIPickd

## Paso 2: Crear canal en Discord (1 min)

En tu servidor de AIPickd, crea un canal llamado **#claude-bot**
El bot responderá automáticamente a todos los mensajes ahí.
También puedes @mencionar al bot en cualquier otro canal.

## Paso 3: Deploy en Railway (5 min)

1. Ve a https://railway.app y entra con GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Selecciona el repo de aipickd-pipeline → carpeta `discord-bot`
   (o crea un repo separado solo con la carpeta discord-bot)
4. En **Variables**, agrega estas env vars:

```
DISCORD_BOT_TOKEN=tu_token_del_paso_1
ANTHROPIC_API_KEY=sk-ant-api03-...   (del .env)
ANTHROPIC_MODEL=claude-opus-4-5
SUPABASE_URL=https://dfftywgdvntnkybffnui.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...     (del .env)
```

5. Railway detecta el railway.toml y despliega solo
6. El bot debería aparecer online en Discord en ~2 minutos

## Costo estimado

- Railway free tier: 500 horas/mes → suficiente para 24/7 (con el plan Starter a $5/mes si necesitas más)
- Claude API: ~$0.01-0.05 por conversación con claude-opus-4-5
- Total estimado: $0-5/mes dependiendo de uso

## Cómo usar el bot

Escríbele en #claude-bot o @mencionalo:

- "¿Cuántos artículos tenemos?" → te da stats del pipeline
- "¿Cuánto hemos gastado este mes?" → costos con proyección
- "¿Qué artículos publicamos hoy?" → lista artículos recientes
- "Dame 10 ideas de keywords para AI writing tools" → brainstorm
- "Cómo aplico a Jasper en PartnerStack?" → te guía paso a paso
- "El pipeline falló, qué hago?" → troubleshooting
- Cualquier pregunta sobre el negocio, SEO, afiliados, etc.

## Canales donde el bot responde automáticamente

Cualquier canal cuyo nombre contenga: `claude`, `bot`, `aipickd-ai`, `asistente`

En otros canales, solo responde cuando lo @mencionas.
