#!/usr/bin/env node
/**
 * Strips unreplaced [AFFILIATE:brand]Name[/AFFILIATE] tags from articles.
 * These leaked through for the content-bank articles that were bulk-imported
 * before the pipeline existed. Now that all affiliates are 'pending', the
 * right behavior is to strip the tags (leaving just brand name) until
 * actual affiliate URLs are available.
 *
 * Usage: node scripts/strip-unreplaced-affiliate-tags.js
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

// Same MD→HTML as run-pipeline.js
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
  html = html.replace(/(\|.+\|\n\|[\s\-\|:]+\|\n(?:\|.+\|\n?)+)/g, (m) => {
    const lines = m.trim().split("\n");
    const header = lines[0].split("|").slice(1, -1).map((c) => c.trim());
    const rows = lines.slice(2).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
    const thead = `<thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
    return `<table class="wp-block-table">${thead}${tbody}</table>`;
  });
  html = html.split("\n\n").map((b) => {
    const t = b.trim();
    if (!t) return "";
    if (/^<(h[1-6]|ul|ol|blockquote|table|pre|div)/i.test(t)) return t;
    return `<p>${t}</p>`;
  }).join("\n\n");
  return html;
}

(async () => {
  console.log("== strip-unreplaced-affiliate-tags ==\n");

  const tagRegex = /\[AFFILIATE:([^\]]+)\]([^\[]+)\[\/AFFILIATE\]/gi;

  // Find articles with unreplaced tags
  const articles = await supa("GET", "articles?select=id,title,content_markdown,wp_post_id");
  const needFix = articles.filter((a) => tagRegex.test(a.content_markdown || ""));

  if (needFix.length === 0) {
    console.log("No articles have unreplaced [AFFILIATE:...] tags. ✅");
    return;
  }

  console.log(`Found ${needFix.length} article(s) with unreplaced tags:\n`);

  // Try to resolve tags with active affiliates first, else strip
  const affiliates = await supa("GET", "affiliates?status=eq.active");
  console.log(`  Active affiliates available: ${affiliates.length}\n`);

  for (const a of needFix) {
    // Count tags for logging
    const tags = [...(a.content_markdown.match(/\[AFFILIATE:[^\]]+\]/g) || [])];
    const brands = new Set(tags.map((t) => t.match(/\[AFFILIATE:([^\]]+)\]/)[1].trim().toLowerCase()));

    const affiliatesUsed = new Set();
    const firstSeen = new Map();
    let linked = a.content_markdown.replace(tagRegex, (_, brand, name) => {
      const clean = brand.trim().toLowerCase();
      const aff = affiliates.find((x) => x.brand.toLowerCase() === clean);
      if (!aff) return name; // strip tag, keep brand name as plain text
      affiliatesUsed.add(aff.id);
      const seen = firstSeen.get(clean) || 0;
      firstSeen.set(clean, seen + 1);
      if (seen >= 2) return name;
      const slug = a.slug || "unknown";
      const utm = `utm_source=aipickd&utm_medium=affiliate&utm_campaign=${slug}`;
      const sep = aff.base_url.includes("?") ? "&" : "?";
      return `[${name}](${aff.base_url}${sep}${utm})`;
    });
    // Final sweep: strip any lingering tags
    linked = linked.replace(tagRegex, (_, __, name) => name);

    console.log(`  [${a.id.slice(0, 8)}] "${a.title.slice(0, 50)}..."`);
    console.log(`         ${tags.length} tag(s) across brands: ${[...brands].join(", ")}`);
    console.log(`         ${affiliatesUsed.size} linked, ${brands.size - affiliatesUsed.size} stripped`);

    // Update Supabase
    await supa("PATCH", `articles?id=eq.${a.id}`, {
      content_markdown: linked,
      affiliates_mentioned: [...affiliatesUsed],
      last_updated_at: new Date().toISOString(),
    });

    // Update WP if already pushed
    if (a.wp_post_id) {
      try {
        const html = mdToHtml(linked);
        await wp("POST", `posts/${a.wp_post_id}`, { content: html });
        console.log(`         WP #${a.wp_post_id} updated ✓`);
      } catch (e) {
        console.log(`         WP update failed: ${e.message.slice(0, 80)}`);
      }
    }
  }

  console.log(`\n✅ Cleaned ${needFix.length} article(s).`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
