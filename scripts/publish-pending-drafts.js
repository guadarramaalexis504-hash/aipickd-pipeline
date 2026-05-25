#!/usr/bin/env node
/**
 * AIPickd — Manual publish trigger for pending drafts
 *
 * Use when run-pipeline.js generation works but publish silently no-ops.
 * Reuses the same Supabase + WP plumbing as the main pipeline but bypasses
 * generation entirely, so it's safe to run cheaply (no OpenAI cost) just to
 * verify the publish path.
 *
 * Usage:
 *   node scripts/publish-pending-drafts.js              # publish up to 5 drafts
 *   node scripts/publish-pending-drafts.js --limit 1    # publish exactly 1
 *   node scripts/publish-pending-drafts.js --dry-run    # log without writing
 *
 * Designed to be called via GitHub Actions workflow_dispatch or locally
 * with valid WP_ADMIN_PASSWORD. Failures are visible: WP auth (401/403)
 * stops immediately with a clear error message instead of silently looping.
 */

const { loadEnv } = require("./lib/env");
const { notifyAlert } = require("./notify.js");

const env = loadEnv();
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  WP_USERNAME,
  WP_ADMIN_PASSWORD,
} = env;

const args = process.argv.slice(2);
const LIMIT = parseInt(args[args.indexOf("--limit") + 1]) || 5;
const DRY_RUN = args.includes("--dry-run");

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
  Prefer: "return=representation",
};
const WP_AUTH = "Basic " + Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
const UA = "Mozilla/5.0 (compatible; AIPickd-PublishManual/1.0)";

function ts() {
  const d = new Date();
  return `[${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}Z]`;
}

