# 🌥️ AIPickd — Migración a la Nube (Lap se puede apagar 24/7)

**Tiempo total tuyo: 10 min**
**Costo: $0/mes** (GitHub Actions free tier)

Después de esto el sistema corre solo en servidores de GitHub. **Tu lap puede estar apagada todo el día** y siguen publicándose artículos cada 4 horas.

---

## 🎯 Lo que necesitas hacer (3 pasos)

### PASO 1: Crear cuenta de GitHub (3 min) — si ya tienes, salta

1. Ve a https://github.com/signup
2. Email: `guadarramaalexis504@gmail.com`
3. Password: **diferente de las otras** (anótala)
4. Username sugerido: `aguadarrama-aipickd`
5. Verifica el email

### PASO 2: Crear repositorio privado (2 min)

1. Ya logueado en GitHub → click en `+` arriba derecha → "New repository"
2. **Repository name:** `aipickd-pipeline`
3. **Privado** (importante pa' que nadie vea tu código)
4. **NO marques** "Add README", "Add .gitignore" — los dejamos vacíos
5. Click "Create repository"
6. **Te muestra una página con instrucciones** — déjala abierta

### PASO 3: Subir el código + secretos (5 min)

#### 3A — Subir código

**Yo ya inicialicé el repo y hice el commit inicial.** Solo falta conectarlo a GitHub:

Abre PowerShell en `C:\Users\guada\Downloads\Negocio` y corre (cambia USERNAME por el tuyo de GitHub):

```powershell
git remote add origin https://github.com/USERNAME/aipickd-pipeline.git
git push -u origin main
```

Te va a pedir login → usa **Personal Access Token** (no password):
- En GitHub: Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token
- Permisos: marca "repo" (todo)
- Copia el token, úsalo como password al pushear

#### 3B — Configurar secretos

En tu repo de GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Agrega estos 6 secretos (copy-paste exacto desde tu `.env`):

| Nombre del secreto | Valor |
|--------------------|-------|
| `SUPABASE_URL` | `https://dfftywgdvntnkybffnui.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | (el valor de tu .env) |
| `OPENAI_API_KEY` | (el valor de tu .env) |
| `ANTHROPIC_API_KEY` | (el valor de tu .env, o vacío) |
| `WP_USERNAME` | (el valor de tu .env) |
| `WP_ADMIN_PASSWORD` | (el valor de tu .env) |

**Tip:** abre `.env` en notepad pa' copy-paste. NO commitees el .env (`.gitignore` ya lo excluye).

---

## ✅ Verificar que funciona

1. En GitHub → tu repo → **Actions** tab
2. Click "AIPickd Auto-Generation"
3. Click **"Run workflow"** → deja default → "Run workflow"
4. Espera 3-5 min → deberías ver ✅ verde + nuevo artículo en https://aipickd.com

Si funciona ese manual run, el cron automático cada 4h ya está activo.

---

## 📅 Schedule activado

Una vez subido:

| Workflow | Cuándo corre |
|----------|--------------|
| `generate.yml` | Cada 4 horas (automático) |
| `monitor.yml` | Cada 1 hora (automático) |

Resultado:
- **6 artículos por día** (cap 1 por run × 6 runs/día)
- **24 monitorings de site por día**
- Te llega notificación si algo se rompe (cuando configures Discord/Telegram)

---

## 💰 Costo

- GitHub Actions: **$0/mes** (free tier: 2000 min/mo, usamos ~540 min)
- OpenAI API: ~$10/mes (6 artículos × 30 días × $0.05)
- Supabase: $0 (free tier suficiente)
- Hostinger: ya pagado
- **Total operating: ~$10/mes**

---

## 🔄 Si quieres MÁS artículos (24/7 sin pausa)

Alternativa: **Railway** ($5 free credit/mes = always-on):
1. https://railway.app/new → Deploy from GitHub repo
2. Add env variables (mismos secretos)
3. Set start command: `node scripts/generate-forever.js --max-cost 4`
4. Reinicia automático cuando termina

Eso te da ~80 artículos/día por $5/mes. Pero antes de eso, GitHub Actions ya es suficiente pa' ranking.

---

## 🚨 Importante: APAGAR el local

Una vez en la nube, **apaga el Task Scheduler local** pa' no duplicar:

```powershell
# En PowerShell admin:
Disable-ScheduledTask -TaskName "AIPickd-Pipeline"
```

(O lo dejas activo si quieres redundancia — no hace daño, los keywords se asignan exclusivamente.)

---

## ❓ Si algo falla

Cualquier error en GitHub Actions sale en el tab "Actions" → click el run rojo → ves los logs.

Avísame cuando hayas creado la cuenta y haya pusheado código — yo verifico que todo esté correcto y te ayudo a debuggear lo que sea necesario.

**Después de esto, el negocio corre 100% en la nube. Tu lap es opcional.** 🚀
