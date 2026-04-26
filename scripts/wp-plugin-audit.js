#!/usr/bin/env node
/**
 * AIPickd — WP Plugin & User audit
 *
 * Lists installed plugins with version status, and audits user accounts
 * for risky configurations.
 *
 * Usage: node scripts/wp-plugin-audit.js
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const auth = Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString("base64");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function wp(endpoint) {
  const r = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    headers: { Authorization: `Basic ${auth}`, "User-Agent": UA },
  });
  return r.ok ? r.json() : null;
}

(async () => {
  console.log("\n🔌 Plugin Audit\n");
  const plugins = await wp("plugins");
  if (!plugins || !Array.isArray(plugins)) {
    console.log("Cannot fetch plugins (insufficient permissions)");
  } else {
    plugins.forEach((p) => {
      const status = p.status === "active" ? "✅" : "○";
      const v = p.version || "?";
      const author = (p.author || "").replace(/<[^>]+>/g, "");
      console.log(`  ${status} ${p.name.padEnd(35)} v${v.padEnd(10)} by ${author.slice(0, 40)}`);
    });
    console.log(`\nTotal: ${plugins.length} plugins (${plugins.filter((p) => p.status === "active").length} active)`);

    // Flag known-deprecated or vulnerable plugins
    const known_risky = ["timthumb", "revslider", "duplicator", "wp-file-manager"];
    const found_risky = plugins.filter((p) => known_risky.some((r) => p.plugin.includes(r)));
    if (found_risky.length > 0) {
      console.log("\n⚠️  Plugins on known-vulnerable list:");
      found_risky.forEach((p) => console.log(`   - ${p.plugin}`));
    }
  }

  console.log("\n👥 User Audit\n");
  const users = await wp("users?context=edit&per_page=100");
  if (!users || !Array.isArray(users)) {
    console.log("Cannot fetch users");
  } else {
    users.forEach((u) => {
      const roles = (u.roles || []).join(",");
      const slug = u.slug || "";
      const username = u.username || "(hidden)";
      const flag = (slug === "admin" || username === "admin" || slug === "administrator") ? " 🚨 RENAME" : "";
      console.log(`  id=${u.id}  ${username.padEnd(35)} slug=${slug.padEnd(20)} roles=${roles}${flag}`);
    });
  }

  console.log("\n🎨 Theme Audit\n");
  const themes = await wp("themes");
  if (!themes || !Array.isArray(themes)) {
    console.log("Cannot fetch themes");
  } else {
    themes.forEach((t) => {
      const active = t.status === "active" ? "✅ ACTIVE" : "○";
      console.log(`  ${active.padEnd(10)} ${t.name?.rendered || t.stylesheet}  v${t.version || "?"}  block-theme=${t.is_block_theme}`);
    });
  }

  console.log("\n💡 Recommendations:");
  console.log("   - Keep plugins on auto-update (WP Admin → Plugins → enable auto-updates per plugin)");
  console.log("   - Remove inactive plugins you don't plan to use");
  console.log("   - Use a non-obvious admin username (rename via WP Admin if needed)");
  console.log("   - Disable file editing: add to wp-config.php → define('DISALLOW_FILE_EDIT', true);");
  console.log();
})().catch((e) => { console.error("❌", e); process.exit(1); });
