# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AIPickd's pipeline code:

1. **Do not** open a public issue
2. Email the repo owner directly
3. Include reproduction steps and affected files
4. Allow up to 7 days for response

## Supported Versions

Only `main` branch is supported. Older commits are not patched.

## Secret Management Policy

This repo follows strict secret hygiene:

| Where | What | Notes |
|-------|------|-------|
| `.env` (local) | All credentials | NEVER committed (.gitignore enforced) |
| GitHub Secrets | Same as .env | Encrypted at rest, only available to workflows |
| Code/docs | NONE | Auto-scanned every push (security-scan.yml) |

If a secret is leaked into a commit:
1. **Rotate the key immediately** in the source service (Supabase, OpenAI, etc.)
2. Update the corresponding GitHub Secret
3. Force-push a clean history is **not** sufficient (caches exist) — rotation is mandatory

## Workflow Security

All GitHub Actions workflows follow these rules:

- **Minimal permissions**: every workflow declares `permissions: contents: read` (or stricter)
- **Pinned actions**: only major-version pins (e.g. `@v4`) — Dependabot updates these
- **No `pull_request_target`**: prevents fork PRs from reading secrets
- **`persist-credentials: false`**: checkout doesn't leave a token in `.git/config`
- **Concurrency limits**: prevents race conditions on Supabase queue

## Dependency Security

- Dependabot enabled (weekly schedule)
- `npm ci --ignore-scripts` to prevent malicious postinstall scripts
- `npm audit --audit-level=high` runs on every push (security-scan.yml)
- CodeQL static analysis on every push

## Threat Model

### What this protects against
- Secret exposure in commits / logs
- Supply-chain attacks via malicious npm postinstall
- Workflow privilege escalation
- Brute-force on WordPress admin (handled by Hostinger + LiteSpeed Cache)
- Bot scraping (LiteSpeed + monitor-site.js detection)

### What this does NOT protect against
- Compromised maintainer account → repo owner must enable 2FA on GitHub + Hostinger + Supabase
- Hostinger infrastructure breach → out of scope (using their hardening)
- OpenAI API key abuse if leaked → rate limit caps via run-pipeline DAILY_BUDGET
- Malicious WordPress plugins → only install plugins from wp.org with >100k installs

## Recommended User Actions

1. ✅ Enable 2FA on:
   - GitHub (Settings → Security)
   - Hostinger hPanel
   - Supabase
   - OpenAI Platform
   - Google account (Search Console access)
2. ✅ Rotate API keys every 90 days (calendar reminder)
3. ✅ Review GitHub Actions logs weekly for unexpected runs
4. ✅ Check Supabase query logs for unusual patterns
5. ✅ Review WordPress users monthly (`/wp-admin/users.php`)
