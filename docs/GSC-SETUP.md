# Google Search Console — setup (≈10 min, one-time)

Connecting Search Console unlocks **data-driven CTR work**: `gsc-ctr-report.js`
pulls which pages get impressions but few clicks, so we fix titles/meta where it
actually moves the needle (instead of guessing). Until you do this, the script
just no-ops — nothing breaks.

## What you'll create
A **read-only service account** that the pipeline uses to query your Search
Console data. No passwords, no OAuth dance — a key file the GitHub Action uses.

## Steps

### 1. Create a Google Cloud project + service account
1. Go to https://console.cloud.google.com/ → create a project (e.g. "aipickd-seo").
2. APIs & Services → **Enable APIs** → search **"Google Search Console API"** → Enable.
3. APIs & Services → Credentials → **Create credentials → Service account**.
   - Name: `aipickd-gsc` → Create → skip roles → Done.
4. Click the new service account → **Keys** → Add key → **Create new key → JSON** → downloads a `.json` file. Keep it safe.
5. Copy the service account **email** (looks like `aipickd-gsc@aipickd-seo.iam.gserviceaccount.com`).

### 2. Give it access to your Search Console property
1. Go to https://search.google.com/search-console
2. (If you haven't verified aipickd.com yet, do that first — Settings → Ownership, easiest is the DNS TXT or HTML tag method.)
3. Settings → **Users and permissions** → **Add user** → paste the service account email → permission **Full** (or Restricted) → Add.

### 3. Add the secrets to GitHub
Repo → Settings → Secrets and variables → Actions → New repository secret:
- **`GOOGLE_SERVICE_ACCOUNT_JSON`** → paste the ENTIRE contents of the downloaded `.json` file.
- **`GOOGLE_SEARCH_CONSOLE_SITE`** → your property string:
  - URL-prefix property: `https://aipickd.com/`
  - Domain property: `sc-domain:aipickd.com`

*(For local runs, put the same two in `.env`. `GOOGLE_SERVICE_ACCOUNT_JSON` can
be the JSON on one line, or set `GOOGLE_APPLICATION_CREDENTIALS` to the file path.)*

### 4. Done
The weekly **"GSC CTR Report"** workflow (and `node scripts/gsc-ctr-report.js`)
will now:
- Store `gsc_impressions / gsc_clicks / gsc_ctr / gsc_position` on each article.
- Store page/query/device/date detail rows in `gsc_query_metrics`, with unmatched
  URLs kept for review instead of discarded.
- Store each import summary in `gsc_import_runs`.
- Post the **top CTR opportunities** (high impressions, low CTR) to Discord
  `#pipeline-status` — your prioritized fix list.

Run it on demand: Actions → "GSC CTR Report" → Run workflow.

## Notes
- Search Console data lags ~2 days; the report uses a 28-day window by default.
- New sites take weeks to accumulate impression data — expect sparse results at first.
- Next step after data exists: prioritize `refresh-titles.js` by `gsc_impressions`
  desc so we rewrite the highest-opportunity titles first.
