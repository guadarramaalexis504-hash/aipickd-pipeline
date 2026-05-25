#!/usr/bin/env node
/**
 * AIPickd — Republish HTML for articles affected by mdToHtml bugs
 *
 * Pulls recently-published articles from Supabase, re-renders their
 * HTML using the CURRENT mdToHtml() (which strips GPT code fences and
 * drops the duplicate leading H1), and PATCHes the WP post with the
 * cleaned content. Skips Supabase mutations — only WP content is
 * rewritten, source-of-truth markdown stays intact.
 *
 * Designed for the 2026-05-25 incident where 12 articles published
 * with leftover "```markdown" fences and a duplicate H1. Safe to re-run
 * — idempotent: re-rendering the same markdown twice produces the
 * same HTML.
 *
 * Usage:
 *   node scripts/fix-stale-html.js                       # dry-run, last 24h
 *   node scripts/fix-stale-html.js --go                  # actually patch WP
 *   node scripts/fix-stale-html.js --go --hours 6        # only last 6h
 *   node scripts/fix-stale-html.js --go --slug foo-2026  # single article
 */

const { loadEnv } = require("./lib/env");

const env = loadEnv();
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  WP_USERNAME,
  WP_ADMIN_PASSWORD,
} = env;

const args = process.argv.slice(2);
const DO_GO = args.includes("--go");
const HOURS = parseInt(args[args.indexOf("--hours") + 1]) || 24;
const SLUG = args.includes("--slug") ? args[args.indexOf("--slug") + 1] : null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
if (!WP_USERNAME || !WP_ADMIN_PASSWORD) {
  console.error("❌ Missing WP_USERNAME / WP_ADMIN_PASSWORD");
  process.exit(2);
}

const SUPA_HEADERS = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};
const WP_AUTH = "Basic " + Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
const UA = "Mozilla/5.0 (compatible; AIPickd-HTMLFix/1.0)";

// ── Same mdToHtml as run-pipeline.js (with fence + H1 fixes) ────────────
function mdToHtml(md) {
  md = (md || "").replace(/<!--[\s\S]*?-->/g, "");

  md = md.trim();
  md = md.replace(/^```[a-zA-Z]*\s*\n/, "");
  md = md.replace(/\n?```\s*$/, "");
  md = md.replace(/^```[a-zA-Z]*\s*$/gm, "");
  md = md.replace(/^#\s+.+\n+/, "");

  let h = md;
  h = h.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  h = h.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  h = h.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  h = h.replace(/\*\*([^\*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*([^\*]+)\*/g, "<em>$1</em>");
  h = h.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" rel="nofollow sponsored" target="_blank">$1</a>'
  );
  h = h.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
  h = h.replace(/^- (.+)$/gm, "<li>$1</li>");
  h = h.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>\n${m}</ul>\n`);
  return h
    .split("\n\n")
    .map((b) => {
      const t = b.trim();
      if (!t) return "";
      if (/^<(h[1-6]|ul|ol|blockquote|table|pre|div)/i.test(t)) return t;
      return `<p>${t}</p>`;
    })
    .join("\n\n");
}

// Affiliate disclosure block — matches what run-pipeline.js prepends
function affiliateDisclosure() {
  return (
    '<div class="aipickd-disclosure" style="background:#f0f8ff;border-left:4px solid #4a90e2;padding:12px 16px;margin:16px 0;border-radius:4px;">' +
    '<strong>⚡ Disclosure:</strong> This article contains affiliate links. If you purchase through our links, we may earn a commission at no extra cost to you. We only recommend tools we\'ve evaluated and trust.' +
    "</div>\n\n"
  );
}

async function supaGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: SUPA_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Supabase GET ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function wpPatch(postId, body) {
  const r = await fetch(`https://aipickd.com/wp-json/wp/v2/posts/${postId}`, {
    method: "POST", // WP REST API accepts POST for updates
    headers: {
      Authorization: WP_AUTH,
      "Content-Type": "application/json",
      "User-Agent": UA,
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`WP PATCH posts/${postId}: ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

(async () => {
  const since = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();

  let query;
  if (SLUG) {
    query = `articles?slug=eq.${encodeURIComponent(SLUG)}&select=id,title,slug,content_markdown,wp_post_id,published_at`;
  } else {
    query = `articles?status=eq.published&published_at=gte.${since}&wp_post_id=not.is.null&select=id,title,slug,content_markdown,wp_post_id,published_at&order=published_at.desc`;
  }
  const articles = await supaGet(query);

  console.log(`\n📋 Found ${articles.length} candidate article(s) (last ${HOURS}h${SLUG ? `, slug=${SLUG}` : ""})\n`);

  let fixed = 0;
  let skipped = 0;
  let failed = 0;

  for (const a of articles) {
    const md = (a.content_markdown || "")
      .replace(/\[AFFILIATE:[^\]]+\]([^\[]*)\[\/AFFILIATE\]/gi, "$1")
      .replace(/\[AFFILIATE:[^\]]+\]/gi, "")
      .replace(/\[\/AFFILIATE\]/gi, "");

    // Detect whether THIS article was actually affected.
    const hasFence = /```/.test(a.content_markdown || "");
    const hasDupH1 = (() => {
      const m = (a.content_markdown || "").match(/^#\s+(.+?)\s*$/m);
      if (!m || !a.title) return false;
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
      return norm(m[1]) === norm(a.title);
    })();

    if (!hasFence && !hasDupH1) {
      console.log(`  ⏩ ${a.slug} — clean (no fence, no dup-H1), skipping`);
      skipped++;
      continue;
    }

    const flags = [];
    if (hasFence) flags.push("fence");
    if (hasDupH1) flags.push("dup-H1");
    console.log(`  🔧 ${a.slug} — ${flags.join("+")} → re-render`);

    if (!DO_GO) {
      console.log(`     (dry-run — pass --go to actually patch WP post ${a.wp_post_id})`);
      continue;
    }

    try {
      const html = affiliateDisclosure() + mdToHtml(md);
      await wpPatch(a.wp_post_id, { content: html });
      console.log(`     ✅ WP post ${a.wp_post_id} updated (${html.length} bytes)`);
      fixed++;
    } catch (e) {
      console.error(`     ❌ ${e.message?.slice(0, 200)}`);
      failed++;
    }
  }

  console.log(`\n📊 Summary: fixed=${fixed} skipped=${skipped} failed=${failed} (dry-run=${!DO_GO})`);
  if (!DO_GO && (fixed + failed === 0) && articles.some((a) => /```/.test(a.content_markdown || ""))) {
    console.log(`\n💡 Run again with --go to actually patch the affected articles.`);
  }
})();
