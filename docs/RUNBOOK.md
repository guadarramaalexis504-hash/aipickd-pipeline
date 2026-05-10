# AIPickd Runbook

What to do when things go wrong. Each section is one symptom you might
see (in Discord, in CI, on the site) → what it means → fix steps.

---

## 🔴 Discord: "Pipeline FALLÓ en GitHub Actions"

**Triage in 30 seconds:** open the run link in the alert, look at which
step is red.

| Failed step | Likely cause | Fix |
|---|---|---|
| `Validate secrets present` | a GitHub secret is missing/malformed | open Settings → Secrets, fix the offender. The error log says which one |
| `Enforce daily/monthly budget` | spend cap hit | wait until tomorrow / next month, or raise `DAILY_BUDGET`/`MONTHLY_BUDGET` in `generate.yml` |
| `Run pipeline (generate + publish)` | OpenAI / Supabase / WP failure | see "Pipeline crashes mid-generate" below |
| Any post-publish step | non-critical (article was published) | see "Post-publish step fails" below |

The `failure()` notification only fires when the **critical** path fails.
Post-publish steps (sitemap, indexnow, internal-links, cta, dedup) run
with `continue-on-error: true` and are reported in the success
notification with a list of which ones failed.

---

## 🟡 Pipeline crashes mid-generate

**Symptom:** generation throws and the keyword is left as `in_progress`.

**Fix:**

1. Re-running the workflow won't help — the keyword is locked.
2. Once the retry-tracking migration is applied, the next pipeline run
   will pick up keywords with `attempts < 3` and try again. After 3
   attempts it moves to `failed_keywords` (DLQ) for human review.
3. Manual unblock if needed:
   ```sql
   UPDATE keywords SET status = 'queued', attempts = 0
   WHERE status = 'in_progress' AND assigned_article_id IS NULL;
   ```

---

## 🟡 Post-publish step fails (sitemap / indexnow / cta / dedup)

**Symptom:** Discord says "⚠️ Pipeline completado con N post-step(s)
fallidos: …".

**Action:** none usually required. These are best-effort:

- `sitemap-update` / `bulk-indexnow`: search engines will pick up new
  URLs on their next crawl regardless. Re-run manually only if you need
  fast indexing.
- `internal-links` / `cta-injector`: re-run from `workflow_dispatch` →
  `generate.yml` → `--no-gen` (skips generation, only post-ops).
- `dedup-wordpress`: re-run with `node scripts/dedup-wordpress.js --fix`
  locally or via workflow.

If the same step fails 3+ runs in a row, investigate the underlying
script.

---

## 🔴 CI red on PR: `format`

**Cause:** a file under `scripts/lib/` or `tests/` doesn't match Prettier rules.

**Fix:**
```bash
npm run format:fix
git commit -am "fix: prettier"
git push
```

---

## 🔴 CI red on PR: `lint`

