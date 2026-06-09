#!/usr/bin/env node
/**
 * AIPickd — CTA Injector
 *
 * Does two things to published articles:
 *   1. Injects reading-time badge after the first <p> tag
 *      <p class="aipickd-reading-time">⏱ X min read</p>
 *      (skipped if badge already present)
 *
 *   2. Injects affiliate CTA block for articles mentioning an active affiliate.
 *      Placed before the last </ul>, or at 80% through content if no </ul>.
 *      (skipped if CTA block already present)
 *
 * Usage:
 *   node scripts/cta-injector.js              # last 6 hours, dry run
 *   node scripts/cta-injector.js --hours 24   # last 24 hours, dry run
 *   node scripts/cta-injector.js --all        # all published articles, dry run
 *   node scripts/cta-injector.js --all --dry-run   # explicit dry run
 *   node scripts/cta-injector.js --all --go        # actually apply changes
 *   node scripts/cta-injector.js --hours 12 --go   # last 12 hours, apply
 */

"use strict";

const { loadEnv } = require("./lib/env");
const { buildLocalizedCta } = require("./lib/cta");
const { normalizeLanguage } = require("./lib/spanish-gate");
const env = loadEnv();

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  WP_USERNAME,
  WP_ADMIN_PASSWORD,
  DISCORD_WEBHOOK_ALERTAS,
} = env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env");
  process.exit(1);
}
if (!WP_USERNAME || !WP_ADMIN_PASSWORD) {
  console.error("ERROR: WP_USERNAME and WP_ADMIN_PASSWORD are required in .env");
  process.exit(1);
}

const WP_AUTH = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
const WP_BASE = "https://aipickd.com/wp-json/wp/v2";

// ─────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────
const argv = process.argv.slice(2);
const ALL     = argv.includes("--all");
const DRY_RUN = !argv.includes("--go");  // default is dry-run; need --go to write
const hoursIdx = argv.indexOf("--hours");
const HOURS   = hoursIdx !== -1 ? parseInt(argv[hoursIdx + 1], 10) || 6 : 6;

// ─────────────────────────────────────────────
// Retry logic: exponential backoff, 5 attempts
// ─────────────────────────────────────────────
async function withRetry(fn, label, retries = 5) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 16000); // 1s, 2s, 4s, 8s, 16s
      console.warn(`  [retry ${attempt}/${retries}] ${label}: ${err.message.slice(0, 80)} — waiting ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
// Supabase helper
// ─────────────────────────────────────────────
async function supa(method, endpoint, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey:        SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer:        "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ─────────────────────────────────────────────
// WordPress helpers (with retry)
// ─────────────────────────────────────────────
async function wpGet(endpoint) {
  return withRetry(async () => {
    const res = await fetch(`${WP_BASE}/${endpoint}`, {
      headers: { Authorization: `Basic ${WP_AUTH}` },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`WP GET ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }, `WP GET ${endpoint}`);
}

