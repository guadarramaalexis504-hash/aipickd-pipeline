# 🤖 AIPickd — Autonomous Affiliate Blog

**Status:** ✅ Production-ready (cloud-hosted, hardened) as of 2026-04-26
**Live site:** https://aipickd.com
**Monetization:** Affiliate programs (Amazon active, 32 more pending)

> **Si estás leyendo esto por primera vez:** [`docs/NUEVO-EN-LA-NUBE.md`](./docs/NUEVO-EN-LA-NUBE.md)
> **Para hardening manual:** [`docs/HARDENING-CHECKLIST.md`](./docs/HARDENING-CHECKLIST.md)
> **Para arquitectura:** [`docs/architecture.md`](./docs/architecture.md)
> **Para security ops:** [`docs/security-runbook.md`](./docs/security-runbook.md)

---

## 🎯 Qué hace este negocio

Blog de reseñas honestas y comparativas de herramientas de IA y SaaS. Contenido generado por GPT-4o, publicado automáticamente a WordPress, monetizado por links de afiliado en cada artículo.

**Proyección:** $0-80/mo (mes 1) → $2-6k/mo (mes 6) → $5-15k/mo (año 1).

---

## 🏗️ Arquitectura (cloud-native desde 2026-04-26)

Ver [`docs/architecture.md`](./docs/architecture.md) para diagrama completo. TL;DR:

```
GitHub Actions (cron)  ──>  Pipeline  ──>  Supabase + OpenAI + WordPress
   ↓                                              ↓
   5 workflows (generate, monitor,         aipickd.com (live)
   anomaly, backup, security-scan)
```

**Stack:**
- **Orchestration:** GitHub Actions (5 workflows, cron-based)
- **Content gen:** OpenAI GPT-4o (multi-pass ~2500 words) + DALL-E 3 images
- **Database:** Supabase Postgres (free tier)
- **Publishing:** WordPress on Hostinger + miniOrange Basic Auth REST
- **Domain:** Namecheap aipickd.com ($11/yr) + DNS via Hostinger
- **Backups:** Daily Supabase export → GitHub Artifacts (30 days)
- **Monitoring:** Hourly site check + hourly anomaly detection
- **Budget protection:** $3/day, $50/month hard caps (enforced pre-spend)

**Cost:** ~$5/mo hosting + ~$10/mo AI = **~$15/mo operating cost**.

---

## 🔒 Security posture

This repo includes:
- ✅ Dependabot for npm + GitHub Actions
- ✅ CodeQL static analysis on every push
- ✅ Secret scanning + push protection
- ✅ All workflows: minimal `permissions: contents: read`
- ✅ All workflows shred `.env` on exit
- ✅ Concurrency control (no race on keyword queue)
- ✅ Pinned action versions (Dependabot updates)
- ✅ `npm ci --ignore-scripts` (no malicious postinstall)

See [`docs/security-runbook.md`](./docs/security-runbook.md) for incident response.

---

## 🚀 Scripts

| Script | Purpose | Frequency |
|--------|---------|-----------|
| `scripts/run-pipeline.js` | ⭐ Main orchestrator (gen + publish) | Every 4h |
| `scripts/generate-long-article.js` | Multi-pass long-form generator | As needed |
| `scripts/publish-one-article.js` | Single article publisher | Debug |
| `scripts/publish-all-live.js` | Flip all drafts to LIVE | When ready |
| `scripts/generate-dashboard.js` | Build `dashboard.html` | On demand |
| `scripts/health-check.js` | Verify all services work | Anytime |
| `scripts/fix-wrong-year.js` | Fix 2023/2024/2025 → 2026 | Maintenance |
| `scripts/strip-unreplaced-affiliate-tags.js` | Clean `[AFFILIATE:..]` tags | Maintenance |
| `scripts/approve-affiliate.js <brand> <url>` | Activate an affiliate | When approved |
| `scripts/regenerate-affiliate-links.js` | Backfill links in old articles | After approvals |
| `scripts/create-legal-pages.js` | Re-create 5 legal pages | One-time |
| `scripts/create-homepage.js` | Rebuild homepage | If corrupted |
| `scripts/setup-wp-categories.js` | Create WP categories | One-time |
| `scripts/run-pipeline.bat` | Task Scheduler entry | Called by Windows |
| `scripts/notify.js` | Send Discord + Telegram notifications | Auto (on publish) |
| `scripts/email-digest.js` | Weekly email report | Weekly |
| `scripts/social-autopost.js` | Auto-post to X + Pinterest | Auto (on publish) |
| `scripts/ollama-generate.js` | FREE article gen via local Llama 3.1 | Manual/scheduled |
| `scripts/monitor-site.js` | Playwright health check (load time, errors) | Hourly |
| `scripts/check-rankings.js` | Track Google positions week-over-week | Weekly |
| `scripts/install-power-user.ps1` | Install Playwright + Ollama + Llama 8B | One-time |
| `scripts/review-and-publish-drafts.js` | QA + publish drafts | Manual |
| `scripts/force-clean-and-publish.js` | Aggressive cleanup + publish | Manual |
| `docs/setup-google-search-console.md` | GSC setup guide | One-time |
| `docs/setup-cloudflare.md` | Cloudflare CDN guide | One-time |

