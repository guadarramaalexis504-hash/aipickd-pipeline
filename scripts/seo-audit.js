#!/usr/bin/env node
/**
 * AIPickd — Weekly SEO Audit
 *
 * Audits all published WordPress posts for SEO health issues:
 *   1. Meta description missing or too long (>160 chars) — auto-fix from Supabase if available
 *   2. Title too short (<30) or too long (>70) — flag only
 *   3. Featured image missing — flag only
 *   4. Featured image alt text missing — auto-set to post title
 *   5. Thin content (<1200 words) — flag only
 *   6. Sitemap ping to Bing IndexNow after audit
 *
 * Usage:
 *   node scripts/seo-audit.js           # apply fixes (default)
 *   node scripts/seo-audit.js --fix     # same as default, explicit
 *   node scripts/seo-audit.js --dry-run # report only, no fixes applied
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── Load .env ────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, "..", ".env");
const env = {};
try {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch (e) {
  console.error("❌ Could not read .env at", envPath, ":", e.message);
  process.exit(1);
}

const {
  WP_USERNAME,
  WP_ADMIN_PASSWORD,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  DISCORD_WEBHOOK_ALERTAS,
} = env;

// Validate required credentials
for (const [k, v] of Object.entries({ WP_USERNAME, WP_ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!v) { console.error(`❌ Missing env var: ${k}`); process.exit(1); }
}

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const MODE    = DRY_RUN ? "dry-run" : "fix";

const WP_BASE = "https://aipickd.com/wp-json/wp/v2";
const WP_AUTH = "Basic " + Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
const UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

/** Fetch with exponential-backoff retry on 429 / 5xx (max 4 attempts). */
async function fetchRetry(url, opts = {}, maxAttempts = 4) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const wait = 3000 * Math.pow(2, attempt - 1); // 3s, 6s, 12s, 24s
        console.warn(`    ⏳ ${res.status} on attempt ${attempt} — waiting ${wait / 1000}s`);
        await sleep(wait);
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** WP REST GET — returns parsed JSON or throws. */
async function wpGet(endpoint) {
  const res = await fetchRetry(`${WP_BASE}/${endpoint}`, {
    headers: { Authorization: WP_AUTH, Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`WP GET ${endpoint}: ${res.status} ${await res.text().catch(() => "")}`);
  return { json: await res.json(), headers: res.headers };
}

/** WP REST POST (update). Returns parsed JSON or throws. */
async function wpPost(endpoint, body) {
  const res = await fetchRetry(`${WP_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: WP_AUTH,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WP POST ${endpoint}: ${res.status} ${text.slice(0, 200)}`);
  }
  return await res.json();
}

/** Supabase REST GET — returns array. */
async function supaGet(endpoint) {
  const res = await fetchRetry(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase GET ${endpoint}: ${res.status} ${await res.text().catch(() => "")}`);
  return await res.json();
}

// ─── Fetch ALL published WP posts (handles pagination) ────────────────────────
async function getAllPublishedPosts() {
  const posts = [];
  let page = 1;
  let totalPages = 1;

  console.log("📥 Fetching all published posts from WordPress...");
  do {
    const { json, headers } = await wpGet(
      `posts?per_page=100&page=${page}&status=publish&_fields=id,title,slug,content,featured_media,meta&context=edit`
    );
    if (!Array.isArray(json)) break;
    posts.push(...json);

    const tp = headers.get("X-WP-TotalPages");
    if (tp) totalPages = parseInt(tp, 10);
    console.log(`  Page ${page}/${totalPages} — ${posts.length} posts so far`);
    page++;

    // Small delay to avoid hammering WP
    if (page <= totalPages) await sleep(500);
  } while (page <= totalPages);

  return posts;
}

// ─── Strip HTML tags and count words ─────────────────────────────────────────
function wordCount(html) {
  if (!html) return 0;
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return 0;
  return text.split(" ").filter(Boolean).length;
}

// ─── Decode HTML entities in WP titles ───────────────────────────────────────
function decodeTitle(rendered) {
  return (rendered || "").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c)));
}

// ─── Discord webhook ──────────────────────────────────────────────────────────
async function sendDiscord(payload) {
  if (!DISCORD_WEBHOOK_ALERTAS) {
    console.warn("⚠️  DISCORD_WEBHOOK_ALERTAS not set — skipping Discord notification");
    return;
  }
  try {
    const res = await fetch(DISCORD_WEBHOOK_ALERTAS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 204 || res.ok) {
      console.log("📢 Discord report sent.");
    } else {
      console.warn("⚠️  Discord responded:", res.status, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.warn("⚠️  Discord send failed:", e.message);
  }
}

// ─── Sitemap ping to Bing ────────────────────────────────────────────────────
async function pingSitemap() {
  const url =
    "https://www.bing.com/indexnow?url=https%3A%2F%2Faipickd.com%2Fsitemap.xml&key=aipickd2026";
  try {
    const res = await fetchRetry(url, { "User-Agent": UA }, 2);
    console.log(`🔔 Bing sitemap ping: HTTP ${res.status}`);
    return res.status;
  } catch (e) {
    console.warn("⚠️  Bing sitemap ping failed:", e.message);
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const start = Date.now();
  console.log(`\n🔍 AIPickd SEO Audit — mode: ${MODE}\n${"─".repeat(50)}`);

  // ── 1. Fetch all published WP posts ────────────────────────────────────────
  const posts = await getAllPublishedPosts();
  console.log(`\n✅ Loaded ${posts.length} published posts.\n`);

  // ── 2. Fetch Supabase articles for meta description fallback ───────────────
  console.log("📦 Loading Supabase articles...");
  let supaArticles = [];
  try {
    supaArticles = await supaGet(
      "articles?select=id,title,slug,meta_description,wp_post_id,word_count&status=eq.published"
    );
    console.log(`  Found ${supaArticles.length} published articles in Supabase.\n`);
  } catch (e) {
    console.warn("  ⚠️  Could not load Supabase articles:", e.message, "\n");
  }

  // Build lookup by wp_post_id and by slug
  const supaByWpId = {};
  const supaBySlug = {};
  for (const a of supaArticles) {
    if (a.wp_post_id) supaByWpId[String(a.wp_post_id)] = a;
    if (a.slug) supaBySlug[a.slug] = a;
  }

  // ── 3. Audit counters & lists ──────────────────────────────────────────────
  const issues = {
    metaDescMissing:   { count: 0, fixed: 0, flagged: 0, posts: [] },
    metaDescTooLong:   { count: 0, fixed: 0, flagged: 0, posts: [] },
    titleTooShort:     { count: 0, flagged: 0, posts: [] },
    titleTooLong:      { count: 0, flagged: 0, posts: [] },
    noFeaturedImage:   { count: 0, flagged: 0, posts: [] },
    noAltText:         { count: 0, fixed: 0, flagged: 0, posts: [] },
    thinContent:       { count: 0, flagged: 0, posts: [] },
  };

  const errors = []; // non-fatal errors during audit

  // ── 4. Audit each post ─────────────────────────────────────────────────────
  console.log(`🔎 Auditing ${posts.length} posts...\n`);

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const postId   = post.id;
    const titleRaw = decodeTitle(post.title?.rendered || "");
    const slug     = post.slug || "";
    const content  = post.content?.rendered || "";

    // Supabase data (matched by wp_post_id then slug)
    const supa = supaByWpId[String(postId)] || supaBySlug[slug] || null;

    process.stdout.write(`  [${i + 1}/${posts.length}] Post #${postId} "${titleRaw.slice(0, 40)}"...\r`);

    // ── Check 1: Meta description ──────────────────────────────────────────
    // Yoast stores meta desc in post meta. WP REST returns meta as object when
    // context=edit and meta is registered. Key: _yoast_wpseo_metadesc
    const currentMeta = post.meta?.["_yoast_wpseo_metadesc"] || "";
    const metaMissing  = !currentMeta || currentMeta.trim() === "";
    const metaTooLong  = !metaMissing && currentMeta.length > 160;

    if (metaMissing || metaTooLong) {
      const issueKey = metaMissing ? "metaDescMissing" : "metaDescTooLong";
      issues[issueKey].count++;
      const supaDesc = supa?.meta_description?.trim() || "";

      if (supaDesc && supaDesc.length <= 160) {
        // Can fix from Supabase
        if (!DRY_RUN) {
          try {
            await wpPost(`posts/${postId}`, { meta: { _yoast_wpseo_metadesc: supaDesc } });
            issues[issueKey].fixed++;
            issues[issueKey].posts.push({ id: postId, title: titleRaw, action: "fixed", value: supaDesc.slice(0, 60) + "…" });
          } catch (e) {
            errors.push(`meta-fix #${postId}: ${e.message}`);
            issues[issueKey].flagged++;
            issues[issueKey].posts.push({ id: postId, title: titleRaw, action: "fix-failed", error: e.message });
          }
        } else {
          issues[issueKey].fixed++; // would fix
          issues[issueKey].posts.push({ id: postId, title: titleRaw, action: "would-fix", value: supaDesc.slice(0, 60) + "…" });
        }
      } else {
        // No Supabase data — just flag
        issues[issueKey].flagged++;
        issues[issueKey].posts.push({
          id: postId,
          title: titleRaw,
          action: "flagged",
          reason: metaMissing ? "missing" : `too long (${currentMeta.length} chars)`,
        });
      }
    }

    // ── Check 2: Title length ──────────────────────────────────────────────
    const titleLen = titleRaw.length;
    if (titleLen < 30) {
      issues.titleTooShort.count++;
      issues.titleTooShort.flagged++;
      issues.titleTooShort.posts.push({ id: postId, title: titleRaw, len: titleLen });
    } else if (titleLen > 70) {
      issues.titleTooLong.count++;
      issues.titleTooLong.flagged++;
      issues.titleTooLong.posts.push({ id: postId, title: titleRaw, len: titleLen });
    }

    // ── Check 3 & 4: Featured image & alt text ────────────────────────────
    const featuredMediaId = post.featured_media || 0;
    if (!featuredMediaId) {
      issues.noFeaturedImage.count++;
      issues.noFeaturedImage.flagged++;
      issues.noFeaturedImage.posts.push({ id: postId, title: titleRaw });
    } else {
      // Check alt text on the media object
      try {
        const { json: media } = await wpGet(`media/${featuredMediaId}?_fields=id,alt_text,title`);
        const altText = (media.alt_text || "").trim();

        if (!altText) {
          issues.noAltText.count++;
          // Auto-set to post title
          const newAlt = titleRaw;
          if (!DRY_RUN) {
            try {
              await wpPost(`media/${featuredMediaId}`, { alt_text: newAlt });
              issues.noAltText.fixed++;
              issues.noAltText.posts.push({ id: postId, title: titleRaw, mediaId: featuredMediaId, action: "fixed", newAlt });
            } catch (e) {
              errors.push(`alt-fix media #${featuredMediaId}: ${e.message}`);
              issues.noAltText.flagged++;
              issues.noAltText.posts.push({ id: postId, title: titleRaw, mediaId: featuredMediaId, action: "fix-failed", error: e.message });
            }
          } else {
            issues.noAltText.fixed++; // would fix
            issues.noAltText.posts.push({ id: postId, title: titleRaw, mediaId: featuredMediaId, action: "would-fix", newAlt });
          }
        }
      } catch (e) {
        // Media fetch failed — non-fatal, just log
        errors.push(`media-fetch #${featuredMediaId} (post #${postId}): ${e.message}`);
      }

      // Small courtesy delay per media request to avoid rate limiting
      await sleep(150);
    }

    // ── Check 5: Thin content ──────────────────────────────────────────────
    // Prefer Supabase word_count (already computed), fall back to counting HTML
    const words = (supa?.word_count && supa.word_count > 0)
      ? supa.word_count
      : wordCount(content);

    if (words > 0 && words < 1200) {
      issues.thinContent.count++;
      issues.thinContent.flagged++;
      issues.thinContent.posts.push({ id: postId, title: titleRaw, words });
    }

    // Courtesy delay between posts to respect WP rate limits
    await sleep(200);
  }

  // Clear the carriage-return progress line
  process.stdout.write("\n");

  // ── 5. Sitemap ping ────────────────────────────────────────────────────────
  console.log("\n🔔 Pinging Bing with sitemap URL...");
  const pingStatus = await pingSitemap();

  // ── 6. Print console summary ───────────────────────────────────────────────
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n${"═".repeat(50)}`);
  console.log(`🔍 SEO AUDIT COMPLETE (${elapsed}s) — ${posts.length} posts audited\n`);

  const fmt = (label, issue, showFix = false) => {
    const parts = [`  ${label}: ${issue.count}`];
    if (showFix) {
      if (issue.fixed > 0) parts.push(`✅ ${issue.fixed} ${DRY_RUN ? "would be fixed" : "fixed"}`);
      if (issue.flagged > 0) parts.push(`⚠️  ${issue.flagged} flagged`);
    } else {
      parts.push(`⚠️  ${issue.flagged} flagged`);
    }
    return parts.join("  ");
  };

  console.log(fmt("📝 Meta desc missing",     issues.metaDescMissing, true));
  console.log(fmt("📝 Meta desc too long",     issues.metaDescTooLong, true));
  console.log(fmt("📏 Title too short (<30)",  issues.titleTooShort));
  console.log(fmt("📏 Title too long (>70)",   issues.titleTooLong));
  console.log(fmt("🖼️  No featured image",      issues.noFeaturedImage));
  console.log(fmt("🏷️  Missing alt text",       issues.noAltText, true));
  console.log(fmt("📄 Thin content (<1200w)",  issues.thinContent));

  if (errors.length > 0) {
    console.log(`\n⚠️  ${errors.length} non-fatal errors:`);
    errors.slice(0, 10).forEach((e) => console.log(`  - ${e}`));
    if (errors.length > 10) console.log(`  ... and ${errors.length - 10} more`);
  }
  console.log(`${"═".repeat(50)}\n`);

  // ── 7. Build Discord report ────────────────────────────────────────────────
  const totalIssues =
    issues.metaDescMissing.count +
    issues.metaDescTooLong.count +
    issues.titleTooShort.count +
    issues.titleTooLong.count +
    issues.noFeaturedImage.count +
    issues.noAltText.count +
    issues.thinContent.count;

  const totalFixed =
    issues.metaDescMissing.fixed +
    issues.metaDescTooLong.fixed +
    issues.noAltText.fixed;

  const totalFlagged = totalIssues - totalFixed;

  // Thin content list (top 5 worst)
  const thinList = issues.thinContent.posts
    .sort((a, b) => a.words - b.words)
    .slice(0, 5)
    .map((p) => `• \`#${p.id}\` ${p.title.slice(0, 40)} — ${p.words} words`)
    .join("\n");

  // Title issues list (top 5)
  const titleIssueList = [
    ...issues.titleTooShort.posts.slice(0, 3).map((p) => `• \`#${p.id}\` "${p.title.slice(0, 40)}" (${p.len} chars — too short)`),
    ...issues.titleTooLong.posts.slice(0, 3).map((p) => `• \`#${p.id}\` "${p.title.slice(0, 40)}..." (${p.len} chars — too long)`),
  ].join("\n");

  // Missing images list (top 5)
  const noImgList = issues.noFeaturedImage.posts
    .slice(0, 5)
    .map((p) => `• \`#${p.id}\` ${p.title.slice(0, 50)}`)
    .join("\n");

  const modeLabel = DRY_RUN ? "🧪 Dry-run mode — no changes applied" : "🔧 Fix mode — changes applied";
  const color = totalIssues === 0 ? 0x2ecc71 : totalFlagged > 10 ? 0xe74c3c : 0xf39c12;

  const fields = [
    {
      name: "📊 Summary",
      value:
        `**Posts audited:** ${posts.length}\n` +
        `**Total issues found:** ${totalIssues}\n` +
        `**Fixed automatically:** ${totalFixed}${DRY_RUN ? " *(dry-run)*" : ""}\n` +
        `**Flagged for manual review:** ${totalFlagged}\n` +
        `**Audit duration:** ${elapsed}s`,
      inline: false,
    },
    {
      name: "📝 Meta Descriptions",
      value:
        `Missing: **${issues.metaDescMissing.count}** ` +
        `(${issues.metaDescMissing.fixed} fixed, ${issues.metaDescMissing.flagged} no fallback)\n` +
        `Too long: **${issues.metaDescTooLong.count}** ` +
        `(${issues.metaDescTooLong.fixed} fixed, ${issues.metaDescTooLong.flagged} no fallback)`,
      inline: false,
    },
    {
      name: "📏 Title Length",
      value:
        `Too short (<30 chars): **${issues.titleTooShort.count}**\n` +
        `Too long (>70 chars): **${issues.titleTooLong.count}**\n` +
        (titleIssueList ? `\n${titleIssueList}` : "*All titles OK!*"),
      inline: false,
    },
    {
      name: "🖼️ Featured Images & Alt Text",
      value:
        `No featured image: **${issues.noFeaturedImage.count}** *(flag only)*\n` +
        (noImgList ? `\n${noImgList}\n` : "") +
        `Missing alt text: **${issues.noAltText.count}** ` +
        `(${issues.noAltText.fixed} auto-fixed, ${issues.noAltText.flagged} failed)`,
      inline: false,
    },
    {
      name: "📄 Thin Content (<1200 words)",
      value:
        issues.thinContent.count === 0
          ? "✅ No thin posts!"
          : `**${issues.thinContent.count} posts** need expansion:\n${thinList || "*See logs*"}`,
      inline: false,
    },
    {
      name: "🔔 Sitemap Ping",
      value: pingStatus
        ? `Bing IndexNow: HTTP ${pingStatus}`
        : "⚠️ Ping failed — check logs",
      inline: false,
    },
  ];

  if (errors.length > 0) {
    fields.push({
      name: "⚠️ Errors",
      value: errors.slice(0, 5).join("\n").slice(0, 1000),
      inline: false,
    });
  }

  const discordPayload = {
    username: "AIPickd SEO Bot",
    avatar_url: "https://aipickd.com/wp-content/uploads/aipickd-logo.png",
    embeds: [
      {
        title: `🔍 Weekly SEO Audit — aipickd.com`,
        description: `${modeLabel}\nRan at <t:${Math.floor(Date.now() / 1000)}:F>`,
        color,
        fields,
        footer: {
          text: `AIPickd • scripts/seo-audit.js • ${new Date().toISOString()}`,
        },
      },
    ],
  };

  await sendDiscord(discordPayload);

  // ── 8. Exit code: 0 if no issues, 1 if issues found ──────────────────────
  if (totalIssues > 0) {
    console.log(`⚠️  ${totalIssues} SEO issues found. ${totalFixed} fixed, ${totalFlagged} need attention.`);
    process.exit(0); // exit 0 so GH Actions doesn't mark workflow as failed for expected issues
  } else {
    console.log("✅ No SEO issues found! Blog is healthy.");
    process.exit(0);
  }
})().catch((e) => {
  console.error("\n❌ Fatal error in SEO audit:", e.message);
  console.error(e.stack);
  process.exit(1);
});
