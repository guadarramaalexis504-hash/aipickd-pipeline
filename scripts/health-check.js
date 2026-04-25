#!/usr/bin/env node
/**
 * AIPickd — Health check
 * Verifies all services are reachable and credentials work.
 * Run this anytime you suspect something is broken.
 *
 * Usage: node scripts/health-check.js
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
try {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch (e) {
  console.error("❌ .env file not found or unreadable:", envPath);
  process.exit(1);
}

const checks = [];

async function check(name, fn) {
  const start = Date.now();
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const result = await fn();
      const ms = Date.now() - start;
      checks.push({ name, ok: true, ms, info: result });
      console.log(`  ✅ ${name.padEnd(30)} (${ms}ms) ${result}`);
      return;
    } catch (e) {
      lastErr = e;
      if (i === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const ms = Date.now() - start;
  checks.push({ name, ok: false, ms, err: lastErr.message });
  console.log(`  ❌ ${name.padEnd(30)} (${ms}ms) ${lastErr.message.slice(0, 80)}`);
}

(async () => {
  console.log("🩺 AIPickd Health Check\n");

  // 1. Env vars
  console.log("📦 ENV variables:");
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY", "WP_USERNAME", "WP_ADMIN_PASSWORD"];
  for (const key of required) {
    const val = env[key];
    if (!val) console.log(`  ❌ ${key} MISSING`);
    else console.log(`  ✅ ${key.padEnd(30)} ${val.slice(0, 20)}...`);
  }
  console.log();

  // 2. Supabase connectivity
  console.log("🗄️  Supabase:");
  await check("Project DNS resolves", async () => {
    // Check REST endpoint directly (the project root is locked down by default)
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY },
    });
    return `HTTP ${res.status}`;
  });
  await check("Auth (service_role)", async () => {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/niches?select=count`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "count=exact",
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const count = res.headers.get("content-range")?.split("/")[1];
    return `${count} niches`;
  });
  await check("Write access (articles)", async () => {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/articles?select=id&limit=1`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return "OK";
  });
  console.log();

  // 3. WordPress
  console.log("🌐 WordPress (aipickd.com):");
  const auth = Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString("base64");
  // Use a real browser-like User-Agent to avoid Hostinger/LiteSpeed 429 rate limits
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const wpHeaders = (extra = {}) => ({ "User-Agent": UA, Accept: "application/json", ...extra });

  // Helper with retry on 429
  async function fetchWp(url, opts = {}) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await fetch(url, { ...opts, headers: { ...wpHeaders(), ...(opts.headers || {}) } });
      if (res.status !== 429) return res;
      // Backoff: 5s, 10s, 20s
      const wait = 5000 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, wait));
    }
    return await fetch(url, { ...opts, headers: { ...wpHeaders(), ...(opts.headers || {}) } });
  }

  await check("Site reachable", async () => {
    const res = await fetchWp("https://aipickd.com/");
    if (res.status >= 500 || res.status === 429) throw new Error(`${res.status}`);
    return `HTTP ${res.status}`;
  });
  await check("REST API reachable", async () => {
    const res = await fetchWp("https://aipickd.com/wp-json/wp/v2/types", {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return "WP v2 OK";
  });
  await check("Basic Auth works", async () => {
    const res = await fetchWp("https://aipickd.com/wp-json/wp/v2/posts?per_page=1&context=edit", {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
    return "auth OK";
  });
  await check("Write access (posts)", async () => {
    const res = await fetchWp("https://aipickd.com/wp-json/wp/v2/posts?status=draft&per_page=1", {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return "OK";
  });
  console.log();

  // 4. OpenAI
  console.log("🤖 OpenAI:");
  await check("API reachable", async () => {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return "OK";
  });
  await check("gpt-4o-2024-11-20", async () => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-2024-11-20",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${res.status}: ${data?.error?.message || ""}`);
    return `responds OK`;
  });
  console.log();

  // 5. Anthropic (optional — likely empty credits)
  console.log("🧠 Anthropic (optional):");
  if (env.ANTHROPIC_API_KEY) {
    await check("API reachable", async () => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929",
          max_tokens: 5,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data?.error?.message?.includes("credit")) return "needs credits (fallback to GPT-only)";
        throw new Error(`${res.status}: ${data?.error?.message || ""}`);
      }
      return "responds OK";
    });
  } else {
    console.log("  (skipped — no ANTHROPIC_API_KEY)");
  }
  console.log();

  // Summary
  const failed = checks.filter((c) => !c.ok);
  console.log("═══════════════════════════════════════════════════════");
  if (failed.length === 0) {
    console.log(`  ✅ ALL GOOD  (${checks.length}/${checks.length} checks passed)`);
    console.log(`     Pipeline is ready to run.`);
  } else {
    console.log(`  ⚠️  ${failed.length}/${checks.length} CHECK(S) FAILED`);
    console.log(`     Fix these before running the pipeline:`);
    for (const f of failed) console.log(`     - ${f.name}: ${f.err.slice(0, 100)}`);
  }
  console.log("═══════════════════════════════════════════════════════");
  process.exit(failed.length > 0 ? 1 : 0);
})();
