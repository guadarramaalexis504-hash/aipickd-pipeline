# 🤖 AIPickd — Autonomous Affiliate Blog

**Status:** ✅ Production-ready as of 2026-04-21
**Live site:** https://aipickd.com
**Monetization:** Affiliate programs (Amazon, Impact, PartnerStack, direct partnerships)

> **Si estás leyendo esto por primera vez, empieza aquí:** [`ESTADO-FINAL.md`](./ESTADO-FINAL.md)

---

## 🎯 Qué hace este negocio

Blog de reseñas honestas y comparativas de herramientas de IA y SaaS. Contenido generado por GPT-4o, publicado automáticamente a WordPress, monetizado por links de afiliado en cada artículo.

**Proyección:** $0-80/mo (mes 1) → $2-6k/mo (mes 6) → $5-15k/mo (año 1).

---

## 🏗️ Arquitectura (actualizada 2026-04-21)

```
                  Windows Task Scheduler (cada 4h)
                           │
                           ▼
                  scripts/run-pipeline.js
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   ┌──────────┐      ┌──────────┐      ┌──────────┐
   │ Supabase │      │  OpenAI  │      │WordPress │
   │ Postgres │──────│  GPT-4o  │─────▶│ REST API │
   │ keywords │◀─────│gpt-4o-mini│     │ miniOrange│
   │ articles │      └──────────┘      │ Basic Auth│
   │affiliates│                        └──────────┘
   └──────────┘                             │
                                            ▼
                                   https://aipickd.com
                                   Article published
                                   + affiliate links
                                   = $$$
```

**Stack:**
- **Orchestration:** Node.js scripts + Windows Task Scheduler (simple, free)
- **Content gen:** OpenAI GPT-4o (2-pass ~2500 words) + GPT-4o-mini (polish)
- **Database:** Supabase (free tier, 10 tables)
- **Publishing:** WordPress on Hostinger + miniOrange plugin for REST auth
- **Domain:** Namecheap aipickd.com ($11/yr)

**Cost:** ~$5/mo hosting + ~$60/mo AI = **~$65/mo operating cost**.

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
