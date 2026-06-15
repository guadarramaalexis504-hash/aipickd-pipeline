#!/usr/bin/env node
/**
 * AIPickd — Title & Meta Description Refresher
 *
 * Rewrites flat/boring meta titles and descriptions for old published
 * articles using GPT-4o-mini with psychological CTR hooks (brackets,
 * power words, curiosity gaps, numbers).
 *
 * Flow per article:
 *   1. Pull oldest published articles from Supabase (title_refreshed_at IS NULL)
 *   2. Call GPT-4o-mini for a high-CTR title + meta description
 *   3. Update WordPress post (title, excerpt, Yoast SEO fields)
 *   4. Update Supabase (title, meta_description, title_refreshed_at)
 *   5. Report summary to Discord #pipeline-status
 *
 * Usage:
 *   node scripts/refresh-titles.js                # refresh up to 5 oldest articles
 *   node scripts/refresh-titles.js --limit 10     # refresh up to 10
 *   node scripts/refresh-titles.js --dry-run      # preview changes, no writes
 *   node scripts/refresh-titles.js --dry-run --limit 3
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY,
 *           WP_USERNAME, WP_ADMIN_PASSWORD, DISCORD_WEBHOOK_PIPELINE
 */

"use strict";

const { loadEnv } = require("./lib/env");
const { fetchWithRetry } = require("./lib/http");
const { notifyPipeline, notifyAlert } = require("./notify");

const env = loadEnv();

// ── CLI args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Math.max(1, parseInt(argv[limitIdx + 1]) || 5) : 5;

// ── Constants ───────────────────────────────────────────────────────────────
const WP_HOST = "https://aipickd.com";
const WP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Inter-request delay to dodge Hostinger rate limits (~1.5s is safe)
const REQUEST_DELAY_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Validate env ────────────────────────────────────────────────────────────
const REQUIRED_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "WP_USERNAME",
  "WP_ADMIN_PASSWORD",
];

function validateEnv() {
  const missing = REQUIRED_VARS.filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env var(s): ${missing.join(", ")}`);
    process.exit(2);
  }
}

// ── Supabase helper ─────────────────────────────────────────────────────────
async function supa(method, endpoint, body) {
  const res = await fetchWithRetry(
    `${env.SUPABASE_URL}/rest/v1/${endpoint}`,
    {
      method,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    { timeout: 30_000, retries: 3 }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Supabase ${method} ${endpoint}: ${res.status} ${text.slice(0, 300)}`
    );
  }
  return text ? JSON.parse(text) : null;
}

