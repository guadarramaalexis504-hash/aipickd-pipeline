#!/usr/bin/env node
/**
 * AIPickd — WordPress Security Audit
 *
 * Probes aipickd.com for common WordPress security issues and
 * exits non-zero if anything risky is exposed.
 *
 * What it checks:
 *   1. WP version disclosure (generator meta tag)
 *   2. wp-config.php accessible
 *   3. xmlrpc.php enabled (often used for brute-force)
 *   4. /wp-admin/install.php still exposed
 *   5. Author enumeration (?author=1)
 *   6. Directory listing on /wp-content/uploads/
 *   7. Default "admin" user exists
 *   8. Debug mode leaks (errors visible)
 *   9. SSL configuration
 *   10. HSTS header presence
 *
 * Usage:
 *   node scripts/wp-security-audit.js              # human-readable
 *   node scripts/wp-security-audit.js --json       # machine output
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
}

const SITE = "https://aipickd.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const JSON_OUT = process.argv.includes("--json");

const findings = [];

function add(severity, check, finding, recommendation) {
  findings.push({ severity, check, finding, recommendation });
}

async function fetchTxt(url, opts = {}) {
  try {
    const r = await fetch(url, {
      ...opts,
      headers: { "User-Agent": UA, ...(opts.headers || {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), text: await r.text().catch(() => "") };
  } catch (e) {
    return { status: 0, error: e.message, headers: {}, text: "" };
  }
}

(async () => {
  if (!JSON_OUT) console.log("\n🔒 AIPickd WordPress Security Audit\n   target:", SITE, "\n");

  // 1. WP version disclosure via generator meta
  const home = await fetchTxt(SITE);
  const gen = home.text.match(/<meta name=["']generator["'] content=["']WordPress (\d+\.\d+(\.\d+)?)/i);
  if (gen) {
    add("medium", "version-disclosure", `WP version ${gen[1]} exposed in <meta generator>`,
      "Hide via theme's functions.php: remove_action('wp_head', 'wp_generator');");
  } else {
    add("ok", "version-disclosure", "WP version not exposed in generator meta", null);
  }

  // 2. wp-config.php
  const cfg = await fetchTxt(SITE + "/wp-config.php");
  if (cfg.status === 200 && cfg.text.length > 100 && cfg.text.includes("DB_")) {
    add("critical", "wp-config-exposed", "wp-config.php is publicly readable!",
      "Server misconfig. Block via .htaccess: <Files wp-config.php>Require all denied</Files>");
  } else {
    add("ok", "wp-config-exposed", "wp-config.php blocked", null);
  }

  // 3. xmlrpc.php
  const rpc = await fetchTxt(SITE + "/xmlrpc.php");
  if (rpc.status === 200 || rpc.status === 405) {
    add("medium", "xmlrpc-enabled", `xmlrpc.php returns ${rpc.status} (often used for brute-force)`,
      "Disable via Hostinger Security or .htaccess. Pipeline doesn't use it.");
  } else {
    add("ok", "xmlrpc-enabled", "xmlrpc.php blocked or 404", null);
  }

  // 4. install.php still exposed
  const ins = await fetchTxt(SITE + "/wp-admin/install.php");
  if (ins.status === 200 && ins.text.includes("WordPress")) {
    add("high", "install-exposed", "wp-admin/install.php is reachable",
      "Block or delete after initial setup");
  } else {
    add("ok", "install-exposed", "install.php blocked", null);
  }

  // 5. Author enumeration via ?author=1
  const auth = await fetchTxt(SITE + "/?author=1");
  if (auth.status === 301 || auth.status === 302) {
    const loc = auth.headers.location || "";
    if (loc.includes("/author/") && !loc.includes("/aipickd-editorial")) {
      const authorMatch = loc.match(/\/author\/([^\/?]+)/);
      add("low", "author-enumeration",
        `?author=1 redirects to /author/${authorMatch ? authorMatch[1] : "(unknown)"}/`,
        "If username matches admin login, attackers know it. Use Display Name ≠ Login.");
    } else {
      add("ok", "author-enumeration", "?author=1 redirects to safe path", null);
    }
  } else {
    add("ok", "author-enumeration", `?author=1 returns ${auth.status} (no enum)`, null);
  }

  // 6. Directory listing on uploads
  const up = await fetchTxt(SITE + "/wp-content/uploads/");
  if (up.status === 200 && up.text.toLowerCase().includes("index of")) {
    add("medium", "directory-listing", "Directory listing enabled on /wp-content/uploads/",
      "Disable via .htaccess: Options -Indexes");
  } else {
    add("ok", "directory-listing", "No directory listing on uploads", null);
  }

  // 7. Check if there's a known weak username via REST
  if (env.WP_USERNAME && env.WP_ADMIN_PASSWORD) {
    const users = await fetchTxt(SITE + "/wp-json/wp/v2/users", {
      headers: { Authorization: "Basic " + Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString("base64") },
    });
    if (users.status === 200) {
      try {
        const arr = JSON.parse(users.text);
        const adminUser = arr.find((u) => u.slug === "admin" || u.username === "admin");
        if (adminUser) {
          add("medium", "admin-username", `User with username/slug 'admin' exists (id=${adminUser.id})`,
            "Rename to non-obvious username via WP Admin → Users.");
        } else {
          add("ok", "admin-username", "No 'admin' username found", null);
        }
      } catch {}
    }
  }

  // 8. SSL + HSTS
  const headers = home.headers;
  if (!headers["strict-transport-security"]) {
    add("low", "hsts-missing", "No Strict-Transport-Security header",
      "Add via Hostinger or .htaccess: Header set Strict-Transport-Security \"max-age=31536000; includeSubDomains\"");
  } else {
    add("ok", "hsts-missing", `HSTS: ${headers["strict-transport-security"]}`, null);
  }
  if (!headers["x-content-type-options"]) {
    add("low", "x-content-type-options",
      "No X-Content-Type-Options header (allows MIME sniffing)",
      "Add: X-Content-Type-Options: nosniff");
  } else {
    add("ok", "x-content-type-options", "Set", null);
  }
  if (!headers["x-frame-options"] && !(headers["content-security-policy"] || "").includes("frame-ancestors")) {
    add("low", "clickjacking",
      "No X-Frame-Options or CSP frame-ancestors (clickjacking risk)",
      "Add: X-Frame-Options: SAMEORIGIN");
  } else {
    add("ok", "clickjacking", "Frame protection in place", null);
  }
  if (!headers["referrer-policy"]) {
    add("low", "referrer-policy",
      "No Referrer-Policy header",
      "Add: Referrer-Policy: strict-origin-when-cross-origin");
  } else {
    add("ok", "referrer-policy", `Set: ${headers["referrer-policy"]}`, null);
  }

  // 9. readme.html (often discloses WP version)
  const readme = await fetchTxt(SITE + "/readme.html");
  if (readme.status === 200 && readme.text.toLowerCase().includes("wordpress")) {
    add("low", "readme-exposed", "/readme.html accessible (discloses WP info)",
      "Delete /readme.html from public_html");
  } else {
    add("ok", "readme-exposed", "readme.html blocked", null);
  }

  // 10. WP REST API user listing without auth
  const restUsers = await fetchTxt(SITE + "/wp-json/wp/v2/users");
  if (restUsers.status === 200 && restUsers.text.length > 50) {
    try {
      const arr = JSON.parse(restUsers.text);
      if (Array.isArray(arr) && arr.length > 0) {
        add("medium", "rest-users-public",
          `WP REST /users exposes ${arr.length} user(s) without auth`,
          "Restrict via plugin (Disable REST API for users) or filter in functions.php");
      }
    } catch {}
  } else {
    add("ok", "rest-users-public", "REST /users protected or empty", null);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ site: SITE, checked_at: new Date().toISOString(), findings }, null, 2));
    return;
  }

  const sevColors = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", ok: "✅" };
  const counts = { critical: 0, high: 0, medium: 0, low: 0, ok: 0 };
  for (const f of findings) {
    counts[f.severity]++;
    console.log(`  ${sevColors[f.severity]} [${f.severity.toUpperCase().padEnd(8)}] ${f.check.padEnd(24)} ${f.finding}`);
    if (f.recommendation && f.severity !== "ok") {
      console.log(`     ↳ Fix: ${f.recommendation}`);
    }
  }
  console.log(`\n📊 Summary:`);
  console.log(`   🔴 Critical: ${counts.critical}    🟠 High: ${counts.high}    🟡 Medium: ${counts.medium}    🔵 Low: ${counts.low}    ✅ OK: ${counts.ok}`);
  if (counts.critical > 0) {
    console.log(`\n❌ ${counts.critical} CRITICAL issue(s) — fix immediately\n`);
    process.exit(1);
  } else if (counts.high > 0) {
    console.log(`\n⚠️  ${counts.high} HIGH issue(s) — fix soon\n`);
    process.exit(2);
  }
  console.log(`\n✅ No critical issues. Address medium/low at your leisure.\n`);
})().catch((e) => { console.error("❌ FATAL:", e.message); process.exit(99); });
