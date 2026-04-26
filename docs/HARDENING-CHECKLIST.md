# 🛡️ AIPickd — Hardening Checklist

**Tiempo total:** ~30 min para hacer TODO esto.

Cuando termines este checklist completo, tu negocio está endurecido **al máximo nivel** que se puede sin pagar servicios extra.

---

## 🔴 CRÍTICO — Hazlo HOY (10 min)

### 1. 2FA en todas las cuentas

- [ ] **GitHub** → https://github.com/settings/security → "Two-factor authentication" → Enable
- [ ] **Hostinger** → https://hpanel.hostinger.com/profile/security → 2FA via app (Google Authenticator)
- [ ] **Google** (gmail) → https://accounts.google.com/security → "2-Step Verification"
- [ ] **OpenAI** → https://platform.openai.com/account/security → MFA on
- [ ] **Supabase** (si lo prefieres) → Profile → Security
- [ ] **Anthropic** → console.anthropic.com → Settings → Security

### 2. Activar GitHub security features

Ve a https://github.com/guadarramaalexis504-hash/aipickd-pipeline/settings/security_analysis y activa:

- [ ] **Dependency graph** ✓
- [ ] **Dependabot alerts** ✓
- [ ] **Dependabot security updates** ✓
- [ ] **Secret scanning** ✓
- [ ] **Push protection** ✓ (bloquea push si detecta un secret)
- [ ] **Code scanning** (CodeQL) → "Set up" → "Default"

### 3. Branch protection (impide pushes accidentales)

GitHub repo → Settings → Branches → Add rule:
- Branch name pattern: `main`
- ✓ Require a pull request before merging
- ✓ Require status checks to pass before merging:
  - `secret-scan`
  - `dep-audit`
  - `codeql`
  - `workflow-permissions-audit`
- ✓ Do not allow bypassing the above settings

---

## 🟠 ALTO — Hazlo esta semana (15 min)

### 4. WordPress hardening via .htaccess

1. Login Hostinger hPanel → File Manager → public_html
2. Edita `.htaccess` (si no existe, créalo)
3. Pega al **principio** del archivo el bloque que genera:
   ```bash
   node scripts/wp-harden.js
   ```
   (cópialo de la salida del script)

4. Save. Verifica visitando https://aipickd.com/xmlrpc.php → debe dar 403

### 5. WordPress wp-config.php hardening

1. Hostinger File Manager → public_html
2. Edita `wp-config.php`
3. Antes de la línea `/* That's all, stop editing! */` agrega:
   ```php
   define('DISALLOW_FILE_EDIT', true);
   define('FORCE_SSL_ADMIN', true);
   define('WP_AUTO_UPDATE_CORE', 'minor');
   ```
4. Save
5. Verifica: WP Admin → Appearance → Theme File Editor → debe estar oculto

### 6. Hostinger WAF + SSL

1. hPanel → Security → Web Application Firewall → ON
2. hPanel → Security → SSL → Force HTTPS = ON
3. hPanel → Security → Hotlink Protection → ON

### 7. Username admin cambio

1. WP Admin → Users → All Users
2. Si tu username login es "admin" o "administrator" — créa un user nuevo (Admin role) con username random
3. Logout
4. Login con el nuevo
5. Borra el user "admin" antiguo (asigna sus posts al nuevo)

---

## 🟡 MEDIO — Hazlo este mes (5 min)

### 8. OpenAI usage cap

1. https://platform.openai.com/account/limits
2. Set hard limit: **$50/mes** (debería estar suficiente con cap del pipeline)
3. Set soft limit: **$25/mes** (te alerta a ese punto)
4. Email alerts: ON

### 9. Google Analytics 4 (cuando empieces a tener tráfico)

1. analytics.google.com → Create property → aipickd.com
2. Copia el measurement ID (G-XXXXXXX)
3. WP Admin → WPCode Lite → Add snippet:
   ```html
   <!-- Google Analytics 4 -->
   <script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXX"></script>
   <script>
     window.dataLayer = window.dataLayer || [];
     function gtag(){dataLayer.push(arguments);}
     gtag('js', new Date());
     gtag('config', 'G-XXXXXXX');
   </script>
   ```
4. Set: location = "Header", auto-insert = ON, status = Active

### 10. Google Search Console alerts

1. search.google.com/search-console → tu propiedad aipickd.com
2. Settings → Users and permissions → asegúrate solo tú tienes acceso
3. Settings → Property settings → Email preferences → ✓ alerts on

### 11. Microsoft Clarity (heatmaps gratis)

1. clarity.microsoft.com → Add new project → aipickd.com
2. Copia el script
3. WPCode Lite → Add snippet → Header → Save
4. Esperas 24h y ya ves cómo navegan los usuarios

---

## 🔵 BAJO — Si te queda tiempo (10 min)

### 12. Cloudflare en frente de Hostinger (FREE tier)

1. cloudflare.com → Sign up → Add Site → aipickd.com → Free plan
2. Cloudflare detecta tus DNS records actuales — confirma
3. Cloudflare te da 2 nameservers (ej: `bob.ns.cloudflare.com`)
4. Hostinger Domain settings → cambiar nameservers a los de Cloudflare
5. Espera 5-30 min que propague
6. En Cloudflare → SSL/TLS → Full
7. En Cloudflare → Speed → Auto Minify → CSS/JS/HTML
8. En Cloudflare → Caching → Caching Level: Standard
9. En Cloudflare → Security → Bot Fight Mode: ON

**Beneficio:** DDoS protection + 30-50% más rápido + WAF gratis.

### 13. Discord/Telegram alerts

Para que te avise cuando algo se rompa:

**Discord:**
1. Crea un server tuyo en Discord (gratis)
2. Channel settings → Integrations → Webhooks → New Webhook
3. Copia la URL
4. GitHub → repo → Settings → Secrets → Add `DISCORD_WEBHOOK_URL`
5. Listo — los workflows ya alertan ahí

**Telegram:**
1. En Telegram busca @BotFather → /newbot → sigue instrucciones
2. Te da un Token + chat ID
3. GitHub Secrets → Add `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`

### 14. Auto-rotate keys (cada 90 días)

Crea un calendario recurrente en Google Calendar:
- "Rotar OpenAI API key" — cada 90 días
- "Rotar WP password" — cada 90 días
- "Rotar Supabase service_role" — cada 180 días

---

## ✅ Verificación final

Después de todo, corre:

```
node scripts/wp-security-audit.js
node scripts/wp-plugin-audit.js
```

Debes ver:
- 0 critical
- 0 high
- 0-2 medium (algunos requieren plugins extra)
- 0-3 low

Si tienes >0 high después de aplicar todo arriba: avísame y lo arreglamos.

---

## 📞 Si algo se rompe

1. **No entres en pánico** — la mayoría de configs son reversibles
2. Si rompes el .htaccess → File Manager → renombra a `.htaccess.broken` → site vuelve
3. Si rompes wp-config.php → undo lo que pegaste, save → site vuelve
4. Si rompes Cloudflare → vuelve nameservers a los de Hostinger
5. Si bloqueaste tu propio admin → File Manager → renombra el plugin que esté bloqueando

Y si nada funciona: hPanel chat support tiene staff 24/7 y son rápidos.

---

**Cuando termines este checklist, AIPickd está endurecido al nivel profesional. Bueno para hasta 100k visitas/mes sin problema.**
