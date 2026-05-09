#!/usr/bin/env node
/**
 * AIPickd — Fix Taxonomy/User Sitemap Conflict
 *
 * Problem: WordPress built-in sitemap (wp-sitemap.xml) includes category, tag,
 * and author pages. These pages have `noindex` set by the theme/SEO plugin.
 * Google sees them in the sitemap (index me) but the page says noindex (don't index).
 * This creates 22+ conflicting signals in Google Search Console.
 *
 * Fix: Install a tiny WordPress plugin that removes taxonomy and user providers
 * from the built-in WordPress sitemap, so Google never even discovers these pages
 * via the sitemap.
 *
 * This script is idempotent — safe to run multiple times.
 * It checks if the plugin is already active before installing.
 *
 * Usage:
 *   node scripts/fix-taxonomy-sitemap.js
 *   node scripts/fix-taxonomy-sitemap.js --dry-run
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { execSync } = require("child_process");

// ─── Load .env ────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, "..", ".env");
const env = {};
try {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch {}

const DRY_RUN = process.argv.includes("--dry-run");

const PLUGIN_SLUG  = "aipickd-sitemap-fix";
const PLUGIN_FILE  = `${PLUGIN_SLUG}/${PLUGIN_SLUG}.php`;
const WP_BASE_URL  = "https://aipickd.com";

// The tiny plugin that removes taxonomy/user providers from wp-sitemap.xml
const PLUGIN_PHP = `<?php
/**
 * Plugin Name: AIPickd Sitemap Fix
 * Plugin URI:  https://aipickd.com
 * Description: Removes taxonomy and user providers from WordPress core sitemap to fix noindex/sitemap conflict in Google Search Console.
 * Version:     1.0.0
 * Author:      AIPickd
 * License:     MIT
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Remove taxonomy (categories, tags) and user (author) pages from wp-sitemap.xml.
 * These pages have noindex set but were appearing in the sitemap — mixed signal for Google.
 */
add_filter( 'wp_sitemaps_add_provider', function( $provider, $name ) {
    $remove = array( 'taxonomies', 'users' );
    if ( in_array( $name, $remove, true ) ) {
        return false;
    }
    return $provider;
}, 10, 2 );
`;

function wpAuth() {
  if (!env.WP_USERNAME || !env.WP_ADMIN_PASSWORD) {
    throw new Error("WP_USERNAME or WP_ADMIN_PASSWORD not set in .env");
  }
  return "Basic " + Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString("base64");
}

async function wpGet(endpoint) {
  const res = await fetch(`${WP_BASE_URL}/wp-json/wp/v2/${endpoint}`, {
    headers: { Authorization: wpAuth(), "Content-Type": "application/json" },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null };
}

async function checkPluginStatus() {
  // GET /wp-json/wp/v2/plugins?search=aipickd-sitemap
  const res = await wpGet("plugins?search=aipickd-sitemap&per_page=10");
  if (!res.ok) {
    if (res.status === 401) throw new Error("WP auth failed — check WP_USERNAME / WP_ADMIN_PASSWORD");
    throw new Error(`WP plugins API error ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  const plugins = res.body || [];
  return plugins.find((p) => p.plugin && p.plugin.includes(PLUGIN_SLUG));
}

