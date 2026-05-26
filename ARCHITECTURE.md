# AIPickd — Architecture

## Pipeline en una imagen

```
┌─────────────────┐
│ GitHub Actions  │  cron */4h: generate.yml
│   (cron + UI)   │  cron 1h:  monitor.yml, anomaly-watch.yml
└────────┬────────┘  cron 1d:  backup.yml, daily-report.yml
         │           cron 1w:  weekly-*.yml, freshness-check.yml, seo-audit.yml
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ run-pipeline.js (scripts/run-pipeline.js)                   │
│                                                             │
│  1. Pull next keyword from Supabase keywords queue          │
│  2. GPT-4o draft → GPT-4o-mini polish                       │
│  3. Image: Unsplash (free) → DALL·E fallback                │
│  4. Save article as draft in Supabase                       │
│  5. Publish all unpublished drafts → WordPress REST API     │
│  6. Run post-publish ops (sitemap, indexnow, links, ...)    │
└──────────────┬──────────────────────────────────────────────┘
               │
       ┌───────┴───────┬───────────┬──────────────┐
       ▼               ▼           ▼              ▼
   ┌────────┐     ┌──────────┐  ┌───────┐    ┌─────────┐
   │Supabase│     │ OpenAI   │  │  WP   │    │ Discord │
   │ (DB)   │     │ Anthropic│  │ REST  │    │webhooks │
   └────────┘     └──────────┘  └───────┘    └─────────┘
```

## Repo layout

```
aipickd-pipeline/
├── scripts/
│   ├── run-pipeline.js       ← main orchestrator
│   ├── lib/                  ← shared helpers (use these in new code)
│   │   ├── env.js            ← centralized env loader
│   │   ├── http.js           ← fetch with retry/backoff/timeout + SSRF allowlist
│   │   ├── clients.js        ← supa() and wp(), wrapped in circuit breaker + rate limiter
│   │   ├── log.js            ← structured JSON logger
│   │   ├── circuit-breaker.js ← fast-fail during sustained service outages
│   │   ├── rate-limiter.js   ← token-bucket throttle (used by wp() client)
│   │   ├── idempotency.js    ← deterministic publishKey() to prevent duplicates
│   │   ├── heartbeat.js      ← healthchecks.io ping helper
│   │   ├── bulk.js           ← bulkInsert/bulkUpsert/bulkUpdate (chunked)
│   │   ├── dlq.js            ← failed_keywords archive helpers
│   │   ├── articles.js       ← softDelete/restore helpers
│   │   └── jsonld.js         ← Schema.org validators (Article/Review/Product/FAQPage/Breadcrumb)
│   ├── validate-secrets.js   ← pre-flight gate before generation
│   ├── cost-monitor.js       ← daily/monthly budget enforcement
│   ├── anomaly-detector.js   ← hourly anomaly checks
│   ├── monitor-site.js       ← Playwright site health check
│   ├── affiliate-expired-detector.js  ← weekly affiliate URL health check + auto-swap
│   ├── affiliate-redirect-installer.js ← generates the WP mu-plugin for /go/<slug>
│   ├── notify.js             ← Discord webhook helpers (5 channels)
│   └── ...                   ← ~80 task-specific scripts
├── tests/                    ← node:test (built-in, no extra deps)
├── supabase/
│   ├── migrations/           ← versioned migrations (YYYYMMDDHHMMSS_name.sql)
│   └── schema.sql            ← snapshot of cumulative schema
├── content-bank/             ← seed articles
├── content-engine/prompts/   ← GPT prompt templates
└── .github/
    ├── workflows/            ← 16 automation workflows
    ├── actions/setup-env/    ← composite action (replaces .env reconstruction)
    └── labeler.yml           ← PR auto-labeling rules
```

## Workflows (16)

| Workflow | When | Purpose |
|---|---|---|
| `generate.yml` | every 4h | generate + publish articles (the main loop) |
| `auto-keywords.yml` | weekly | refill keyword queue if low |
| `freshness-check.yml` | weekly | detect & queue stale articles |
| `monitor.yml` | hourly | Playwright health check on aipickd.com |
| `anomaly-watch.yml` | hourly | flag suspicious patterns in DB |
| `backup.yml` | daily | dump Supabase tables to GH artifact |
| `daily-report.yml` | daily | Discord digest |
| `weekly-report.yml` | weekly | full weekly intelligence report |
| `weekly-health.yml` | weekly | SEO audit, content health, dedup |
| `seo-audit.yml` | weekly | meta/title/image audit |
| `quality-report.yml` | weekly | article quality metrics |
| `affiliate-health.yml` | monthly | check affiliate links work |
| `deadmans-switch.yml` | daily | alert if pipeline silent >12h |
| `reindex-all.yml` | manual | bulk submit URLs to IndexNow |
| `fix-sitemap-once.yml` | manual | one-shot sitemap repair |
| `security-scan.yml` | push/PR + weekly | secret scan + npm audit + CodeQL |
| `ci.yml` | push/PR | lint + format + tests + actionlint |
| `migration-check.yml` | PR | apply migrations to clean Postgres |
| `affiliate-expired-check.yml` | weekly | detect expired affiliate URLs, auto-swap if replacement set |
| `wp-password-rotation-reminder.yml` | quarterly | open issue with rotation steps |
| `release-please.yml` | push to main | open release PR from Conventional Commits |
| `stale.yml` | daily | mark and close inactive issues/PRs |
| `pr-label.yml` | pull_request_target | auto-label by changed paths |