async function supaGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPA_HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Supabase GET ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function supaPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "PATCH", headers: SUPA_HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Supabase PATCH ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function wpReq(method, endpoint, body) {
  const r = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    method,
    headers: {
      Authorization: WP_AUTH,
      "Content-Type": "application/json",
      "User-Agent": UA,
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`WP ${method} ${endpoint}: ${r.status} ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// Minimal MD→HTML (matches the main pipeline so output is identical)
function mdToHtml(md) {
  md = (md || "").replace(/<!--[\s\S]*?-->/g, "");

  // Strip GPT-leftover code fences (```markdown ... ```) — these render
  // as literal "`markdown" in the published article if not removed.
  md = md.trim();
  md = md.replace(/^```[a-zA-Z]*\s*\n/, "");
  md = md.replace(/\n?```\s*$/, "");
  md = md.replace(/^```[a-zA-Z]*\s*$/gm, "");

  // Drop leading H1 — WordPress already renders the post title as <h1>,
  // so a leading "# Title" duplicates the heading (bad SEO).
  md = md.replace(/^#\s+.+\n+/, "");

  let h = md;
  h = h.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  h = h.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  h = h.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  h = h.replace(/\*\*([^\*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*([^\*]+)\*/g, "<em>$1</em>");
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="nofollow sponsored" target="_blank">$1</a>');
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

(async () => {
  console.log(`${ts()} ▶ publish-pending-drafts (limit=${LIMIT}, dry-run=${DRY_RUN})`);

  // 1. Pre-flight: confirm WP auth works BEFORE we touch any drafts.
  console.log(`${ts()} pre-flight: WP auth check…`);
  try {
    await wpReq("GET", "users/me?context=edit");
    console.log(`${ts()} ✅ WP auth OK`);
  } catch (e) {
    console.error(`${ts()} ❌ WP auth FAILED: ${e.message}`);
    notifyAlert(
      `🚨 **publish-pending-drafts pre-flight failed**\n` +
      `WP auth returned ${e.status || "?"}.\n` +
      `Action: regenerate the Application Password at \`/wp-admin/profile.php\` and update \`WP_ADMIN_PASSWORD\` in GitHub Secrets.\n` +
      `Error: \`${e.message?.slice(0, 200)}\``,
      "critical"
    ).catch(() => {});
    process.exit(3);
  }

  // 2. Fetch pending drafts (raw, no JOIN — keeps the query simple).
  const drafts = await supaGet(`articles?status=eq.draft&wp_post_id=is.null&order=created_at.asc&limit=${LIMIT}&select=id,title,slug,meta_description,content_markdown,article_type,word_count,niche_id`);
  console.log(`${ts()} fetched ${drafts.length} draft(s)`);

  if (drafts.length === 0) {
    console.log(`${ts()} nothing to do — no pending drafts`);
    return;
  }

  // 3. Fetch niches once for category mapping
  const niches = await supaGet("niches?select=id,slug").catch(() => []);
  const nicheBySlug = Object.fromEntries((niches || []).map((n) => [n.id, n.slug]));

  // 4. WP categories
  const cats = await wpReq("GET", "categories?per_page=20&_fields=id,slug");
  const catMap = Object.fromEntries((cats || []).map((c) => [c.slug, c.id]));
  const nicheCatMap = {
    "ai-writing": catMap["ai-writing"],
    "ai-business": catMap["ai-business"],
    "ai-image-video": catMap["ai-image-video"],
    "ai-coding": catMap["ai-coding"],
    "ai-hosting": catMap["ai-infrastructure"],
  };

  // 5. Iterate
  let published = 0, failed = 0;
  for (const a of drafts) {
    const t0 = Date.now();
    console.log(`${ts()} 📤 "${a.title?.slice(0, 60)}"`);
    try {
      // Strip leftover [AFFILIATE:...] tags
      const md = (a.content_markdown || "")
        .replace(/\[AFFILIATE:[^\]]+\]([^\[]*)\[\/AFFILIATE\]/gi, "$1")
        .replace(/\[AFFILIATE:[^\]]+\]/gi, "")
        .replace(/\[\/AFFILIATE\]/gi, "");
      const html = mdToHtml(md);
      const nicheSlug = nicheBySlug[a.niche_id];
      const catId = nicheCatMap[nicheSlug];

      if (DRY_RUN) {
        console.log(`${ts()} (dry-run) would POST to WP: ${html.length} bytes, cat=${catId || "none"}`);
        continue;
      }

      // Guard: slug already in WP?
      const existing = await wpReq("GET", `posts?slug=${encodeURIComponent(a.slug)}&_fields=id,link`).catch(() => []);
      if (Array.isArray(existing) && existing.length > 0) {
        const e = existing[0];
        console.log(`${ts()} ⏩ already in WP (id=${e.id}) — linking`);
        await supaPatch(`articles?id=eq.${a.id}`, {
          status: "published",
          wp_post_id: e.id,
          wp_url: e.link,
          published_at: new Date().toISOString(),
        });
        published++;
        continue;
      }

      const post = await wpReq("POST", "posts", {
        title: a.title,
        slug: a.slug,
        excerpt: a.meta_description || "",
        content: html,
        status: "publish",
        categories: catId ? [catId] : [],
      });

      await supaPatch(`articles?id=eq.${a.id}`, {
        status: "published",
        wp_post_id: post.id,
        wp_url: post.link,
        published_at: new Date().toISOString(),
      });

      published++;
      console.log(`${ts()} ✅ published #${post.id} in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${post.link}`);
    } catch (e) {
      failed++;
      console.error(`${ts()} ❌ "${a.title?.slice(0, 60)}": ${e.message?.slice(0, 200)}`);
      notifyAlert(
        `🚫 **publish-pending-drafts iter failed**\n` +
        `Article: \`${a.id}\` · \`${a.slug}\`\n` +
        `Error: \`${e.message?.slice(0, 300)}\``,
        "warning"
      ).catch(() => {});
    }
  }

  console.log(`${ts()} ◀ done — published=${published} failed=${failed}`);
  if (published > 0 && !DRY_RUN) {
    notifyAlert(
      `✅ **publish-pending-drafts: ${published} drafts published** (failed=${failed})`,
      "info"
    ).catch(() => {});
  }
})().catch((e) => {
  console.error("\n❌ FATAL:", e.message);
  process.exit(1);
});