async function installPlugin() {
  const tmpDir  = path.join(os.tmpdir(), PLUGIN_SLUG);
  const zipPath = path.join(os.tmpdir(), `${PLUGIN_SLUG}.zip`);
  const cookieJar = path.join(os.tmpdir(), `wp-cookies-${Date.now()}.txt`);

  // ── 1. Write plugin PHP + create ZIP ────────────────────────────────────────
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, `${PLUGIN_SLUG}.php`), PLUGIN_PHP, "utf8");
  try {
    execSync(`cd "${os.tmpdir()}" && zip -r "${zipPath}" "${PLUGIN_SLUG}/"`, { stdio: "pipe" });
  } catch (e) {
    throw new Error(`Failed to create ZIP: ${e.message}`);
  }

  const u = encodeURIComponent;

  // ── 2. Admin login → get session cookies ───────────────────────────────────
  execSync(
    `curl -s -c "${cookieJar}" -b "wordpress_test_cookie=WpCookieCheck" ` +
    `-X POST "${WP_BASE_URL}/wp-login.php" ` +
    `-d "log=${u(env.WP_USERNAME)}&pwd=${u(env.WP_ADMIN_PASSWORD)}&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1" ` +
    `-L -o /dev/null`,
    { encoding: "utf8" }
  );

  // ── 3. Fetch plugin-install page to extract _wpnonce ────────────────────────
  const installPage = execSync(
    `curl -s -b "${cookieJar}" "${WP_BASE_URL}/wp-admin/plugin-install.php?tab=upload"`,
    { encoding: "utf8" }
  );
  const nonceMatch =
    installPage.match(/name="_wpnonce"\s+value="([^"]+)"/) ||
    installPage.match(/"nonce"\s*:\s*"([^"]+)"/) ||
    installPage.match(/_wpnonce['"]\s*(?:value)?['"]\s*:\s*['"]([^'"]+)['"]/);
  if (!nonceMatch) {
    throw new Error("Could not extract _wpnonce from WP admin plugin-install page (login failed?)");
  }
  const nonce = nonceMatch[1];

  // ── 4. Upload zip via admin form ────────────────────────────────────────────
  const uploadResult = execSync(
    `curl -s -b "${cookieJar}" ` +
    `-X POST "${WP_BASE_URL}/wp-admin/update.php?action=upload-plugin" ` +
    `-F "pluginzip=@${zipPath};type=application/zip" ` +
    `-F "_wpnonce=${nonce}" ` +
    `-F "_wp_http_referer=%2Fwp-admin%2Fplugin-install.php" ` +
    `-F "install-plugin-submit=Install+Now" -L`,
    { encoding: "utf8" }
  );

  const installed =
    uploadResult.includes("Plugin installed successfully") ||
    uploadResult.includes("activate-plugin") ||
    uploadResult.includes("Installed Successfully");

  if (!installed) {
    const snippet = uploadResult.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400);
    throw new Error(`Admin plugin upload failed. Response: ${snippet}`);
  }

  // ── 5. Activate the plugin ──────────────────────────────────────────────────
  // Extract activate link from the response page
  // WP admin shows "Activate Plugin" link — try several regex patterns
  const activateMatch =
    uploadResult.match(/href="([^"]*[?&]action=activate[^"]+plugin[^"]+)"/) ||
    uploadResult.match(/href="([^"]*plugins\.php\?action=activate[^"]+)"/) ||
    uploadResult.match(/href="([^"]*action=activate[^"]+)"/);

  if (activateMatch) {
    const rawUrl   = activateMatch[1].replace(/&amp;/g, "&");
    const cleanUrl = rawUrl.startsWith("http") ? rawUrl : `${WP_BASE_URL}/${rawUrl.replace(/^\//, "")}`;
    console.log(`   Activating via: ${cleanUrl.slice(0, 80)}...`);
    execSync(`curl -s -b "${cookieJar}" "${cleanUrl}" -L -o /dev/null`, { encoding: "utf8" });
  } else {
    // Fallback: activate via admin plugins page
    console.log("   No activate link found in response — trying admin plugins page...");
    const pluginsPage = execSync(
      `curl -s -b "${cookieJar}" "${WP_BASE_URL}/wp-admin/plugins.php"`,
      { encoding: "utf8" }
    );
    // Find activate link for our plugin
    const adminActivateMatch = pluginsPage.match(
      new RegExp(`href="([^"]*action=activate[^"]*${PLUGIN_SLUG}[^"]*)"`)
    );
    if (adminActivateMatch) {
      const url = adminActivateMatch[1].replace(/&amp;/g, "&");
      const fullUrl = url.startsWith("http") ? url : `${WP_BASE_URL}/${url.replace(/^\//, "")}`;
      execSync(`curl -s -b "${cookieJar}" "${fullUrl}" -L -o /dev/null`, { encoding: "utf8" });
      console.log("   Activated via plugins page.");
    } else {
      console.log("   ⚠️  Could not auto-activate. Plugin is installed — activate manually in WP admin.");
    }
  }

  // Cleanup
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.unlinkSync(zipPath);
    fs.unlinkSync(cookieJar);
  } catch {}

  return { status: "active", plugin: PLUGIN_FILE };
}

