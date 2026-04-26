# 🏗️ AIPickd — Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                      CONTROL PLANE (GitHub)                       │
│                                                                   │
│  Repo: aipickd-pipeline (private)                                │
│   ├── Workflows                                                   │
│   │   ├── generate.yml      (cron: every 4h)                     │
│   │   ├── monitor.yml       (cron: every 1h)                     │
│   │   ├── anomaly-watch.yml (cron: every 1h, offset :30)         │
│   │   ├── backup.yml        (cron: daily 5am UTC)                │
│   │   └── security-scan.yml (push + Mon 8am UTC)                 │
│   │                                                              │
│   ├── Secrets (encrypted at rest)                                │
│   │   SUPABASE_URL  SUPABASE_SERVICE_ROLE_KEY                    │
│   │   OPENAI_API_KEY  ANTHROPIC_API_KEY                          │
│   │   WP_USERNAME  WP_ADMIN_PASSWORD                             │
│   │   DISCORD_WEBHOOK_URL  TELEGRAM_*                            │
│   │                                                              │
│   └── Dependabot (weekly npm + actions updates)                  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              │ runs scripts on ubuntu-latest
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                   COMPUTE LAYER (GitHub Actions runner)           │
│                                                                   │
│  Each cron job:                                                   │
│   1. Checkout code                                                │
│   2. Reconstruct .env from Secrets (in-memory)                   │
│   3. Validate secrets (validate-secrets.js)                      │
│   4. Enforce budget (cost-monitor.js --enforce)                  │
│   5. Run pipeline                                                │
│   6. Shred .env (always, even on failure)                        │
└──────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
       ┌──────────┐    ┌──────────┐    ┌──────────┐
       │ Supabase │    │  OpenAI  │    │ WordPress│
       │ Postgres │    │ GPT-4o + │    │ aipickd  │
       │          │    │ DALL-E 3 │    │ .com     │
       └──────────┘    └──────────┘    └──────────┘
       82 articles     content/image   live pages
       207 keywords    generation      live indexing
       33 affiliates                   live monetization
