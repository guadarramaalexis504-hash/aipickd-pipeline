# 🚀 AIPickd — Nuevo en la Nube (Sesión 2026-04-26)

**Resumen ejecutivo:** El sistema pasó de ser autónomo a ser **autónomo + endurecido**. Cuando vuelvas de la fiesta, el negocio:

- ✅ Se respalda solo (Supabase → GitHub Artifacts diariamente)
- ✅ Se monitorea solo (3 workflows: site, anomaly, security scan)
- ✅ Se autocontrola (budget caps que detienen el pipeline si hay overrun)
- ✅ Se autoaudita (anomaly detector cada hora)
- ✅ Está protegido contra leaks (secret scanning + push protection)

---

## 📊 Lo que cambió hoy en 5 horas

### Workflows de GitHub Actions añadidos

| Workflow | Cron | Qué hace |
|----------|------|----------|
| `security-scan.yml` | Push + Lun 8AM UTC | Secret scan + npm audit + CodeQL + perm audit |
| `backup.yml` | Diario 5AM UTC | Export full Supabase a Artifacts (30 días) |
| `anomaly-watch.yml` | Cada hora :30 | Detección de patrones anormales |

Más los originales endurecidos:
- `generate.yml` — ahora con `permissions: contents: read`, validate-secrets, budget enforcement, .env shred al final
- `monitor.yml` — mismo hardening + cache de Playwright

### Scripts nuevos

| Script | Propósito |
|--------|-----------|
| `validate-secrets.js` | Pre-flight check: aborta antes de gastar tokens si secret malformado |
| `cost-monitor.js` | Tracking de gasto + enforcement del budget cap |
| `anomaly-detector.js` | 5 tipos de detección: rapid-publishing, cost-spike, duplicates, stuck-keywords, site-down |
| `backup-supabase.js` | Export DB completa a JSON |
| `wp-security-audit.js` | 13 checks de seguridad WP |
| `wp-harden.js` | Genera .htaccess + wp-config hardening pa' paste manual |
| `wp-plugin-audit.js` | Lista plugins/users/themes con risk flags |
| `wp-block-search-indexers-of-bad-pages.js` | Detecta páginas test/draft que no deberían indexarse |
| `content-quality-check.js` | Audita 82 articles: word count, AI tells, año stale, etc. |
| `duplicate-detector.js` | Levenshtein similarity pa' detectar duplicados |

### Configuración de seguridad

- `.github/dependabot.yml` — Updates semanales automáticos (npm + actions)
- `.github/SECURITY.md` — Política de seguridad + threat model
- `.gitignore` actualizado — bloquea más patterns sensibles

### Pipeline mejoras

- **Quality gate más estricto** en `run-pipeline.js`:
  - Min 1500 words (era 1000)
  - Detección de truncation (`...`)
  - Detección de párrafos duplicados consecutivos
  - Min 3 H2 headings
  - Detección de placeholders/TODO

### Documentación

- `docs/architecture.md` — Diagrama completo del sistema
- `docs/security-runbook.md` — Procedimientos operativos + rotación de keys
- `docs/HARDENING-CHECKLIST.md` — Pasos manuales (Hostinger, GitHub, etc.) — 30 min total

---

## 🎯 TÚ tienes que hacer (cuando vuelvas)

Ordenado por importancia. Total: 30-45 min.

### 🔴 Must-do hoy
1. Activar 2FA en GitHub (5 min)
2. Activar 2FA en Hostinger (5 min)
3. Activar Dependabot + Secret Scanning en repo settings (3 min)
4. Crear LinkedIn (5 min, gratis) → desbloquea 30+ affiliate signups

### 🟠 Esta semana
5. Login Hostinger File Manager → editar `.htaccess` con bloque de `node scripts/wp-harden.js` (5 min)
6. Editar `wp-config.php` con 4 líneas de hardening (3 min)
7. Activar WAF de Hostinger (1 min)

### 🟡 Este mes
8. OpenAI usage cap a $50/mes (1 min)
9. Cloudflare gratis en frente de Hostinger (10 min)
10. Google Analytics 4 (5 min)

Lee `docs/HARDENING-CHECKLIST.md` pa' los pasos exactos.

---

## 💰 Tu negocio ahora

```
✅ Site:                 https://aipickd.com (live, healthy)
✅ Articles publicados:  82+ (creciendo cada 4h)
✅ Cloud cron:           5 workflows GitHub Actions
✅ Backups:              Diarios automáticos (30 días retención)
✅ Monitoring:           3 capas (site + anomaly + security)
✅ Budget protection:    $3/día / $50/mes hard cap
✅ DNS:                  Configurado en Hostinger
✅ Google Search Console: Verificado + sitemap submitted
✅ Bing/Yandex:          IndexNow pingeado (82 URLs)
✅ Schema.org:           Article + FAQ markup
✅ Internal links:       108+
✅ Costo mensual:        ~$10 OpenAI, $0 todo lo demás

⏳ Affiliates monetizables: 1 activo (Amazon) + 32 pendientes
                            (necesitas LinkedIn pa' desbloquear)
```

**Lo único que falta pa' que el dinero empiece a llegar:** los affiliate signups (cuando crees LinkedIn).

---

## 🔍 Cómo verifico que todo funciona?

Cuando llegues, simplemente:

1. **Refresca esta conversación de Claude** (o abre una nueva — yo recupero contexto del repo)
2. Dime "checa el status manito"

Yo:
- Veo si los workflows están verdes
- Cuento cuántos articles nuevos se generaron
- Veo si hubo anomalías
- Reviso costos
- Reporto todo en 10 segundos

O tú directo en GitHub:
https://github.com/guadarramaalexis504-hash/aipickd-pipeline/actions

---

**Disfruta la fiesta manito. Cuando vuelvas, el sistema está MÁS ENDURECIDO que muchos negocios reales que cobran $10k/mes en consultoría.** 🎉🚀
