#!/usr/bin/env node
/**
 * AIPickd — Manual end-to-end publish test
 * Mimics workflow 03 (Publish to WordPress) WITHOUT DALL-E to keep it fast.
 *
 * Usage:
 *   node scripts/publish-one-article.js
 *
 * Publishes the next 'draft' article in Supabase to WordPress as DRAFT,
 * then updates Supabase with wp_post_id + wp_url + status='pending_review'.
 *
 * We use WP status=draft (not publish) so you can review each post before
 * it goes public. Flip status to 'publish' after you've inspected one.
 */

const fs = require("fs");
const path = require("path");

// --- Parse .env ---
const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  WP_USERNAME,
  WP_ADMIN_PASSWORD,
  AUTO_PUBLISH,
} = env;

const WP_STATUS = (AUTO_PUBLISH || "false").toLowerCase() === "true" ? "publish" : "draft";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !WP_USERNAME || !WP_ADMIN_PASSWORD) {
  console.error("Missing env vars. Check .env file.");
  process.exit(1);
}

// --- Helpers ---
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
  if (!res.ok) throw new Error(`Supabase ${method} ${endpoint}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function wp(method, endpoint, body) {
  const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
  const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WP ${method} ${endpoint}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// Simple MD -> HTML (matches workflow 03 logic)
function mdToHtml(md) {
  md = (md || "").replace(/<!--[\s\S]*?-->/g, "");
  let html = md;
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*([^\*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^\*]+)\*/g, "<em>$1</em>");
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" rel="nofollow sponsored" target="_blank">$1</a>'
  );
  html = html.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>\n${m}</ul>\n`);

  // GFM tables
  html = html.replace(
    /(\|.+\|\n\|[\s\-\|:]+\|\n(?:\|.+\|\n?)+)/g,
    (m) => {
      const lines = m.trim().split("\n");
      const header = lines[0].split("|").slice(1, -1).map((c) => c.trim());
      const rows = lines.slice(2).map((l) =>
        l.split("|").slice(1, -1).map((c) => c.trim())
      );
      const thead = `<thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      return `<table class="wp-block-table">${thead}${tbody}</table>`;
    }
  );

  // Paragraphs
  html = html
    .split("\n\n")
    .map((block) => {
      const t = block.trim();
      if (!t) return "";
      if (/^<(h[1-6]|ul|ol|blockquote|table|pre|div)/i.test(t)) return t;
      return `<p>${t}</p>`;
    })
    .join("\n\n");

  return html;
}

// --- Main ---
(async () => {
  console.log("== AIPickd publish-one-article ==\n");

  // 1) Fetch next draft
  console.log("1) Fetching next draft article from Supabase...");
  const articles = await supa(
    "GET",
    "articles?status=eq.draft&order=created_at.asc&limit=1"
  );
  if (!articles || articles.length === 0) {
    console.log("No draft articles found. Nothing to do.");
    return;
  }
  const article = articles[0];
  console.log(`   Article: ${article.title}`);
  console.log(`   ID: ${article.id}`);
  console.log(`   Slug: ${article.slug}`);
  console.log(`   Content length: ${article.content_markdown.length} chars\n`);

  // 2) Convert MD -> HTML
  console.log("2) Converting markdown to HTML...");
  const html = mdToHtml(article.content_markdown);
  console.log(`   HTML length: ${html.length} chars\n`);

  // 3) POST to WordPress (status from AUTO_PUBLISH env)
  console.log(`3) POSTing to WordPress as ${WP_STATUS.toUpperCase()}...`);
  const wpPost = await wp("POST", "posts", {
    title: article.title,
    slug: article.slug,
    excerpt: article.meta_description || "",
    content: html,
    status: WP_STATUS,
    meta: {
      _yoast_wpseo_metadesc: article.meta_description || "",
    },
  });
  console.log(`   WP Post ID: ${wpPost.id}`);
  console.log(`   WP URL: ${wpPost.link}`);
  console.log(`   Edit URL: https://aipickd.com/wp-admin/post.php?post=${wpPost.id}&action=edit\n`);

  // 4) Update Supabase
  console.log("4) Updating Supabase article record...");
  const finalStatus = WP_STATUS === "publish" ? "published" : "pending_review";
  await supa("PATCH", `articles?id=eq.${article.id}`, {
    status: finalStatus,
    wp_post_id: wpPost.id,
    wp_url: wpPost.link,
    published_at: new Date().toISOString(),
  });
  console.log("   Supabase updated.\n");

  console.log("✅ DONE. Go review the post in WordPress admin:");
  console.log(`   https://aipickd.com/wp-admin/post.php?post=${wpPost.id}&action=edit`);
  console.log("\n   If it looks good, change status to 'publish' in WP.");
})().catch((e) => {
  console.error("❌ ERROR:", e.message);
  process.exit(1);
});