---

## 📋 Typical commands

```bash
# Check everything works
node scripts/health-check.js

# Generate 1 article and publish all drafts
node scripts/run-pipeline.js

# Generate 5 articles
node scripts/run-pipeline.js --gen 5

# Long-form multi-pass (better quality, 2500 words)
node scripts/generate-long-article.js --gen 3

# See current state
node scripts/generate-dashboard.js
# Then open dashboard.html in browser

# Flip all drafts to live (preview first)
node scripts/publish-all-live.js           # dry run
node scripts/publish-all-live.js --go      # actually publish

# After getting affiliate approvals:
node scripts/approve-affiliate.js "Jasper" "https://jasper.ai/?fp_ref=your_id"
node scripts/regenerate-affiliate-links.js --go  # backfill into old articles
```

---

## 📁 Project structure

```
Negocio/
├── README.md                           ← you are here
├── ESTADO-FINAL.md                     ⭐ START HERE after waking up
├── dashboard.html                      ← live metrics (open in browser)
├── .env                                ← credentials (NEVER COMMIT)
│
├── scripts/                            ← all automation
│   ├── run-pipeline.js                 ⭐ main orchestrator
│   ├── generate-long-article.js        ⭐ multi-pass generator
│   ├── run-pipeline.bat                ← Task Scheduler entry
│   ├── setup-task-scheduler.md         ⭐ 1-min GUI guide
│   └── [other helpers...]
│
├── docs/
│   ├── afiliados-guia-completa.md      ⭐ copy-paste para aplicar
│   ├── como-operar-sin-rfc.md          fiscal México
│   ├── revenue-projections.md
│   ├── niche-strategy.md
│   └── keywords-*.md
│
├── content-bank/                       ← 5 artículos originales
├── supabase/schema.sql                 ← DB schema
├── wordpress/                          ← WP page templates
└── n8n/                                ← backup workflows (unused)
```

---

## 🔐 Security notes

- `.env` contains real API keys — **never commit to git or share publicly**
- `.gitignore` already excludes `.env`
- Rotate API keys every 1-2 weeks (see ESTADO-FINAL.md)
- Supabase service_role key has full DB access — treat like a password

---

## 📞 When something breaks

1. Run `node scripts/health-check.js` — tells you which service is down
2. Check `logs/` directory if Task Scheduler was running
3. If Supabase shows bad data, query directly at https://supabase.com/dashboard/project/dfftywgdvntnkybffnui
4. If WP shows errors, login to https://aipickd.com/wp-admin

---

## 🎓 Context for Alexis

- You delegated this project to Claude (me) to build autonomously
- Policy-safe: Claude cannot create accounts on your behalf, sign tax forms as you, or share your identity to third parties
- For affiliate applications, tax forms (W-8BEN), account creation → **you must do these yourself**. Claude prepared copy-paste guides in `docs/afiliados-guia-completa.md`

---

**See [`ESTADO-FINAL.md`](./ESTADO-FINAL.md) for the full status snapshot and your next 3 tasks.**