// ── WordPress helper ────────────────────────────────────────────────────────
async function wpUpdate(postId, body) {
  const auth = Buffer.from(
    `${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`
  ).toString("base64");

  const res = await fetchWithRetry(
    `${WP_HOST}/wp-json/wp/v2/posts/${postId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "User-Agent": WP_USER_AGENT,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    },
    { timeout: 60_000, retries: 3 }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `WP POST posts/${postId}: ${res.status} ${text.slice(0, 300)}`
    );
  }
  return text ? JSON.parse(text) : null;
}

// ── WP auth preflight ─────────────────────────────────────────────────────────
// Confirms the WP Basic-auth credentials actually work BEFORE we burn GPT calls
// on N articles. If the admin password was rotated without updating the
// GitHub Secret (a real failure mode — see wp-password-rotation-reminder.yml),
// every per-article write 401s and the run dies with N opaque errors. This
// turns that into ONE clear, actionable message.
async function wpAuthCheck() {
  const auth = Buffer.from(
    `${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`
  ).toString("base64");
  const res = await fetchWithRetry(
    `${WP_HOST}/wp-json/wp/v2/users/me?context=edit`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "User-Agent": WP_USER_AGENT,
        Accept: "application/json",
      },
    },
    { timeout: 30_000, retries: 2 }
  );
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`WP auth preflight ${res.status}: ${body}`);
  }
}

// ── GPT-4o-mini title rewriter ──────────────────────────────────────────────
async function rewriteTitle(article) {
  // Rotate the lead angle per-article (deterministic from id/slug) so the site
  // doesn't end up with 50 near-identical "Which Wins? [Tested]" titles.
  const ANGLES = [
    'Lead with a "Which Wins?" curiosity gap.',
    'Lead with a first-person "We Tested / I Tried / After X hours" angle.',
    'Lead with a "The Truth / What Nobody Tells You" knowledge gap.',
    'Lead with a specific number + "Actually Work / Ranked".',
    'Lead with a "Worth It?" value question.',
  ];
  const seed = [...String(article.id || article.slug || article.title || "")].reduce((s, c) => s + c.charCodeAt(0), 0);
  const angleHint = ANGLES[seed % ANGLES.length];
  const systemPrompt = `You are an SEO headline specialist optimizing for Google SERP click-through rate.

Rewrite the title and meta description for this AI tools article.

Current title: "${article.title}"
Primary keyword: "${article.primary_keyword}"
Article type: "${article.article_type}"

TITLE RULES (40-60 chars — Backlinko's highest-CTR range):
- Include the primary keyword; END with the year (2026 / (2026) / [2026]); front-load the hook.
- Numbers lift CTR ~36% — add a SPECIFIC number when it fits (7, 9, $0, "30 Days", "20 Tested").
- Use 2-3 TRUST power words: Honest, Tested, Proven, Actually Work, Worth It, Real, Ranked.
- Open a curiosity/knowledge gap or a clear STAKE: "Which Wins?", "Worth It?", "The Truth", "What Nobody Tells You".
- A first-person testing angle builds trust + intrigue: "We Tested", "I Tried", "After 50 Hours".
- ONE bracket value-add max: [Tested] [Honest] [Free] [Ranked] [Step-by-Step].
- High-CTR formulas by type — pick the PUNCHIEST and VARY them:
  * comparison: "X vs Y: Which Wins in 2026? [Tested]" / "X vs Y — I Tested Both, Here's the Winner"
  * review: "X Review 2026: Worth It? [Tested]" / "X Review: The Truth After Testing [2026]"
  * listicle: "7 Best X That Actually Work in 2026 [Tested]" / "Top 7 X: We Tested 20, These Won (2026)"
  * how-to: "How to X in 2026 [Step-by-Step]" / "How to X Without Y — 2026 Guide"
- NEVER flat/boring: "Best X 2026", "X Guide", "Everything About X", "Ultimate Guide to X".

META DESCRIPTION RULES (150-160 chars):
- Start with a benefit or result, not "In this article..."
- Include the primary keyword in first 80 chars
- End with a CTA or curiosity hook
- Use numbers/specifics when possible

BANNED phrases (in BOTH title and meta) — these are AI-tells that read as spam and hurt CTR. NEVER use them:
"elevate your", "unlock (your|the) potential", "supercharge", "take it to the next level", "in today's (fast-paced )?world", "game-changer", "game changer", "seamless(ly)?", "revolutionize", "dive into", "harness the power", "look no further", "in the realm of", "when it comes to".
Write like a sharp, specific human reviewer — concrete nouns and numbers, not hype.

PREFERRED ANGLE for THIS title (keeps titles varied across the site, not 50 identical patterns): ${angleHint}

Return JSON: { "title": "...", "meta_description": "...", "title_chars": N, "meta_chars": N }`;

  const res = await fetchWithRetry(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content:
              "Generate the optimized title and meta description. Return ONLY the JSON object, no markdown fences.",
          },
        ],
        max_tokens: 300,
        temperature: 0.7,
        response_format: { type: "json_object" },
      }),
    },
    { timeout: 30_000, retries: 2 }
  );

  const data = await res.json();

  if (!res.ok) {
    const errMsg = data?.error?.message || JSON.stringify(data).slice(0, 200);
    throw new Error(`OpenAI API error: ${errMsg}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned empty content");
  }

  // Parse the JSON response (strip markdown fences if present)
  const cleaned = content
    .replace(/^```json\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const result = JSON.parse(cleaned);

  if (!result.title || !result.meta_description) {
    throw new Error(
      `GPT returned incomplete JSON: ${JSON.stringify(result).slice(0, 200)}`
    );
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  validateEnv();

  const startTime = Date.now();
  console.log(
    `\n🔄 AIPickd Title Refresh${DRY_RUN ? " (DRY RUN)" : ""} — limit ${LIMIT}\n`
  );

  // ── 1. Fetch un-refreshed published articles, highest-opportunity first ───
  // Order by Search Console impressions desc (NULLs last) so once GSC data
  // exists we rewrite the titles of the most-seen pages first — the biggest
  // CTR wins. Falls back to oldest-first when gsc_impressions is null.
  let articles;
  try {
    articles = await supa(
      "GET",
      "articles?" +
        "status=eq.published" +
        "&title_refreshed_at=is.null" +
        "&wp_post_id=not.is.null" +
        // Exclude Spanish: rewriteTitle uses English-only CTR rules + English
        // power words and would overwrite ES titles/meta with English ones. The
        // Spanish system (spanish-ctr.js) isn't wired here yet.
        "&language=neq.es" +
        "&select=id,title,slug,primary_keyword,article_type,meta_description,wp_post_id,published_at,gsc_impressions" +
        "&order=gsc_impressions.desc.nullslast,published_at.asc" +
        `&limit=${LIMIT}`
    );
  } catch (err) {
    if (err.message.includes("42703") || err.message.includes("does not exist")) {
      console.error(
        "\n❌ Column 'title_refreshed_at' does not exist in articles table.\n" +
        "   Run this migration in Supabase SQL Editor:\n\n" +
        "   ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS title_refreshed_at TIMESTAMPTZ DEFAULT NULL;\n\n" +
        "   (Full migration file: supabase/migrations/20260531000000_title_refreshed_at.sql)\n"
      );
      process.exit(2);
    }
    throw err;
  }

  if (!Array.isArray(articles) || articles.length === 0) {
    console.log("   All articles already refreshed. Nothing to do.");
    return;
  }

  console.log(
    `   Found ${articles.length} article(s) to refresh.\n`
  );

  // ── 1b. WP auth preflight (skip in dry-run — no writes happen there) ──────
  if (!DRY_RUN) {
    try {
      await wpAuthCheck();
      console.log("   WP auth preflight: OK\n");
    } catch (e) {
      console.error(`   ❌ ${e.message}`);
      await notifyAlert(
        `Title Refresh aborted — WordPress auth failed.\n${e.message.slice(0, 220)}\n` +
          `If the WP password was rotated, update the WP_ADMIN_PASSWORD GitHub Secret.`,
        "critical"
      ).catch(() => {});
      process.exit(1);
    }
  }

  // ── 2. Process each article ───────────────────────────────────────────────
  const results = { refreshed: [], failed: [], skipped: [] };
  const beforeAfter = []; // for Discord summary

  for (const [i, article] of articles.entries()) {
    const shortTitle = (article.title || article.slug || "Untitled").slice(
      0,
      60
    );
    const agedays = Math.round(
      (Date.now() - new Date(article.published_at).getTime()) / 86_400_000
    );

    console.log(
      `   [${i + 1}/${articles.length}] "${shortTitle}" (${agedays}d old, WP#${article.wp_post_id})`
    );

    if (!article.wp_post_id) {
      console.log("      Skipped — no wp_post_id");
      results.skipped.push(shortTitle);
      continue;
    }

    try {
      // ── 2a. Call GPT for new title ──────────────────────────────────────
      console.log("      Calling GPT-4o-mini...");
      const gptResult = await rewriteTitle(article);
      const newTitle = gptResult.title;
      const newMeta = gptResult.meta_description;

      console.log(`      New title: "${newTitle}" (${gptResult.title_chars || newTitle.length} chars)`);
      console.log(`      New meta:  "${newMeta.slice(0, 80)}..." (${gptResult.meta_chars || newMeta.length} chars)`);

      if (DRY_RUN) {
        console.log("      [dry-run] Would update WP + Supabase");
        results.refreshed.push({
          id: article.id,
          oldTitle: article.title,
          newTitle,
          newMeta,
        });
        beforeAfter.push({ old: article.title, new: newTitle });
        continue;
      }

      // ── 2b. Update WordPress ────────────────────────────────────────────
      // Write ONLY real WP fields. This site has no Yoast/Rank Math (confirmed
      // via REST namespaces — the only registered post-meta is `footnotes`), so
      // the old `meta: { _yoast_wpseo_* }` block was dead weight WordPress
      // silently dropped. The aipickd-seo-meta mu-plugin builds the <head> meta
      // description from the post EXCERPT (its documented fallback), so writing
      // `excerpt` is what actually makes the new description render live.
      console.log("      Updating WordPress...");
      await wpUpdate(article.wp_post_id, {
        title: newTitle,
        excerpt: newMeta,
      });
      console.log("      WP updated.");

      await sleep(REQUEST_DELAY_MS);

      // ── 2c. Update Supabase ─────────────────────────────────────────────
      console.log("      Updating Supabase...");
      await supa("PATCH", `articles?id=eq.${article.id}`, {
        title: newTitle,
        meta_description: newMeta,
        title_refreshed_at: new Date().toISOString(),
      });
      console.log("      Supabase updated.");

      results.refreshed.push({
        id: article.id,
        oldTitle: article.title,
        newTitle,
        newMeta,
      });
      beforeAfter.push({ old: article.title, new: newTitle });
      console.log("      Done.\n");
    } catch (err) {
      console.error(`      Error: ${err.message.slice(0, 300)}\n`);
      results.failed.push({ title: shortTitle, error: err.message.slice(0, 240) });
      // continue-on-error: don't let one failure stop the batch
    }

    // Small delay between articles to stay under rate limits
    if (i < articles.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  // ── 3. Summary ────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("─".repeat(60));
  console.log(
    `   Refreshed: ${results.refreshed.length} | Failed: ${results.failed.length} | Skipped: ${results.skipped.length}`
  );
  console.log(`   Elapsed: ${elapsed}s`);

  if (beforeAfter.length > 0) {
    console.log("\n   Before / After:");
    for (const ba of beforeAfter.slice(0, 5)) {
      console.log(`     OLD: ${ba.old}`);
      console.log(`     NEW: ${ba.new}\n`);
    }
  }

  if (results.failed.length > 0) {
    console.log("   Failures:");
    for (const f of results.failed) {
      console.log(`     - ${f.title}: ${f.error}`);
    }
  }

  // ── 4. Discord notification ───────────────────────────────────────────────
  if (!DRY_RUN && results.refreshed.length > 0) {
    const sampleBA = beforeAfter.slice(0, 3);
    const sampleText = sampleBA
      .map(
        (ba) =>
          `**Before:** ${ba.old.slice(0, 60)}\n**After:** ${ba.new.slice(0, 60)}`
      )
      .join("\n\n");

    const failNote =
      results.failed.length > 0
        ? `\n\n⚠️ ${results.failed.length} failed. First error: ${results.failed[0].error}`
        : "";

    await notifyPipeline(
      `**Title Refresh:** ${results.refreshed.length} article(s) updated with high-CTR titles.\n\n${sampleText}${failNote}`,
      {
        duration: elapsed,
      }
    ).catch((e) =>
      console.error(`   Discord notify failed: ${e.message.slice(0, 80)}`)
    );
    console.log("\n   Discord notification sent.");
  }

  if (!DRY_RUN && results.failed.length > 0 && results.refreshed.length === 0) {
    // Surface the ACTUAL error (not "check logs") — the CI log needs auth to
    // read, so the alert itself must carry the diagnostic detail.
    await notifyAlert(
      `Title Refresh failed for all ${results.failed.length} article(s).\n` +
        `First error: ${results.failed[0].error}`,
      "warning"
    ).catch(() => {});
  }

  console.log("\n   Done.\n");

  // Only fail the CI step when we made ZERO progress. A partial run (some
  // refreshed, some failed) still advanced the backlog — flagging it red just
  // trains us to ignore the alert. Failures are still reported to Discord above.
  if (results.refreshed.length === 0 && results.failed.length > 0) {
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
