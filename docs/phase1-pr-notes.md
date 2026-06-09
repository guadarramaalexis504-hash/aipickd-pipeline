# Phase 1 PR Notes

## Scope

Phase 1 is intentionally narrow. It fixes schema drift, Spanish gating, traceable QA, consistent keyword/article states, and safe publisher recovery. Larger module extraction and mass content repair are Phase 2+ work.

## PR Handoff

Branch: `codex/phase1-spanish-pipeline-safety`

Manual PR URL:

```text
https://github.com/guadarramaalexis504-hash/aipickd-pipeline/pull/new/codex/phase1-spanish-pipeline-safety
```

The GitHub connector could compare the branch but could not create the PR because the integration returned `403 Resource not accessible by integration`. Local `gh` is not authenticated. The branch is pushed and compares cleanly against `main`.

Local Linux validation was not available on this Windows machine because WSL, Docker, Podman, and Bash are not installed. Re-run `npm run validate` in GitHub Actions or another Linux host before marking this ready.

Production report-only checks that only need Supabase reads can run locally with a publishable Supabase key. WordPress authenticated checks still require `WP_USERNAME` and `WP_ADMIN_PASSWORD`. No content writes were performed while preparing this PR.

Read-only Supabase MCP audit found the expected Spanish failure case and additional state drift:

- Spanish failed article: `cfda0e96-2449-47d8-875b-c7ec6b11d1c9`, slug `mejor-ia-para-crear-imagenes-2026`, status `qa_failed`, no `wp_post_id`, no `wp_url`.
- Associated keyword: `b5da6aee-3b61-4572-a4c7-f9942e469e61`, keyword `mejor ia para crear imagenes`, currently incorrectly `published`.
- First Spanish release candidate in `es_hold`: `ff36854c-ed82-4066-a737-3063869d0c8b`, keyword `mejor ia para hacer tareas`, priority `1000`, search volume `2400`.
- Inconsistent published keyword states found read-only: 8 EN archived articles, 9 EN QA-failed articles, 1 ES QA-failed article.

## Migrations

Apply migrations in this order:

1. `20260609001200_phase1_missing_columns_and_qa.sql`
2. `20260609001239_phase1_observability_tables.sql`
3. `20260609001309_phase1_indexes.sql`
4. `20260609001343_phase1_soft_constraints.sql`
5. `20260609001422_phase1_backfill_reconciliation_helpers.sql`

These migrations were applied to the `aipickd` Supabase project via MCP on June 9, 2026. The MCP initially recorded application-time versions, then the migration history was repaired to the repository timestamps above so future `supabase db push` runs stay aligned.

All migrations use idempotent DDL where possible. Constraints are `NOT VALID` so existing production drift does not block deployment. Internal observability tables have RLS enabled and public client roles revoked.

Rollback notes are embedded in each migration. In short:

- Drop newly added columns only after confirming no code path depends on them.
- Drop observability tables if audit history is not needed.
- Drop new indexes with `DROP INDEX IF EXISTS`.
- Drop soft constraints with `ALTER TABLE ... DROP CONSTRAINT IF EXISTS`.
- Drop update triggers/functions only after confirming no downstream code relies on `updated_at`.

## Schema Snapshot

`supabase/schema.sql` was not hand-edited. After migrations are applied to the linked Supabase project, regenerate it with:

```bash
npx supabase db dump --schema public > supabase/schema.sql
```

If using a linked project profile, run the same command from the repository root after `npx supabase link --project-ref dfftywgdvntnkybffnui`.

## Phase 1 Smoke Checklist

1. `node scripts/check-schema-drift.js` passes.
2. `node scripts/report-qa-failures.js` identifies the Spanish failed article.
3. `node scripts/release-es-keywords.js --limit 1 --dry-run` shows the exact `es_hold` row and writes nothing.
4. `node scripts/publish-pending-drafts.js --limit 1` writes nothing. If no pending drafts exist, it reports `nothing to do`; otherwise it reports preserved `language`, planned `_pipeline_lang`, idempotency, QA, schema, and IndexNow behavior.
5. `node scripts/wp-language-bridge-probe.js` currently reports a blocker in read-only mode because no public Spanish/Polylang evidence was found. Spanish release/publish remains blocked. Only run `node scripts/wp-language-bridge-probe.js --go` with explicit approval and valid WP credentials; it creates a temporary draft and attempts cleanup.
6. No production content writes happened except the explicitly approved Phase 1 migrations and migration-history alignment. No Spanish keyword smoke test has been run.

## Explicit Write Gates

Mutating Phase 1 scripts are report-only by default. Production writes require one of `--go`, `--fix`, `--apply`, or `--confirm`, depending on the script.

Spanish keyword release is additionally capped at one keyword per `--go` run and requires the WordPress language bridge probe to pass first.
