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
 * Usage:
 *   node scripts/validate-secrets.js          # validate format
 *   node scripts/validate-secrets.js --probe  # also probe Supabase + WP connectivity
 */
const { loadEnv } = require("./lib/env");
const { fetchWithRetry } = require("./lib/http");

const env = loadEnv();
const PROBE = process.argv.includes("--probe");

function isUrl(v, { protocol = "https:", host } = {}) {
  try {
    const u = new URL(v);
    if (protocol && u.protocol !== protocol) return false;
    if (host && u.host !== host) return false;
    return true;
  } catch {
    return false;
  }
}

function isDiscordWebhook(v) {
  if (!v) return true;
  return isUrl(v, { protocol: "https:" }) && /^https:\/\/(?:[a-z]+\.)?discord\.com\/api\/webhooks\//.test(v);
}

function isWpAppPassword(v) {
  // WP application passwords are 24 chars, formatted as 6 groups of 4 separated by spaces.
  // We accept the canonical "xxxx xxxx xxxx xxxx xxxx xxxx" or the spaceless 24-char form.
  if (!v) return false;
  const stripped = v.replace(/\s+/g, "");
  return stripped.length === 24 && /^[A-Za-z0-9]+$/.test(stripped);
}

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
    validate: (v) => {
      if (!v || v.length < 3) return false;
      if (v.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      return /^[A-Za-z0-9._-]{3,60}$/.test(v);
    },
    error: "must be a valid email or username (3-60 chars, [A-Za-z0-9._-])",
  },
  {
    key: "WP_ADMIN_PASSWORD",
    required: true,
    validate: isWpAppPassword,
    error:
      "must be a WordPress Application Password (24 chars, optionally formatted as 6 groups of 4 separated by spaces). " +
      "Do NOT use your admin login password — generate one at /wp-admin/profile.php → Application Passwords.",
  },
  {
    key: "ANTHROPIC_API_KEY",
    required: false,
    validate: (v) => !v || v.startsWith("sk-ant-"),
    error: "if set, must start with sk-ant-",
  },
  {
    key: "DISCORD_WEBHOOK_URL",
    required: false,
    validate: isDiscordWebhook,
    error: "if set, must be a https://discord.com/api/webhooks/... URL",
  },
  {
    key: "DISCORD_WEBHOOK_ARTICULOS",
    required: false,
    validate: isDiscordWebhook,
    error: "if set, must be a https://discord.com/api/webhooks/... URL",
  },
  {
    key: "DISCORD_WEBHOOK_PIPELINE",
    required: false,
    validate: isDiscordWebhook,
    error: "if set, must be a https://discord.com/api/webhooks/... URL",
  },
  {
    key: "DISCORD_WEBHOOK_ALERTAS",
    required: false,
    validate: isDiscordWebhook,
    error: "if set, must be a https://discord.com/api/webhooks/... URL",
  },
];

let failed = 0;
const masked = (v) => (v ? v.slice(0, 6) + "..." + v.slice(-4) : "(empty)");

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

(async () => {
  if (PROBE && failed === 0) {
    console.log("\n🌐 Probing connectivity...\n");
    try {
      const r = await fetchWithRetry(
        `${env.SUPABASE_URL}/rest/v1/`,
        {
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        },
        { timeout: 10000, retries: 1 }
      );
      console.log(`  ${r.ok ? "✅" : "❌"} Supabase: ${r.status}`);
      if (!r.ok) failed++;
    } catch (e) {
      console.error(`  ❌ Supabase probe: ${e.message}`);
      failed++;
    }
    try {
      const r = await fetchWithRetry("https://aipickd.com/wp-json/", {}, { timeout: 10000, retries: 1 });
      console.log(`  ${r.ok ? "✅" : "❌"} WordPress: ${r.status}`);
      if (!r.ok) failed++;
    } catch (e) {
      console.error(`  ❌ WordPress probe: ${e.message}`);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`\n❌ ${failed} secret check(s) failed. Fix in GitHub Settings → Secrets.\n`);
    process.exit(1);
  }
  console.log(`\n✅ All ${checks.length} secrets valid.\n`);
})();