async function wpPost(postId, body) {
  return withRetry(async () => {
    const res = await fetch(`${WP_BASE}/posts/${postId}`, {
      method:  "POST",
      headers: {
        Authorization:  `Basic ${WP_AUTH}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`WP POST ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }, `WP POST posts/${postId}`);
}

// ─────────────────────────────────────────────
// Fetch ALL published WP posts (handles pagination)
// ─────────────────────────────────────────────
async function fetchAllWpPosts(afterDate) {
  const posts = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    let url = `posts?status=publish&per_page=${perPage}&page=${page}&context=edit&_fields=id,slug,content,date`;
    if (afterDate) {
      url += `&after=${encodeURIComponent(afterDate)}`;
    }

    let batch;
    try {
      batch = await withRetry(async () => {
        const res = await fetch(`${WP_BASE}/${url}`, {
          headers: { Authorization: `Basic ${WP_AUTH}` },
        });
        const text = await res.text();
        // 400 with "rest_post_invalid_page_number" means we've gone past the last page
        if (res.status === 400 && text.includes("rest_post_invalid_page_number")) return null;
        if (!res.ok) throw new Error(`WP GET posts page=${page}: ${res.status} ${text.slice(0, 200)}`);
        return JSON.parse(text);
      }, `WP fetch posts page ${page}`);
    } catch (e) {
      console.warn(`  Stopping pagination at page ${page}: ${e.message.slice(0, 80)}`);
      break;
    }

    if (!batch || batch.length === 0) break;
    posts.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }

  return posts;
}

// ─────────────────────────────────────────────
// Reading-time injection
// ─────────────────────────────────────────────

/**
 * Estimate word count from HTML content.
 * Strips tags, then counts whitespace-delimited tokens.
 */
function countWordsInHtml(html) {
  const stripped = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return stripped ? stripped.split(" ").length : 0;
}

/**
 * Calculate reading time in minutes, rounded up (200 wpm).
 * Minimum 1 min.
 */
function calcReadingTime(wordCount) {
  return Math.max(1, Math.ceil(wordCount / 200));
}

/**
 * Inject reading-time badge after the first <p> tag.
 * Returns null if badge already exists or no <p> found.
 */
function injectReadingTime(html, wordCount) {
  if (html.includes('class="aipickd-reading-time"')) return null;
  if (html.includes("class='aipickd-reading-time'")) return null;

  const mins   = calcReadingTime(wordCount);
  const badge  = `<p class="aipickd-reading-time">⏱ ${mins} min read</p>`;

  // Find the end of the first <p> opening tag (e.g. "<p>" or "<p class="...">")
  const firstPMatch = html.match(/<p(\s[^>]*)?>/)
  if (!firstPMatch) return null;

  const insertAt = firstPMatch.index + firstPMatch[0].length;
  return html.slice(0, insertAt) + badge + html.slice(insertAt);
}

// ─────────────────────────────────────────────
// CTA-block injection
// ─────────────────────────────────────────────

/**
 * Build the CTA HTML block.
 */
function buildCta(brand, baseUrl, slug, language = "en") {
  return buildLocalizedCta({ brand, baseUrl, slug, language });
}

/**
 * Find which (if any) active affiliate is mentioned in the HTML content.
 * Returns the first match, or null.
 */
function findMentionedAffiliate(html, affiliates) {
  // Strip tags for plain-text search
  const text = html.replace(/<[^>]+>/g, " ");
  for (const aff of affiliates) {
    const escaped = aff.brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(text)) return aff;
  }
  return null;
}

/**
 * Inject CTA block:
 *   - Before the last </ul> in the document, OR
 *   - At 80% through the content (character-count based)
 * Returns null if CTA already exists.
 */
function injectCta(html, brand, baseUrl, slug, language = "en") {
  if (html.includes('class="aipickd-cta"')) return null;
  if (html.includes("class='aipickd-cta'")) return null;

  const ctaBlock = buildCta(brand, baseUrl, slug, language);

  // Find last </ul>
  const lastUlIdx = html.lastIndexOf("</ul>");
  if (lastUlIdx !== -1) {
    return html.slice(0, lastUlIdx) + ctaBlock + "\n" + html.slice(lastUlIdx);
  }

  // Fallback: 80% through content
  const insertAt = Math.floor(html.length * 0.8);
  // Try to land on a tag boundary — find next ">" after insertAt
  const nextTag = html.indexOf(">", insertAt);
  const pos     = nextTag !== -1 ? nextTag + 1 : insertAt;
  return html.slice(0, pos) + "\n" + ctaBlock + "\n" + html.slice(pos);
}

// ─────────────────────────────────────────────
// Discord alert helper
// ─────────────────────────────────────────────
async function discordAlert(message) {
  if (!DISCORD_WEBHOOK_ALERTAS) return;
  try {
    await fetch(DISCORD_WEBHOOK_ALERTAS, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        username: "AIPickd CTA Injector",
        embeds: [{
          title:       "⚡ CTA Injector Report",
          description: String(message).slice(0, 4000),
          color:       0x00cc66,
          footer:      { text: "aipickd.com • cta-injector.js" },
          timestamp:   new Date().toISOString(),
        }],
      }),
    });
  } catch {
    // non-fatal
  }
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
(async () => {
  console.log(`\n═══ AIPickd CTA Injector ════════════════════════════════`);
  console.log(`  Mode:     ${DRY_RUN ? "DRY RUN (add --go to apply)" : "LIVE WRITE"}`);
  console.log(`  Scope:    ${ALL ? "ALL published articles" : `articles from last ${HOURS}h`}`);
  console.log(`════════════════════════════════════════════════════════\n`);

  // ── 1. Load active affiliates from Supabase ─────────────────────────────────
  console.log("Fetching active affiliates from Supabase...");
  let affiliates = [];
  try {
    affiliates = await supa("GET", "affiliates?status=eq.active&select=brand,base_url");
    console.log(`  ${affiliates.length} active affiliate(s): ${affiliates.map((a) => a.brand).join(", ") || "none"}\n`);
  } catch (e) {
    console.error("ERROR fetching affiliates:", e.message);
    await discordAlert(`ERROR fetching affiliates: ${e.message}`);
    process.exit(1);
  }

  // ── 2. Determine date filter for WP posts ───────────────────────────────────
  let afterDate = null;
  if (!ALL) {
    const cutoff = new Date(Date.now() - HOURS * 60 * 60 * 1000);
    afterDate = cutoff.toISOString();
    console.log(`Fetching WP posts published after ${afterDate}...`);
  } else {
    console.log("Fetching ALL published WP posts (paginated)...");
  }

  // ── 3. Fetch WP posts ────────────────────────────────────────────────────────
  let wpPosts = [];
  try {
    wpPosts = await fetchAllWpPosts(afterDate);
    console.log(`  Fetched ${wpPosts.length} post(s) from WordPress.\n`);
  } catch (e) {
    console.error("ERROR fetching WP posts:", e.message);
    await discordAlert(`ERROR fetching WP posts: ${e.message}`);
    process.exit(1);
  }

  if (wpPosts.length === 0) {
    console.log("No posts to process. Done.");
    return;
  }

  // ── 4. Process each post ────────────────────────────────────────────────────
  let languageBySlug = new Map();
  try {
    const articleRows = await supa("GET", "articles?status=eq.published&select=slug,language");
    languageBySlug = new Map(
      (Array.isArray(articleRows) ? articleRows : []).map((article) => [article.slug, normalizeLanguage(article.language)])
    );
  } catch (e) {
    console.warn(`Could not load article languages; defaulting CTA language to English: ${e.message.slice(0, 120)}`);
  }

  const stats = {
    total:         wpPosts.length,
    readingAdded:  0,
    ctaAdded:      0,
    alreadyHasRT:  0,
    alreadyHasCta: 0,
    noAffiliate:   0,
    errors:        0,
    updated:       [],
  };

  for (const post of wpPosts) {
    const postId = post.id;
    const slug   = post.slug || String(postId);
    const language = normalizeLanguage(languageBySlug.get(slug));

    // WP REST API with context=edit gives raw content in post.content.raw
    // rendered is the HTML after shortcode/block processing
    const rawHtml = (post.content && (post.content.raw || post.content.rendered)) || "";
    if (!rawHtml.trim()) {
      console.log(`  [${postId}] ${slug}: empty content, skipping`);
      continue;
    }

    let html       = rawHtml;
    let changed    = false;
    const changes  = [];

    // ── Step A: Reading time ───────────────────────────────────────────────
    const alreadyRT = html.includes('class="aipickd-reading-time"') || html.includes("class='aipickd-reading-time'");
    if (alreadyRT) {
      stats.alreadyHasRT++;
    } else {
      const wordCount  = countWordsInHtml(html);
      const injected   = injectReadingTime(html, wordCount);
      if (injected !== null) {
        const mins = calcReadingTime(wordCount);
        html     = injected;
        changed  = true;
        changes.push(`reading-time: ${mins} min (${wordCount} words)`);
        stats.readingAdded++;
      }
    }

    // ── Step B: Affiliate CTA ──────────────────────────────────────────────
    const alreadyCta = html.includes('class="aipickd-cta"') || html.includes("class='aipickd-cta'");
    if (alreadyCta) {
      stats.alreadyHasCta++;
    } else if (affiliates.length > 0) {
      const match = findMentionedAffiliate(html, affiliates);
      if (match) {
        const injected = injectCta(html, match.brand, match.base_url, slug, language);
        if (injected !== null) {
          html    = injected;
          changed = true;
          changes.push(`CTA: ${match.brand}`);
          stats.ctaAdded++;
        }
      } else {
        stats.noAffiliate++;
      }
    } else {
      stats.noAffiliate++;
    }

    // ── Report and optionally write ────────────────────────────────────────
    if (!changed) continue;

    console.log(`  [${postId}] ${slug}`);
    changes.forEach((c) => console.log(`    + ${c}`));
    stats.updated.push({ postId, slug, changes });

    if (DRY_RUN) continue;

    try {
      await wpPost(postId, { content: html });
      console.log(`    => WP #${postId} updated ✓`);
    } catch (e) {
      console.error(`    => ERROR updating WP #${postId}: ${e.message.slice(0, 120)}`);
      stats.errors++;
    }
  }

  // ── 5. Summary ─────────────────────────────────────────────────────────────
  console.log(`\n════════════════════════════════════════════════════════`);
  console.log(`  ${DRY_RUN ? "DRY RUN " : ""}Results`);
  console.log(`  Posts scanned:          ${stats.total}`);
  console.log(`  Reading-time injected:  ${stats.readingAdded}`);
  console.log(`  CTA injected:           ${stats.ctaAdded}`);
  console.log(`  Already had RT badge:   ${stats.alreadyHasRT}`);
  console.log(`  Already had CTA:        ${stats.alreadyHasCta}`);
  console.log(`  No matching affiliate:  ${stats.noAffiliate}`);
  if (stats.errors > 0)
    console.log(`  WP write errors:        ${stats.errors}`);
  console.log(`════════════════════════════════════════════════════════`);

  if (DRY_RUN && (stats.readingAdded > 0 || stats.ctaAdded > 0)) {
    console.log(`\n  Run with --go to apply these changes.\n`);
  }

  // ── 6. Discord notification (non-dry-run only) ─────────────────────────────
  if (!DRY_RUN && (stats.readingAdded > 0 || stats.ctaAdded > 0)) {
    const lines = [
      `Posts scanned: **${stats.total}**`,
      `Reading-time injected: **${stats.readingAdded}**`,
      `CTA blocks injected: **${stats.ctaAdded}**`,
      stats.errors > 0 ? `WP write errors: **${stats.errors}**` : null,
    ].filter(Boolean);

    if (stats.updated.length > 0) {
      const listItems = stats.updated.slice(0, 10).map((u) => `• \`${u.slug}\` — ${u.changes.join(", ")}`);
      if (stats.updated.length > 10) listItems.push(`• …and ${stats.updated.length - 10} more`);
      lines.push("", "**Updated posts:**", ...listItems);
    }

    await discordAlert(lines.join("\n"));
  }
})().catch((e) => {
  console.error("\nFATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
});