**Cause:** ESLint found errors (warnings don't fail). Common: undefined
global, parse error, no-undef.

**Fix:**
```bash
npm run lint           # see the errors
npm run lint:fix       # auto-fix what's auto-fixable
```

If a warning blocks you because someone enabled `--max-warnings 0`,
fix the warning rather than silencing the rule.

---

## 🔴 CI red on PR: `test`

**Cause:** a test in `tests/` failed.

**Fix:**
```bash
npm test                          # see which test
node --test tests/<file>.test.js  # iterate on one file
```

---

## 🔴 CI red on PR: `Validate new Supabase migrations`

**Cause:** your new migration in `supabase/migrations/<UTC>_…sql` has
either invalid SQL or a non-monotonic timestamp.

**Fix:**

```bash
# Apply locally to a clean Postgres:
sudo service postgresql start
sudo -u postgres dropdb aipickd_test 2>/dev/null
sudo -u postgres createdb aipickd_test
for f in supabase/migrations/*.sql; do
  sudo -u postgres psql -d aipickd_test -v ON_ERROR_STOP=1 \
    --single-transaction -f "$f" || { echo "FAIL: $f"; break; }
done
```

If timestamps aren't monotonic, rename your file to a UTC time
**after** every existing migration.

---

## 🔴 CI red on PR: `actionlint`

**Cause:** workflow YAML or embedded shell has issues.

**Fix:**
```bash
# Install actionlint (one-time):
bash <(curl -sSfL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash)
sudo apt install shellcheck    # for SC* rules

./actionlint -color
```

Most common errors:

- **SC2012**: replace `for f in $(ls *.txt)` with `find` + `while read`.
- **SC2015**: replace `A && B || C` with `if A; then B; else C; fi`.
- **SC2086**: quote variable expansions: `"$VAR"` not `$VAR`.

---

## 🔴 CodeQL Static Analysis fails

**Action:** by design, CodeQL runs with `continue-on-error: true` on
the analyze step (`security-scan.yml`). The check shows green even if
findings exist, but the alerts appear in the repo's **Security** tab.

If CodeQL fails to run at all (job in red even with continue-on-error
on the step), check that:

- The `permissions:` block on the job declares `contents: read`,
  `security-events: write`, `actions: read`.
- "Code scanning" is enabled in repo Settings → Code security.

---

## 🔴 Site is down (monitor.yml alert)

**Symptom:** Discord `#alertas` channel says "Site DOWN" or
"Uptime restored".

**Fix:**

1. Open https://aipickd.com in a browser. If 502/504 → Hostinger issue,
   wait or open ticket.
2. If 200 but slow, check WP admin for plugin/theme issues.
3. If 4xx, check that DNS hasn't changed and Cloudflare proxy is up.
4. If WP login broken, use Hostinger emergency password reset.

---

## 🔴 Anomaly detector fires (cost spike, low-quality flood, etc)

**Symptom:** `#alertas` says "ANOMALY: <type>".

| Anomaly | Investigation |
|---|---|
| `rapid-publishing` | check if a manual run was triggered with `gen_count` > 1 |
| `low-quality` | inspect the recent articles — usually a prompt regression |
| `cost-spike` | look at `cost-monitor.js --json` per-article averages |
| `pipeline-silent` | dead-mans-switch fired; check if `generate.yml` is paused or failing |

---

## 🟡 WP password expired / 401 errors

**Symptom:** CI fails with `WP POST posts: 401`.

**Fix:**

1. Log in to https://aipickd.com/wp-admin/profile.php → Application Passwords.
2. Delete the `aipickd-pipeline` entry if it shows revoked.
3. Generate a new one (24-char output `xxxx xxxx xxxx xxxx xxxx xxxx`).
4. Update GitHub Secret `WP_ADMIN_PASSWORD` (paste with spaces preserved).
5. Re-run the failed workflow.

The quarterly rotation reminder workflow opens an issue automatically
on Jan/Apr/Jul/Oct 1.

---

## 🟡 Supabase storage / row count growing too fast

**Check current size:**
```sql
SELECT
  pg_size_pretty(pg_database_size(current_database())) AS db_size,
  (SELECT COUNT(*) FROM articles) AS articles,
  (SELECT COUNT(*) FROM keywords) AS keywords,
  (SELECT COUNT(*) FROM failed_keywords) AS dlq;
```

**Cleanup options:**

- Old logs: truncate any table with hot/cold partitions.
- DLQ triage: review `SELECT * FROM failed_keywords WHERE NOT triaged`,
  mark as triaged after handling.

---

## 🔴 Circuit breaker tripped: `code: "CIRCUIT_OPEN"` in logs

**Symptom:** logs show `Circuit 'supabase' is OPEN — fast-failing` or
the same for `wordpress`.

**What it means:** the breaker (in `scripts/lib/clients.js`) saw 5
consecutive failures, opened the circuit for 60s, and is now refusing
calls so we don't drown in retries.

**Fix:**

1. Identify the underlying outage — check Supabase status page or hit
   `aipickd.com` in a browser.
2. The breaker auto-tries again after 60s. One success closes it.
3. If you need to reset it manually mid-process (rare):
   ```js
   require("./scripts/lib/clients").breakers.supabase.reset();
   ```
4. To trip it on demand (e.g. during a known maintenance window):
   ```js
   require("./scripts/lib/clients").breakers.wordpress.trip();
   ```

---

## 🟡 DLQ has untriaged keywords (`failed_keywords` growing)

**Symptom:** the daily report shows `untriagedCount > 5` in
`failed_keywords`, or the table is growing without anyone clearing it.

**Fix:**

1. List recent untriaged entries:
   ```js
   const dlq = require("./scripts/lib/dlq");
   await dlq.listUntriaged({ limit: 20 });
   ```
2. For each, decide: re-queue, give up, or fix root cause:
   ```sql
   -- Re-queue (resets attempts):
   INSERT INTO keywords (keyword, niche_id, status, attempts)
   SELECT keyword, niche_id, 'queued', 0
   FROM failed_keywords WHERE id = '<uuid>';

   UPDATE failed_keywords SET triaged = TRUE, triage_note = 'requeued'
   WHERE id = '<uuid>';
   ```
3. Or just dismiss with a note:
   ```js
   await dlq.markTriaged("<uuid>", { note: "obsolete keyword" });
   ```

---

## 🟡 Affiliate links expired or auto-swapped

**Symptom:** Discord `#alertas` shows
`🔗 Affiliate health check — N expired` after the weekly cron.

**Fix:**

1. Check the report for which brands. The detector ran with `--fix`,
   so any with `replacement_url` were auto-swapped.
2. For brands marked `expired` (no replacement was configured): pick a
   new affiliate program, generate a tracking URL, then:
   ```sql
   UPDATE affiliates
     SET base_url = '<new>', status = 'active', last_checked_at = NULL
     WHERE brand = 'X';
   ```
3. Pre-emptively, set `replacement_url` on high-risk affiliates so the
   detector swaps automatically next time it expires.

---

## How to disable the pipeline temporarily

1. Go to repo → Settings → Actions → General.
2. Set "Disable Actions" temporarily, OR
3. Comment out the `schedule:` block in `generate.yml`, push to a branch,
   merge.

The `dead-mans-switch.yml` will alert you if the pipeline is silent
>12h, so you'll get a reminder you turned it off.
