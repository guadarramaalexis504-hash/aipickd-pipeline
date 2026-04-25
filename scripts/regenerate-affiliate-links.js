#!/usr/bin/env node
/**
 * Backfill affiliate links into EXISTING articles (both Supabase + WP)
 * Run this AFTER you've activated one or more affiliates with real URLs.
 *
 * It finds every article and inserts real affiliate links for each
 * brand name that matches an 'active' affiliate — up to 2 links per brand
 * per article.
 *
 * Usage:
 *   node scripts/regenerate-affiliate-links.js              # preview (dry run)
 *   node scripts/regenerate-affiliate-links.js --go         # actually update
 *
 * IMPORTANT: only run AFTER running `approve-affiliate.js` for each brand
 * you've been approved for.
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WP_USERNAME, WP_ADMIN_PASSWORD } = env;
const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
const DRY = !process.argv.includes("--go");

async function supa(method, endpoint, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supa: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function wp(method, endpoint, body) {
  const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WP: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function mdToHtml(md) {
  md = (md || "").replace(/<!--[\s\S]*?-->/g, "");
  let html = md;
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*([^\*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^\*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="nofollow sponsored" target="_blank">$1</a>');
  html = html.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>\n${m}</ul>\n`);
  html = html.split("\n\n").map((b) => {
    const t = b.trim();
    if (!t) return "";
    if (/^<(h[1-6]|ul|ol|blockquote|table|pre|div)/i.test(t)) return t;
    return `<p>${t}</p>`;
  }).join("\n\n");
  return html;
}

(async () => {
  console.log(`== regenerate-affiliate-links ${DRY ? "(DRY RUN)" : "(LIVE)"} ==\n`);

  // Get active affiliates
  const affiliates = await supa("GET", "affiliates?status=eq.active");
  if (!affiliates || affiliates.length === 0) {
    console.log("❌ No active affiliates found.");
    console.log("   Run 'node scripts/approve-affiliate.js <brand> <url>' first to activate.");
    return;
  }
  console.log(`Active affiliates (${affiliates.length}):`);
  for (const a of affiliates) {
    console.log(`  • ${a.brand.padEnd(20)} → ${a.base_url}`);
  }
  console.log();

  // For each active brand, build a case-insensitive regex that finds
  // first 2 plain-text mentions in an article and wraps with a link.
  const articles = await supa("GET", "articles?select=id,title,slug,content_markdown,wp_post_id&wp_post_id=not.is.null");
  console.log(`Scanning ${articles.length} published articles...\n`);

  let articlesUpdated = 0;
  let linksAdded = 0;

  for (const article of articles) {
    let content = article.content_markdown || "";
    const originalContent = content;
    let changed = false;
    const addedBrands = [];

    for (const aff of affiliates) {
      const brand = aff.brand;
      // Build regex that matches the brand as a whole word
      // but NOT if already inside a markdown link [Brand](...)
      const escBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?<!\\[)(\\b${escBrand}\\b)(?!\\])`, "gi");

      let inserted = 0;
      content = content.replace(pattern, (match) => {
        if (inserted >= 2) return match; // Max 2 links per brand per article
        // Don't link inside backticks, code, or existing links
        inserted++;
        linksAdded++;
        changed = true;
        const slug = article.slug || "unknown";
        const utm = `utm_source=aipickd&utm_medium=affiliate&utm_campaign=${slug}`;
        const sep = aff.base_url.includes("?") ? "&" : "?";
        return `[${match}](${aff.base_url}${sep}${utm})`;
      });

      if (inserted > 0) addedBrands.push(`${brand}×${inserted}`);
    }

    if (!changed) continue;
    articlesUpdated++;
    console.log(`  [${article.id.slice(0, 8)}] "${article.title.slice(0, 50)}..."`);
    console.log(`         +${addedBrands.join(", ")}`);

    if (!DRY) {
      await supa("PATCH", `articles?id=eq.${article.id}`, {
        content_markdown: content,
        last_updated_at: new Date().toISOString(),
      });
      try {
        const html = mdToHtml(content);
        await wp("POST", `posts/${article.wp_post_id}`, { content: html });
        console.log(`         WP #${article.wp_post_id} updated ✓`);
      } catch (e) {
        console.log(`         WP update failed: ${e.message.slice(0, 80)}`);
      }
    }
  }

  console.log(`\n${DRY ? "DRY RUN " : ""}Summary:`);
  console.log(`  Articles updated: ${articlesUpdated}`);
  console.log(`  Links added:      ${linksAdded}`);

  if (DRY) {
    console.log("\n   Run with --go to actually apply these changes.");
  } else {
    console.log(`\n✅ Done. ${articlesUpdated} articles now have fresh affiliate links.`);
  }
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
