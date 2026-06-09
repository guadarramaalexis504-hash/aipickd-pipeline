#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SCHEMA_ASSETS = [
  path.join(ROOT, "supabase", "schema.sql"),
  path.join(ROOT, "supabase", "migrations"),
];

const REQUIRED = {
  articles: [
    "primary_keyword",
    "title_variants",
    "idempotency_key",
    "quality_score",
    "title_refreshed_at",
    "schema_updated_at",
    "gsc_impressions",
    "gsc_clicks",
    "gsc_ctr",
    "gsc_position",
    "gsc_updated_at",
    "language",
    "qa_issues",
    "last_error",
    "last_error_at",
    "retry_count",
    "last_qa_at",
    "repair_status",
    "repair_notes",
    "duplicate_of",
    "image_status",
    "image_error",
    "image_generated_at",
    "image_provider",
    "featured_image_alt",
    "seo_title",
    "seo_title_history",
    "meta_description_history",
    "ctr_status",
    "last_ctr_check_at",
    "title_test_started_at",
    "title_test_variant",
    "last_publish_error",
    "updated_at",
  ],
  keywords: [
    "language",
    "updated_at",
    "normalized_keyword",
    "canonical_topic",
    "duplicate_of",
  ],
  pipeline_config: ["spanish_pipeline_enabled"],
};

const REQUIRED_TABLES = [
  "pipeline_runs",
  "publish_attempts",
  "internal_links",
  "indexing_status",
];

function readSqlAssets(assets = SCHEMA_ASSETS) {
  const chunks = [];
  for (const asset of assets) {
    if (!fs.existsSync(asset)) continue;
    const stat = fs.statSync(asset);
    if (stat.isDirectory()) {
      const files = fs
        .readdirSync(asset)
        .filter((name) => name.endsWith(".sql"))
        .sort()
        .map((name) => path.join(asset, name));
      chunks.push(...files.map((file) => fs.readFileSync(file, "utf8")));
    } else {
      chunks.push(fs.readFileSync(asset, "utf8"));
    }
  }
  return chunks.join("\n");
}

function hasTable(sql, table) {
  return new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${table}\\b`, "i").test(sql);
}

function hasColumn(sql, table, column) {
  const createRe = new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${table}\\s*\\(([\\s\\S]*?)\\);`,
    "gi"
  );
  let match;
  while ((match = createRe.exec(sql)) !== null) {
    const body = match[1];
    if (new RegExp(`(^|[\\s,])${column}\\s+[a-z]`, "i").test(body)) return true;
  }
  const alterRe = new RegExp(
    `alter\\s+table\\s+(?:public\\.)?${table}[\\s\\S]*?add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?${column}\\b`,
    "i"
  );
  return alterRe.test(sql);
}

function checkSchemaDrift(sql = readSqlAssets()) {
  const missing = [];
  for (const [table, columns] of Object.entries(REQUIRED)) {
    if (!hasTable(sql, table)) {
      missing.push({ table, column: "*", reason: "table missing" });
      continue;
    }
    for (const column of columns) {
      if (!hasColumn(sql, table, column)) {
        missing.push({ table, column, reason: "column missing" });
      }
    }
  }
  for (const table of REQUIRED_TABLES) {
    if (!hasTable(sql, table)) {
      missing.push({ table, column: "*", reason: "observability table missing" });
    }
  }
  return { ok: missing.length === 0, missing };
}

function main() {
  const result = checkSchemaDrift();
  if (result.ok) {
    console.log("Schema drift check passed: required Phase 1 columns/tables are present in repo SQL assets.");
    return 0;
  }
  console.error("Schema drift check failed:");
  for (const item of result.missing) {
    console.error(`  - ${item.table}.${item.column}: ${item.reason}`);
  }
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { REQUIRED, REQUIRED_TABLES, readSqlAssets, hasColumn, hasTable, checkSchemaDrift };