```

---

## 🔄 Lifecycle of a single article

1. **Cron fires** at :00 every 4h (UTC)
2. Checkout code, install npm deps (cached)
3. Reconstruct `.env` from Secrets (in-memory only, shredded at end)
4. `validate-secrets.js` — fail fast if any secret malformed
5. `cost-monitor.js --enforce` — halt if daily/monthly budget exceeded
6. `run-pipeline.js --gen 1`:
   - Pull next queued keyword from Supabase
   - GPT outline (4o-mini, ~500 tokens)
   - GPT first-pass body (4o, ~10k tokens)
   - GPT polish (4o-mini, ~5k tokens)
   - Process `[AFFILIATE:...]` tags into real links
   - Insert article into Supabase
   - DALL-E featured image (1792x1024, $0.04)
   - Build Schema.org JSON-LD (Article/Review/FAQPage)
   - Quality gate (15+ checks)
   - POST to WordPress as `publish` if pass, `draft` if fail
   - Auto-run internal linker on all articles
   - IndexNow ping to Bing/Yandex
7. Shred `.env`

**Cost per article:** ~$0.05-0.10 (depending on length + image)
**Time per article:** ~2-3 minutes
**Budget cap:** $3/day, $50/month (enforced)

---

## 🛡️ Security model

### Confidentiality

- **Secrets at rest**: GitHub Secrets (AES-256, only available to workflows)
- **Secrets in transit**: HTTPS only (TLS 1.3)
- **Secrets at runtime**: in-memory `.env` file with `umask 077`, shredded after use
- **No secret in code**: enforced by security-scan.yml secret-scan job

### Integrity

- **Code provenance**: pinned major versions of GitHub Actions (Dependabot updates)
- **Dependency hygiene**: `npm ci --ignore-scripts` to prevent malicious postinstall
- **Static analysis**: CodeQL on every push
- **Pull request gates**: security-scan must pass (configurable in repo settings)

### Availability

- **Site monitoring**: Playwright check every 1h via monitor.yml
- **Anomaly detection**: pattern-based check every 1h (anomaly-watch.yml)
- **Database backups**: full Supabase export daily (backup.yml, 30-day retention)
- **Budget protection**: pipeline halts before runaway costs (cost-monitor.js)
- **Concurrency control**: workflows have `concurrency: cancel-in-progress: false` to prevent race on keyword queue

### Authentication

- Pipeline → Supabase: JWT service_role (full DB access; protected by GitHub Secret)
- Pipeline → WordPress: HTTP Basic Auth via miniOrange plugin (admin user)
- Pipeline → OpenAI: Bearer token (GitHub Secret)
- User → GitHub: should have 2FA (mandatory recommendation)
- User → Hostinger: should have 2FA (mandatory recommendation)
- User → Google (Search Console): should have 2FA + recovery codes

### What we DON'T trust

- 3rd-party npm packages → `--ignore-scripts` + `audit --high`
- Non-pinned GitHub Actions → only major-version pinning + Dependabot
- WordPress plugins from outside wp.org → never install
- Pull requests from forks → workflows don't trigger on `pull_request_target`

---

## 📊 Capacity planning

### Current state (2026-04-26)

- **Articles**: 82 published
- **Total words**: ~165k
- **Affiliates active**: 1 (Amazon) of 33
- **Cost (this month)**: $3.63 / $50 cap (7.3%)
- **Cost (per article avg)**: $0.05
- **Pipeline runs/day**: 6 (every 4h)

### Projected (with current cron)

- 6 articles/day × 30 days = 180 articles/month
- Cost: 180 × $0.05 = $9/month OpenAI

### Scaling options

If you want to publish more:

| Strategy | Articles/month | Extra cost |
|----------|----------------|-----------|
| Current cron (every 4h) | 180 | $9/mo |
| Every 2h | 360 | $18/mo |
| Every 1h | 720 | $36/mo (near monthly cap) |
| Generate 3/run @ 4h | 540 | $27/mo |
| Add Anthropic Claude as fallback | +20% | +$5/mo |

The bottleneck at scale is **GitHub Actions free tier**: 2000 min/month. Current usage ~600 min/month (3 min × 6 runs × 30 days). At 720 articles/month we'd hit ~2160 min — needs a paid GitHub plan ($4/mo).

---

## 🚧 Things this architecture does NOT do (intentional)

1. **No email sending pipeline** — newsletter is opt-in feature for later
2. **No social media auto-post** — `social-autopost.js` exists but unused (Twitter API costs)
3. **No live cost dashboard UI** — use `cost-monitor.js` CLI instead
4. **No A/B testing for titles** — Google handles via SERP CTR
5. **No paid CDN** — Hostinger LiteSpeed handles caching well enough
6. **No CMS staging environment** — every change goes direct to live (acceptable for low-stakes blog)
7. **No multi-region failover** — site is on Hostinger US-MA, that's fine

These are deliberate to keep costs near $0 and complexity low.

---

## 🔮 Roadmap (what to add when you have traffic)

In priority order:

1. **Cloudflare** in front of Hostinger ($0, free tier) — DDoS protection, faster CDN, easy WAF rules
2. **Google Analytics 4** — needed once you have traffic to optimize content
3. **Affiliate dashboard** — track which articles convert (after first conversions)
4. **Newsletter** (Beehiiv free tier) — capture email after first 1k visits/day
5. **Reader engagement metrics** — heat-map (Microsoft Clarity, free)
6. **PWA (Progressive Web App)** — improve mobile retention
7. **Schema.org markup** for video/HowTo/Recipe types — rank in rich snippets
8. **Programmatic SEO** — auto-generate hub pages from comparisons

Each unlocks the next when traffic justifies it.
