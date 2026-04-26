#!/usr/bin/env node
/**
 * AIPickd — Pre-flight secret validation
 *
 * Runs before the main pipeline to catch missing/malformed secrets EARLY,
 * before we burn an OpenAI call on a misconfigured pipeline.
 *
 * Exits non-zero if anything looks wrong, which fails the GitHub Action
 * with a clear error message.
 *
 * Usage: node scripts/validate-secrets.js
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
if (!fs.existsSync(envPath)) {
  console.error("❌ .env file not found at", envPath);
  process.exit(1);
}

const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const checks = [
  {
    key: "SUPABASE_URL",
    required: true,
    validate: (v) => /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(v),
    error: "must be like https://abc123.supabase.co",
  },
  {
    key: "SUPABASE_SERVICE_ROLE_KEY",
    required: true,
    validate: (v) => v.startsWith("eyJ") && v.length > 100,
    error: "must be a JWT starting with eyJ (>100 chars)",
  },
  {
    key: "OPENAI_API_KEY",
    required: true,
    validate: (v) => /^sk-(proj-)?[A-Za-z0-9_-]{20,}$/.test(v),
    error: "must start with sk- (or sk-proj-)",
  },
  {
    key: "WP_USERNAME",
    required: true,
    validate: (v) => v.length > 3 && (v.includes("@") || v.length > 4),
    error: "must be email or username >4 chars",
  },
  {
    key: "WP_ADMIN_PASSWORD",
    required: true,
    validate: (v) => v.length >= 6,
    error: "must be at least 6 characters",
  },
  {
    key: "ANTHROPIC_API_KEY",
    required: false,
    validate: (v) => !v || v.startsWith("sk-ant-") || v === "",
    error: "if set, must start with sk-ant-",
  },
];

let failed = 0;
const masked = (v) => v ? v.slice(0, 6) + "..." + v.slice(-4) : "(empty)";

console.log("\n🔐 Validating secrets...\n");
for (const c of checks) {
  const v = env[c.key] || "";
  if (c.required && !v) {
    console.error(`  ❌ ${c.key}: MISSING (required)`);
    failed++;
    continue;
  }
  if (v && !c.validate(v)) {
    console.error(`  ❌ ${c.key}: invalid — ${c.error}  [got: ${masked(v)}]`);
    failed++;
    continue;
  }
  console.log(`  ✅ ${c.key.padEnd(28)} ${v ? masked(v) : "(empty, optional)"}`);
}

if (failed > 0) {
  console.error(`\n❌ ${failed} secret(s) failed validation. Fix in GitHub Settings → Secrets.\n`);
  process.exit(1);
}
console.log(`\n✅ All ${checks.length} secrets valid.\n`);
