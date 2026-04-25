#!/usr/bin/env node
/**
 * AIPickd — Fix wrong year in article titles & content
 * Finds articles with 2023/2024/2025 in title and replaces with 2026
 * in both Supabase and WordPress.
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
  if (!res.ok) throw new Error(`Supabase: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function wp(method, endpoint, body) {
  const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
  const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WP: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function fixYears(str) {
  if (!str) return str;
  // Replace standalone 2023/2024/2025 with 2026 (avoid matching within longer numbers)
  return str
    .replace(/\b202[345]\b/g, "2026")
    // Also fix common AI phrasings
    .replace(/\bin early 2026\b/gi, "in early 2026")
    .replace(/\bas of late 2026\b/gi, "as of April 2026");
}

(async () => {
  console.log("== fix-wrong-year.js ==\n");

  // Find articles with wrong year in title
  const articles = await supa(
    "GET",
    "articles?or=(title.ilike.*2023*,title.ilike.*2024*,title.ilike.*2025*,slug.ilike.*2023*,slug.ilike.*2024*,slug.ilike.*2025*)"
  );

  if (!articles || articles.length === 0) {
    console.log("No articles with 2023/2024/2025 in title/slug. ✅");
    return;
  }

  console.log(`Found ${articles.length} article(s) to fix:\n`);
  for (const a of articles) {
    const newTitle = fixYears(a.title);
    const newSlug = fixYears(a.slug);
    const newContent = fixYears(a.content_markdown);
    const newMeta = fixYears(a.meta_description);

    console.log(`  [${a.id.slice(0, 8)}] "${a.title}"`);
    console.log(`         → "${newTitle}"`);

    // Update Supabase
    await supa("PATCH", `articles?id=eq.${a.id}`, {
      title: newTitle,
      slug: newSlug,
      content_markdown: newContent,
      meta_description: newMeta,
      last_updated_at: new Date().toISOString(),
    });

    // Update WP if already published there
    if (a.wp_post_id) {
      try {
        // Simple MD→HTML again
        let html = (newContent || "").replace(/<!--[\s\S]*?-->/g, "");
        html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
        html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
        html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
        html = html.replace(/\*\*([^\*]+)\*\*/g, "<strong>$1</strong>");
        html = html.replace(/\*([^\*]+)\*/g, "<em>$1</em>");
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="nofollow sponsored" target="_blank">$1</a>');
        html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
        html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>\n${m}</ul>\n`);
        html = html.split("\n\n").map((b) => {
          const t = b.trim();
          if (!t) return "";
          if (/^<(h[1-6]|ul|ol|blockquote|table|pre|div)/i.test(t)) return t;
          return `<p>${t}</p>`;
        }).join("\n\n");

        await wp("POST", `posts/${a.wp_post_id}`, {
          title: newTitle,
          slug: newSlug,
          excerpt: newMeta,
          content: html,
        });
        console.log(`         WP #${a.wp_post_id} updated ✓`);
      } catch (e) {
        console.log(`         WP update failed: ${e.message.slice(0, 80)}`);
      }
    } else {
      console.log(`         (not in WP yet)`);
    }
  }

  console.log(`\n✅ Fixed ${articles.length} article(s).`);
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