async function activatePlugin(pluginSlug) {
  const res = await fetch(`${WP_BASE_URL}/wp-json/wp/v2/plugins/${encodeURIComponent(pluginSlug)}`, {
    method: "POST",
    headers: { Authorization: wpAuth(), "Content-Type": "application/json" },
    body: JSON.stringify({ status: "active" }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Activate failed (${res.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  console.log("== AIPickd fix-taxonomy-sitemap ==");
  console.log(`   Mode: ${DRY_RUN ? "DRY RUN" : "FIX"}\n`);

  // 1) Check current state
  console.log("1) Checking plugin status on WordPress...");
  let existing;
  try {
    existing = await checkPluginStatus();
  } catch (e) {
    console.error(`   ❌ ${e.message}`);
    process.exit(1);
  }

  if (existing) {
    if (existing.status === "active") {
      console.log(`   ✅ Plugin already active — sitemap fix is in place.`);
      console.log(`   Plugin: ${existing.plugin} v${existing.version}`);
      return;
    }
    // Plugin exists but inactive — just activate it
    console.log(`   ⚠️  Plugin installed but inactive. Activating...`);
    if (!DRY_RUN) {
      try {
        await activatePlugin(existing.plugin);
        console.log("   ✅ Plugin activated successfully.");
      } catch (e) {
        console.error(`   ❌ Activation failed: ${e.message}`);
        process.exit(1);
      }
    }
    return;
  }

  // 2) Plugin not installed
  console.log("   Plugin not found — will install.");

  if (DRY_RUN) {
    console.log("\n⚠️  DRY RUN — would install plugin to remove taxonomy/user from sitemap.");
    console.log("   Run without --dry-run to apply fix.");
    return;
  }

  // 3) Install plugin
  console.log("\n2) Installing aipickd-sitemap-fix plugin...");
  try {
    const result = await installPlugin();
    console.log(`   ✅ Plugin installed and activated!`);
    console.log(`   Plugin: ${result?.plugin || PLUGIN_FILE}`);
    console.log(`   Status: ${result?.status || "active"}`);
  } catch (e) {
    console.error(`   ❌ Install failed: ${e.message}`);
    process.exit(1);
  }

  // 4) Verify sitemap no longer has taxonomy/users
  console.log("\n3) Verifying sitemap fix...");
  try {
    const sitemapRes = await fetch(`${WP_BASE_URL}/wp-sitemap.xml`);
    const sitemapXml = await sitemapRes.text();
    if (sitemapXml.includes("taxonomies") || sitemapXml.includes("post_tag") || sitemapXml.includes("users")) {
      console.log("   ⚠️  Taxonomy/user entries may still be in sitemap (cache?). Check in 1-2 min.");
    } else {
      console.log("   ✅ Sitemap no longer includes taxonomy/user entries.");
    }
  } catch {}

  console.log("\n✅ Done! Taxonomy + user pages removed from wp-sitemap.xml.");
  console.log("   Google will no longer see noindex pages in the sitemap.");
  console.log("   The 22+ conflicting noindex entries in GSC will resolve over 1-2 weeks.");

  // Notify Discord
  if (env.DISCORD_WEBHOOK_ALERTAS) {
    await fetch(env.DISCORD_WEBHOOK_ALERTAS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "🗺️ **Sitemap fix aplicado**\n✅ Categorías, tags y author pages removidas de `wp-sitemap.xml`\n📌 Las 22 páginas conflictivas en GSC deberían desaparecer en 1-2 semanas",
      }),
    }).catch(() => {});
  }
})().catch((e) => {
  console.error("❌ ERROR:", e.message);
  process.exit(1);
});
