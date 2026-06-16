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
  // Accept both discord.com (current) and discordapp.com (legacy — Discord redirects automatically)
  return (
    isUrl(v, { protocol: "https:" }) &&
    /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(v.trim())
  );
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
    validate: (v) => /^sk-(proj-)?[A-Za-z0-9_-]{20,}$/.test(v.trim()),
    error:
      "must start with sk- (or sk-proj-) with no extra text — check for trailing spaces/newlines in the secret",
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
      const r = await fetchWithRetry(
        "https://aipickd.com/wp-json/",
        {},
        { timeout: 10000, retries: 1 }
      );
      if (r.ok) {
        console.log(`  ✅ WordPress unauth: ${r.status}`);
      } else {
        // Reachable but non-2xx (e.g. transient 5xx on cold shared hosting).
        // The auth probe below is the authoritative credential check — a flaky
        // unauth reachability ping must NOT fail the whole workflow.
        console.error(
          `  ⚠️  WordPress unauth: ${r.status} (reachable but non-OK; not a secret problem)`
        );
      }
    } catch (e) {
      // Thrown fetch error = network/timeout (Hostinger unreachable from this
      // runner — known intermittent on shared hosting), NOT a bad secret. Warn
      // but do NOT fail, consistent with the auth probe below. A transient host
      // blip must never fail secret validation.
      console.error(
        `  ⚠️  WordPress probe could not reach WP (network, not a secret problem): ${e.message}`
      );
    }

    // Critical: probe the WP Application Password authentication. Regex
    // alone can't tell us if the password was rotated, revoked, or never
    // worked. /users/me?context=edit requires a logged-in user — if we
    // get 401, the password is dead and every publish iter will fail
    // silently in the catch. Better to fail fast at the workflow step.
    try {
      const auth = Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString("base64");
      const r = await fetchWithRetry(
        "https://aipickd.com/wp-json/wp/v2/users/me?context=edit",
        {
          headers: {
            Authorization: `Basic ${auth}`,
            "User-Agent": "Mozilla/5.0 AIPickd-validate-secrets/1.0",
            Accept: "application/json",
          },
        },
        { timeout: 10000, retries: 1 }
      );
      if (r.ok) {
        console.log(`  ✅ WordPress auth: ${r.status} (Application Password works)`);
      } else {
        const body = await r.text();
        console.error(`  ❌ WordPress auth: ${r.status} — ${body.slice(0, 150)}`);
        console.error(
          `     → Application Password may be rotated/revoked. Regenerate at /wp-admin/profile.php`
        );
        failed++;
      }
    } catch (e) {
      // A thrown fetch error = network/timeout (Hostinger unreachable), NOT a bad
      // secret. Warn but do NOT fail secret validation on a transient blip.
      console.error(
        `  ⚠️  WordPress auth probe could not reach WP (network, not a secret problem): ${e.message}`
      );
    }
  }

  if (failed > 0) {
    console.error(`\n❌ ${failed} secret check(s) failed. Fix in GitHub Settings → Secrets.\n`);
    process.exit(1);
  }
  console.log(`\n✅ All ${checks.length} secrets valid.\n`);
})();
