# 🔒 AIPickd — Security Runbook

**Última actualización:** 2026-04-26

Esta es la guía operativa de seguridad de AIPickd. Manténla actualizada cuando agregues servicios o cambies passwords.

---

## 🎯 Postura general

AIPickd usa **defensa en profundidad** con 4 capas:

1. **GitHub** (código fuente + secretos cifrados)
2. **Hostinger** (hosting + LiteSpeed firewall)
3. **WordPress** (admin con miniOrange Basic Auth)
4. **Pipeline** (scripts con validación + budget caps)

Si una capa falla, las otras 3 siguen protegiendo.

---

## 🔑 Inventario de credenciales

| Credencial | Dónde se guarda | Rotación recomendada | Si se compromete |
|------------|-----------------|----------------------|------------------|
| OpenAI API key | `.env` local + GitHub Secret | 90 días | platform.openai.com → revocar + regenerar |
| Anthropic API key | `.env` local + GitHub Secret | 90 días | console.anthropic.com → revocar + regenerar |
| Supabase service_role | `.env` local + GitHub Secret | 180 días | supabase.com → Settings → API → Reset |
| WP admin password | `.env` local + GitHub Secret | 90 días | aipickd.com/wp-admin → Users → Edit Profile → Set new |
| Hostinger hPanel password | Solo en tu cabeza/manager | 180 días | hostinger.com → forgot password |
| Google account password | Solo en tu cabeza/manager | 180 días | accounts.google.com |
| GitHub password | Solo en tu cabeza/manager | 180 días | github.com/settings/security |
| Discord webhook URL | `.env` local + GitHub Secret | Cuando sea | Discord → server settings → integrations → delete & recreate |

**Regla de oro:** si lo escribiste en código → ya está comprometido.

---

## 🛡️ Auditorías automáticas

| Script / Workflow | Cuándo corre | Qué revisa |
|-------------------|--------------|-----------|
| `scripts/wp-security-audit.js` | Manual | 13 vectores de ataque WP |
| `scripts/wp-plugin-audit.js` | Manual | Plugins instalados + users |
| `scripts/anomaly-detector.js` | Cada hora (anomaly-watch.yml) | Patrones de comportamiento anormal |
| `scripts/cost-monitor.js --enforce` | Antes de cada generation (generate.yml) | Budget cap |
| `.github/workflows/security-scan.yml` | Cada push + Lunes 8AM UTC | Secret scan + npm audit + CodeQL |
| `scripts/duplicate-detector.js` | Manual | Contenido duplicado |
| `scripts/content-quality-check.js` | Manual | Calidad de articles |

---

## 🚨 Procedimientos de incidente

### Si crees que un secret se filtró

1. **Inmediatamente** rota el secret en su servicio de origen:
   - OpenAI: https://platform.openai.com/api-keys → Revoke
   - Supabase: Settings → API → Reset service_role
   - WP: Cambia password admin
2. Actualiza el GitHub Secret correspondiente
3. Actualiza `.env` local
4. Si fue commiteado: el rebase NO es suficiente, la rotación SÍ
5. Revisa los últimos charges/usage en cada plataforma

### Si el sitio está caído

1. Revisa el workflow `monitor.yml` en GitHub Actions
2. Si dice 5xx → revisa hPanel → "Site issues"
3. Si dice 4xx → revisa LiteSpeed cache, purgar
4. Si está bien pero el pipeline falla → revisa GitHub Actions logs

### Si el pipeline genera basura/spam

1. **Inmediatamente** desactiva el workflow:
   - GitHub → Actions → AIPickd Auto-Generation → "..." → Disable workflow
2. Audita los últimos articles publicados:
   ```
   node scripts/content-quality-check.js --severity high
   ```
3. Borra los malos via WP Admin
4. Investiga la causa antes de reactivar

### Si recibes alerta del anomaly-detector

1. Revisa el log del workflow en GitHub Actions
2. Si es "rapid-publishing": revisa si alguien ejecutó muchos `--gen N`
3. Si es "cost-spike": revisa el modelo OpenAI usado (¿cambió a gpt-4?)
4. Si es "site-unreachable": revisa Hostinger
5. Si es "duplicate-articles": pausa el pipeline + investiga

---

## 🔐 Hardening pendiente (manual)

Estas cosas requieren tu acción una vez:

### Hostinger hPanel
- [ ] **2FA activo** en https://hpanel.hostinger.com/profile/security
- [ ] **WAF activado** en hPanel → Security → Web Application Firewall
- [ ] **SSL forzado** en hPanel → SSL → Force HTTPS = ON
- [ ] **.htaccess endurecido** (paste el bloque de `node scripts/wp-harden.js`)

### GitHub
- [ ] **2FA activo** en https://github.com/settings/security
- [ ] **Branch protection** en repo → Settings → Branches → main:
  - Require pull request reviews
  - Require status checks (security-scan workflow)
  - No bypass for admins
- [ ] **Secret scanning + push protection** en repo → Settings → Code security
- [ ] **Dependabot alerts + security updates** activos

### WordPress
- [ ] **Disable file editing** en wp-config.php:
  ```php
  define('DISALLOW_FILE_EDIT', true);
  define('FORCE_SSL_ADMIN', true);
  define('WP_AUTO_UPDATE_CORE', 'minor');
  ```
- [ ] Auto-updates de plugins activos
- [ ] Username admin NO es "admin" o "administrator"

### Google account (admin de todo)
- [ ] **2FA activo** en accounts.google.com
- [ ] **Recovery email + phone** configurados
- [ ] **Security checkup** completo: g.co/securitycheckup

### Servicios externos
- [ ] **OpenAI**: usage limits configurados en platform.openai.com (max $50/mes)
- [ ] **Anthropic**: usage limits si aplica
- [ ] **Supabase**: revisar RLS policies (si llegas a 100k+ rows)

---

## 🔄 Rutina semanal (5 min)

Cada lunes:
1. Abre GitHub Actions → revisa que todos los workflows pasaron
2. Corre `node scripts/wp-security-audit.js` localmente
3. Corre `node scripts/cost-monitor.js` para ver gasto
4. Revisa Dependabot PRs y mergea las que pasen los checks
5. Mira las articles publicadas la semana, elimina las que no quieras

## 🔄 Rutina mensual (15 min)

Cada primer lunes del mes:
1. Todo lo de la rutina semanal
2. `node scripts/content-quality-check.js --severity high` → fix worst
3. `node scripts/duplicate-detector.js` → resolve dupes
4. Revisa gasto OpenAI total del mes
5. Verifica plugins WP up-to-date
6. Cambia Discord/Telegram webhook si han pasado >90 días

## 🔄 Rutina trimestral (30 min)

Cada 3 meses:
1. Rota OpenAI API key + Anthropic key
2. Rota WP admin password
3. Cambia Discord webhook
4. Revisa quién tiene acceso a la cuenta de Hostinger/GitHub

---

## 📞 Contactos de emergencia

- Hostinger: support en hpanel chat
- OpenAI: help.openai.com
- Anthropic: support@anthropic.com
- Supabase: support en dashboard
- GitHub: support.github.com

---

**Si encuentras un problema de seguridad serio:**
1. NO lo discutas en repos públicos
2. NO postees en Discord/redes
3. Sigue el procedimiento de incidente arriba
4. Documenta lo que pasó en este archivo
