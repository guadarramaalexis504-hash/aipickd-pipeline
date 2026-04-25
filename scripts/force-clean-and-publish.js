#!/usr/bin/env node
/**
 * AIPickd — Aggressive cleanup + force publish
 * - Strips ALL [AFFILIATE:...] patterns (even malformed)
 * - Removes orphan [/AFFILIATE] tags
 * - Publishes ALL remaining drafts >= 1000 words
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

function aggressiveClean(md) {
  let out = md || "";
  // Remove well-formed tags: [AFFILIATE:brand]Name[/AFFILIATE] → Name
  out = out.replace(/\[AFFILIATE:[^\]]+\]([^\[]*)\[\/AFFILIATE\]/gi, "$1");
  // Remove orphan opening: [AFFILIATE:brand]Name (no closing)
  out = out.replace(/\[AFFILIATE:[^\]]+\]/gi, "");
  // Remove orphan closing: [/AFFILIATE]
  out = out.replace(/\[\/AFFILIATE\]/gi, "");
  return out;
}

(async () => {
  console.log("🧹 Aggressive cleanup + force publish\n");

  const drafts = await supa(
    "GET",
    "articles?status=in.(draft,pending_review)&wp_post_id=not.is.null&order=created_at.asc&select=id,title,slug,content_markdown,word_count,wp_post_id,meta_description"
  );

  console.log(`Processing ${drafts.length} drafts...\n`);
  let published = 0, skipped = 0, failed = 0;

  for (const [i, a] of drafts.entries()) {
    const prefix = `[${(i + 1).toString().padStart(2, "0")}/${drafts.length}]`;

    if (!a.word_count || a.word_count < 1000) {
      console.log(`${prefix} ⏩ SKIP (too short ${a.word_count}w): ${a.title.slice(0, 50)}`);
      skipped++;
      continue;
    }

    try {
      // Aggressive clean
      const cleanedMd = aggressiveClean(a.content_markdown);
      const mdChanged = cleanedMd !== a.content_markdown;

      // Update Supabase with cleaned content if changed
      if (mdChanged) {
        await supa("PATCH", `articles?id=eq.${a.id}`, {
          content_markdown: cleanedMd,
          last_updated_at: new Date().toISOString(),
        });
      }

      // Update WP post: replace content + set status to publish
      const html = mdToHtml(cleanedMd);
      await wp("POST", `posts/${a.wp_post_id}`, {
        content: html,
        status: "publish",
        date: new Date().toISOString(),
      });
      await supa("PATCH", `articles?id=eq.${a.id}`, {
        status: "published",
        published_at: new Date().toISOString(),
      });
      published++;
      console.log(`${prefix} ✅ LIVE #${a.wp_post_id}: ${a.title.slice(0, 55)}${mdChanged ? " [cleaned]" : ""}`);
    } catch (e) {
      failed++;
      console.log(`${prefix} ❌ ${a.title.slice(0, 40)}: ${e.message.slice(0, 80)}`);
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  ✅ Published LIVE: ${published}`);
  console.log(`  ⏩ Skipped (too short): ${skipped}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`\n🌐 Your site: https://aipickd.com/`);
})().catch((e) => { console.error("❌ FATAL:", e.message); process.exit(1); });
