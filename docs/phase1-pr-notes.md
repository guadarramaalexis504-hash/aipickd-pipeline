# Phase 1 PR Notes

## Scope

Phase 1 is intentionally narrow. It fixes schema drift, Spanish gating, traceable QA, consistent keyword/article states, and safe publisher recovery. Larger module extraction and mass content repair are Phase 2+ work.

## Migrations

Apply migrations in this order:

1. `20260609001200_phase1_missing_columns_and_qa.sql`
2. `20260609001239_phase1_observability_tables.sql`
3. `20260609001309_phase1_indexes.sql`
4. `20260609001343_phase1_soft_constraints.sql`
5. `20260609001422_phase1_backfill_reconciliation_helpers.sql`

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
4. `node scripts/publish-pending-drafts.js --limit 1` writes nothing and reports preserved `language`, planned `_pipeline_lang`, idempotency, QA, schema, and IndexNow behavior.
5. `node scripts/wp-language-bridge-probe.js` passes read-only, or Spanish release/publish remains blocked. If read-only cannot verify safely, only run `node scripts/wp-language-bridge-probe.js --go` with explicit approval; it creates a temporary draft and attempts cleanup.
6. No production writes happened except explicitly approved migrations and, optionally, one single-keyword Spanish smoke test.

## Explicit Write Gates

Mutating Phase 1 scripts are report-only by default. Production writes require one of `--go`, `--fix`, `--apply`, or `--confirm`, depending on the script.

Spanish keyword release is additionally capped at one keyword per `--go` run and requires the WordPress language bridge probe to pass first.
