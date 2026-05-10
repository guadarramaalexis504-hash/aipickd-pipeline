# Contributing to AIPickd Pipeline

## Quick start (local dev)

```bash
git clone https://github.com/guadarramaalexis504-hash/aipickd-pipeline.git
cd aipickd-pipeline
npm install
cp .env.example .env   # fill in your local values
npm run validate       # lint + tests + syntax-check
```

If `npm run validate` is green, you're set up.

## Before opening a PR

```bash
npm run lint:fix       # auto-fix what's auto-fixable
npm run format:fix     # apply Prettier on scripts/lib + tests
npm test               # 31+ tests should pass
npm run syntax-check   # node --check on every script
```

The CI runs the same commands, so passing locally = passing in CI.

## Branch naming

Use one of these prefixes so the auto-labeler tags your PR correctly:

- `claude/<task>` — Claude Code sessions
- `fix/<short-desc>` — bug fix
- `feat/<short-desc>` — new feature
- `chore/<short-desc>` — build/CI/non-functional
- `docs/<short-desc>` — documentation only

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) so
`release-please` can auto-generate the changelog and bump versions:

```
feat: add WP Application Password rotation

Closes #42
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`.
Add `!` after the type for breaking changes (e.g. `feat!: drop Node 18 support`).

## Where to put new code

- **Reusable logic** → `scripts/lib/<name>.js` + a test in `tests/`.
  See `scripts/lib/env.js` and `scripts/lib/http.js` for the pattern.
- **One-off task script** → `scripts/<task>.js`. Use the libs:
  ```js
  const { loadEnv } = require("./lib/env");
  const { fetchWithRetry } = require("./lib/http");
  const log = require("./lib/log").create({ script: "my-task" });
  ```
- **New env var** → add a check in `scripts/validate-secrets.js` so the
  pipeline fails fast if it's missing.
- **DB schema change** → add `supabase/migrations/<UTC>_<name>.sql`.
  Never edit existing migrations. `migration-check.yml` validates the
  new file applies cleanly to a fresh Postgres in PR.
- **New workflow** → use `.github/actions/setup-env` instead of writing
  a `.env` file. Declare `permissions:` explicitly. Add a `concurrency`
  group, and use `aipickd-mutations` if it writes to Supabase.

## Testing

Tests use Node's built-in `node:test` runner (no extra deps).

```bash
node --test tests/log.test.js   # one file
npm test                         # all
```

Write tests for any helper in `scripts/lib/`. Don't aim for coverage of
one-off task scripts — aim for coverage of the contracts that other code
relies on (env parsing, retry semantics, etc).

## Don'ts

- ❌ Don't commit `.env` (it's in `.gitignore` and `secret-scan` will catch it).
- ❌ Don't `console.log` in new code; use `scripts/lib/log.js` for
  structured output.
- ❌ Don't add inline `for (let i = 0; i < N; i++) { try { ... } catch {} }`
  retry loops; use `fetchWithRetry` from `lib/http.js`.
- ❌ Don't skip `validate-secrets` in production workflows.
- ❌ Don't merge PRs with the `do-not-merge` label or with red required
  checks.

## Releasing

`release-please.yml` runs on every push to `main` and opens a release PR
with the auto-generated changelog. Merging that PR creates a git tag and
GitHub release. Manual releases are not needed.
