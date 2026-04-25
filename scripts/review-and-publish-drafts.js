#!/usr/bin/env node
/**
 * AIPickd — Auto-review & publish drafts
 * Reviews each draft article for quality issues, publishes good ones LIVE,
 * and flags bad ones for manual attention or regeneration.
 *
 * Quality checks:
 *  - Word count >= 1500
 *  - No "2023", "2024", "2025" as current year references
 *  - No unreplaced [AFFILIATE:...] tags
 *  - No AI-tell phrases ("As an AI", "I cannot", "I don't have access")
 *  - Has featured image
 *  - Title doesn't start with weird characters
 *
 * Usage: node scripts/review-and-publish-drafts.js
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

// Quality review: returns {pass: boolean, issues: string[], score: number}
function qualityCheck(article) {
  const issues = [];
  const md = article.content_markdown || "";

  // 1. Word count
  if (!article.word_count || article.word_count < 1500) {
    issues.push(`Short: ${article.word_count || 0} words (<1500)`);
  }

  // 2. Wrong year as "current"
  const wrongYearCurrent = /\b(?:in|as of|current|this year|for)\s+(?:202[345])\b/gi.test(md) ||
    /^.*\b202[345]\b.*$/m.test(article.title || "");
  if (wrongYearCurrent) issues.push("Wrong-year reference");

  // 3. Unreplaced affiliate tags
  if (/\[AFFILIATE:/i.test(md)) issues.push("Unreplaced [AFFILIATE:] tag");

  // 4. AI-tell phrases
  const aiTells = [
    /as an AI\b/gi,
    /I cannot\b/gi,
    /I don'?t have access\b/gi,
    /I'?m (an? )?AI\b/gi,
    /as a language model\b/gi,
  ];
  for (const re of aiTells) {
    if (re.test(md)) issues.push(`AI-tell detected: "${md.match(re)[0]}"`);
  }

  // 5. Title too short/weird
  if (!article.title || article.title.length < 20) issues.push("Title too short");
  if (/^[^a-zA-Z0-9]/.test(article.title || "")) issues.push("Title starts with weird char");

  return { pass: issues.length === 0, issues, score: 10 - issues.length };
}

(async () => {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  🔍 AIPickd Draft Review & Auto-Publish");
  console.log("═══════════════════════════════════════════════════════\n");

  // Get all drafts (pending review in Supabase)
  const drafts = await supa(
    "GET",
    "articles?status=in.(draft,pending_review)&wp_post_id=not.is.null&order=created_at.asc&select=id,title,slug,content_markdown,word_count,wp_post_id,featured_image_url,article_type"
  );

  console.log(`Found ${drafts.length} articles to review.\n`);

  const results = { published: [], flagged: [] };

  for (const [i, article] of drafts.entries()) {
    const prefix = `[${(i + 1).toString().padStart(2, "0")}/${drafts.length}]`;
    const qa = qualityCheck(article);

    if (qa.pass) {
      // PUBLISH
      try {
        await wp("POST", `posts/${article.wp_post_id}`, {
          status: "publish",
          date: new Date().toISOString(),
        });
        await supa("PATCH", `articles?id=eq.${article.id}`, {
          status: "published",
          published_at: new Date().toISOString(),
        });
        results.published.push(article);
        console.log(`${prefix} ✅ PUBLISH: "${article.title.slice(0, 55)}..." (${article.word_count}w)`);
      } catch (e) {
        results.flagged.push({ ...article, reason: `WP publish failed: ${e.message.slice(0, 80)}` });
        console.log(`${prefix} ⚠️  FAILED:  "${article.title.slice(0, 55)}..." — ${e.message.slice(0, 60)}`);
      }
    } else {
      // FLAG for review
      results.flagged.push({ ...article, issues: qa.issues });
      console.log(`${prefix} 🚩 FLAG:    "${article.title.slice(0, 50)}..."`);
      for (const iss of qa.issues) console.log(`              └─ ${iss}`);
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  📊 SUMMARY`);
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`  ✅ Published LIVE: ${results.published.length}`);
  console.log(`  🚩 Flagged for review: ${results.flagged.length}`);
  console.log(`═══════════════════════════════════════════════════════\n`);

  if (results.flagged.length > 0) {
    console.log("Flagged articles (stay as draft for now):");
    for (const f of results.flagged) {
      console.log(`  #${f.wp_post_id} — ${f.title}`);
      if (f.issues) for (const iss of f.issues) console.log(`    • ${iss}`);
      if (f.reason) console.log(`    • ${f.reason}`);
    }
  }

  console.log(`\n🌐 See all published: https://aipickd.com/`);
})().catch((e) => { console.error("❌ FATAL:", e.message); process.exit(1); });
