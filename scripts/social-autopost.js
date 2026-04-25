#!/usr/bin/env node
/**
 * AIPickd — Auto-post new articles to X/Twitter + Pinterest
 *
 * When a new article is published, auto-generates a post and shares it.
 * Pinterest is HUGE for blogs (20-30% traffic for some niches).
 *
 * Setup (when you have time):
 *
 *   A) X/TWITTER (15 min):
 *      1. https://developer.twitter.com → sign up (free tier)
 *      2. Create project + app
 *      3. Get API Key + Secret + Access Token + Secret (all 4)
 *      4. Add to .env:
 *         TWITTER_API_KEY="..."
 *         TWITTER_API_SECRET="..."
 *         TWITTER_ACCESS_TOKEN="..."
 *         TWITTER_ACCESS_SECRET="..."
 *
 *   B) PINTEREST (10 min):
 *      1. https://developers.pinterest.com
 *      2. Create app → get access token
 *      3. Create board: "AI Tools Reviews" (for your pins)
 *      4. Add to .env:
 *         PINTEREST_ACCESS_TOKEN="..."
 *         PINTEREST_BOARD_ID="..."
 *
 * Usage:
 *   node scripts/social-autopost.js           # posts latest published article
 *   node scripts/social-autopost.js --all     # catches up on all recent articles
 *
 * NOTE: Script is STUBBED — social APIs change often. When you have keys, I'll
 *       wire it up properly with current API specs.
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY } = env;

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

// GPT generates short-form copy for social
async function generateSocialCopy(article) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Generate social media copy for this article:

Title: ${article.title}
URL: ${article.wp_url}
Meta description: ${article.meta_description}

Return JSON with:
- twitter: 250 chars max, includes 2-3 relevant hashtags, punchy hook
- pinterest_title: 100 chars, SEO-keyword-rich
- pinterest_description: 400 chars, tells what they'll learn, includes 3-5 keywords

Output JSON only.`,
      }],
      response_format: { type: "json_object" },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GPT: ${JSON.stringify(data).slice(0, 200)}`);
  return JSON.parse(data.choices[0].message.content);
}

// STUB: Twitter posting (wire up when keys available)
async function postToTwitter(copy, articleUrl) {
  if (!env.TWITTER_API_KEY) return { ok: false, reason: "TWITTER_API_KEY not set" };
  // TODO: Use twitter-api-v2 npm package when keys are ready
  console.log(`   [STUB] Would post to X: "${copy.twitter}"`);
  return { ok: false, reason: "Twitter posting not yet wired (need keys)" };
}

// STUB: Pinterest posting
async function postToPinterest(copy, article) {
  if (!env.PINTEREST_ACCESS_TOKEN) return { ok: false, reason: "PINTEREST_ACCESS_TOKEN not set" };
  try {
    const res = await fetch("https://api.pinterest.com/v5/pins", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.PINTEREST_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        board_id: env.PINTEREST_BOARD_ID,
        link: article.wp_url,
        title: copy.pinterest_title,
        description: copy.pinterest_description,
        media_source: {
          source_type: "image_url",
          url: article.featured_image_url,
        },
      }),
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

(async () => {
  const all = process.argv.includes("--all");
  const since = all ? 0 : 1; // 1 = just the latest unpublished-to-social

  // Find articles that are LIVE but not yet shared socially
  const articles = await supa(
    "GET",
    `articles?status=eq.published&wp_url=not.is.null&featured_image_url=not.is.null&order=published_at.desc&limit=${since}&select=id,title,wp_url,featured_image_url,meta_description`
  );

  if (!articles || articles.length === 0) {
    console.log("No LIVE articles ready to share.");
    return;
  }

  for (const article of articles) {
    console.log(`\n📰 Sharing: "${article.title.slice(0, 60)}..."`);
    try {
      const copy = await generateSocialCopy(article);
      console.log(`   Twitter: "${copy.twitter.slice(0, 80)}..."`);
      console.log(`   Pinterest: "${copy.pinterest_title.slice(0, 80)}..."`);

      const [tw, pt] = await Promise.all([
        postToTwitter(copy, article.wp_url),
        postToPinterest(copy, article),
      ]);
      console.log(`   Twitter:   ${tw.ok ? "✅ posted" : "⏩ skipped (" + tw.reason + ")"}`);
      console.log(`   Pinterest: ${pt.ok ? "✅ posted" : "⏩ skipped (" + pt.reason + ")"}`);
    } catch (e) {
      console.log(`   ❌ ${e.message.slice(0, 100)}`);
    }
  }
})();