### Cross-workflow concurrency

Workflows that mutate Supabase share `concurrency.group: aipickd-mutations`
so they never race on the keyword queue or articles table:

- `generate.yml`
- `auto-keywords.yml`
- `freshness-check.yml`

Read-only workflows (monitor, backup, reports) use their own concurrency
groups so they can run in parallel.

## Conventions

- **`scripts/lib/`** is the right place for any helper used by 2+ scripts.
  Don't duplicate retry loops, env parsing, or HTTP clients — extend the
  shared lib instead.
- **All new env vars** must be added to `validate-secrets.js` so they fail
  fast on a misconfigured pipeline.
- **All new Supabase changes** go in `supabase/migrations/<UTC>_name.sql`,
  never edited in place. The `migration-check.yml` workflow validates new
  migrations on every PR.
- **All new workflows** must declare `permissions:` explicitly (least
  privilege) and use the `setup-env` composite action instead of writing
  a `.env` file.
- **Logging**: prefer `scripts/lib/log.js` over `console.log` in new code.
  In CI it emits NDJSON; locally it pretty-prints.

## Secrets

Secrets are stored in GitHub repo Settings → Secrets, never in code or
`.env` committed to git. The `setup-env` composite action passes them
into the runner via `GITHUB_ENV` (multiline-safe heredoc form), and
`scripts/lib/env.js` reads from `process.env` first.

| Secret | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL` | most | DB endpoint |
| `SUPABASE_SERVICE_ROLE_KEY` | most | DB write access |
| `OPENAI_API_KEY` | generate, refresh | LLM + DALL-E |
| `ANTHROPIC_API_KEY` | generate (Bridge mode) | Claude |
| `WP_USERNAME` | publish, weekly-health | WP REST auth |
| `WP_ADMIN_PASSWORD` | publish, weekly-health | WP Application Password (24-char) |
| `DISCORD_WEBHOOK_*` | notify | 4 Discord channels |
| `HEALTHCHECK_URL_GENERATE` | generate workflow | overall workflow heartbeat (optional) |
| `HEALTHCHECK_URL_PIPELINE_OUTLINE` | run-pipeline.js | per-step heartbeat after outline (optional) |
| `HEALTHCHECK_URL_PIPELINE_DRAFT_START` | run-pipeline.js | "start" ping before draft call (optional) |
| `HEALTHCHECK_URL_PIPELINE_DRAFT` | run-pipeline.js | after draft returned (optional) |
| `HEALTHCHECK_URL_PIPELINE_POLISH` | run-pipeline.js | after polish step (optional) |
| `HEALTHCHECK_URL_PIPELINE_PUBLISH` | run-pipeline.js | after WP publish loop (optional) |
| `HEALTHCHECK_URL_PIPELINE_POSTSTEPS` | run-pipeline.js | after sitemap/indexnow/links (optional) |
| `PERPLEXITY_API_KEY` | ai-citations-check | weekly GEO/AEO probe (optional, ~$5/mo) |
| `CRUX_API_KEY` | cwv-check | weekly Core Web Vitals probe (optional, free) |

All `HEALTHCHECK_URL_PIPELINE_*` vars are optional. Set the ones you
care about in healthchecks.io and Set GitHub Secrets — the rest just
silently no-op. Granular heartbeats let you see in healthchecks.io
WHICH stage of the pipeline died when a cron run goes silent.

## Cost controls

Hard caps enforced in `scripts/cost-monitor.js`:

- `DAILY_BUDGET=$3` — pipeline aborts if today's spend ≥ $3
- `MONTHLY_BUDGET=$50` — pipeline aborts if this month's spend ≥ $50

Both are enforced **before** generation in `generate.yml`. Soft alerts
to Discord at 80% (daily) and 70%/90%/100% (monthly).
