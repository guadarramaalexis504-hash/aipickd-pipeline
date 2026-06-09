#!/usr/bin/env node
/**
 * AIPickd — Auto-add internal links between articles.
 *
 * Strategy:
 *   For each published article, find brand/tool names that match the slug/title
 *   of OTHER published articles and link the first 1-2 mentions.
 *
 * Boosts internal PageRank flow + topical authority + session duration.
 *
 * Usage:
 *   node scripts/add-internal-links.js              # dry run
 *   node scripts/add-internal-links.js --go         # apply changes
 *   node scripts/add-internal-links.js --max 2      # max links per article
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

const args = process.argv.slice(2);
const DRY = !args.includes("--go");
const ALLOW_CROSS_LANG = args.includes("--allow-cross-lang");
const MAX_LINKS_PER_ARTICLE = parseInt(args[args.indexOf("--max") + 1]) || 3;

async function supa(method, endpoint, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function wp(method, endpoint, body) {
  const r = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`WP ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

// Replace first plain-text occurrence of `brand` with a link, ONLY outside
// existing <a>..</a> tags. Returns { html, replaced }.
function replaceFirstPlain(html, brand, url) {
  // Split on existing <a>..</a> tags, only modify segments OUTSIDE them.
  const re = /(<a\s[^>]*>[\s\S]*?<\/a>)/gi;
  const parts = html.split(re);
  const escBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRe = new RegExp(`\\b${escBrand}\\b`, "i");
  let replaced = false;
  for (let i = 0; i < parts.length; i++) {
    if (replaced) break;
    if (parts[i].match(/^<a\s/i)) continue; // skip <a> blocks
    const segment = parts[i];
    if (wordRe.test(segment)) {
      parts[i] = segment.replace(wordRe, (m) => `<a href="${url}">${m}</a>`);
      replaced = true;
    }
  }
  return { html: parts.join(""), replaced };
}

(async () => {
  console.log(`\n═══ AIPickd Internal Linker ${DRY ? "(DRY RUN)" : "(LIVE)"} ═══\n`);

  const articles = await supa(
    "GET",
    "articles?status=eq.published&select=id,title,slug,language,wp_url,wp_post_id,content_markdown&order=published_at.desc"
  );
  console.log(`Loaded ${articles.length} published articles.\n`);

  // Build a map of "candidate phrase -> {slug, title}" for linking
  // We extract distinctive nouns/brands from each slug.
  // Skip generic phrases like "best", "vs", "review", "2026"
  const STOP_WORDS = new Set([
    "best", "vs", "review", "guide", "how", "to", "the", "for",
    "and", "or", "of", "in", "on", "with", "without", "tools", "tool",
    "ai", "comparison", "compared", "tested", "explained", "step",
    "by", "step", "your", "any", "from", "into", "alternatives",
    "alternative", "free", "cheaper", "premium", "vs.", "guide:", "vs:",
    "2025", "2026", "writing", "video", "image", "coding", "business",
    "productivity", "tools:", "comparison:", "review:", "guide:",
    "small", "medium", "large", "team", "teams", "creators", "agencies",
  ]);

  // Build candidate map: distinctive multi-word phrases from titles map to slugs.
  // We use only article slugs as link targets.
  const candidates = articles.map((a) => {
    // From the slug, get distinctive token pairs/triples
    const slugWords = a.slug.split("-").filter((w) => !STOP_WORDS.has(w.toLowerCase()) && w.length > 2);
    return { slug: a.slug, title: a.title, slugWords, id: a.id, language: a.language || "en", wp_url: a.wp_url || null };
  });

  // For each article, find a brand/topic mentioned that matches another article's slug.
  // Specifically: look for 1-3 word capitalized phrases or known tool names.
  // Heuristic: if any single distinctive word from another article's slug appears
  // in this article's body and is NOT yet linked, link the first occurrence.
  const KNOWN_BRANDS = [
    "Jasper", "Copy.ai", "Writesonic", "Rytr", "Anyword", "Wordtune",
    "Sudowrite", "Frase", "Scalenut", "ChatGPT", "Claude", "Notion",
    "Make.com", "Zapier", "Calendly", "ClickUp", "Monday.com", "Airtable",
    "Hostinger", "Beehiiv", "Substack", "ConvertKit", "Mailchimp", "Webflow",
    "Cursor", "Windsurf", "Vercel", "Railway", "Pika", "Runway", "ElevenLabs",
    "HeyGen", "Synthesia", "Descript", "Loom", "Fireflies", "Otter",
    "Lemlist", "Instantly", "Smartlead", "Apollo", "ZoomInfo",
    "HubSpot", "Pipedrive", "Linear", "Miro", "FigJam", "Pitch", "Gamma",
    "Midjourney", "Leonardo", "Flux", "Canva", "Semrush",
  ];

  let articlesUpdated = 0;
  let totalLinksAdded = 0;
  const summary = [];

  for (const article of articles) {
    if (!article.wp_post_id) continue;
    let linksAdded = 0;
    const additions = [];

    // Fetch current WP HTML so we can do precise string-level replacement
    let wpHtml = "";
    if (!DRY) {
      try {
        const post = await wp("GET", `posts/${article.wp_post_id}?context=edit`);
        wpHtml = post.content?.raw || post.content?.rendered || "";
      } catch (e) {
        // Fallback to rendered (unauth might still need basic auth)
        try {
          const post = await wp("GET", `posts/${article.wp_post_id}`);
          wpHtml = post.content?.rendered || "";
        } catch {
          console.log(`     ⚠️  Could not fetch WP #${article.wp_post_id}`);
          continue;
        }
      }
    }

    let workingContent = DRY ? (article.content_markdown || "") : wpHtml;

    for (const brand of KNOWN_BRANDS) {
      if (linksAdded >= MAX_LINKS_PER_ARTICLE) break;

      const brandSlug = brand.toLowerCase().replace(/\./g, "").replace(/\s+/g, "-");
      const targetCandidates = candidates.filter(
        (c) =>
          c.id !== article.id &&
          (ALLOW_CROSS_LANG || (c.language || "en") === (article.language || "en")) &&
          c.slug.toLowerCase().includes(brandSlug)
      );
      if (targetCandidates.length === 0) continue;

      const target =
        targetCandidates.find((c) => c.slug.toLowerCase().startsWith(brandSlug)) ||
        targetCandidates[0];
      const targetUrl = target.wp_url || `https://aipickd.com/${target.slug}/`;

      if (DRY) {
        // Operate on markdown, just check if brand appears outside existing []()
        const escBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`(?<!\\[)(\\b${escBrand}\\b)(?!\\])`, "i");
        if (workingContent.match(pattern)) {
          workingContent = workingContent.replace(pattern, `[${brand}](${targetUrl})`);
          linksAdded++;
          totalLinksAdded++;
          additions.push(`${brand} -> ${target.slug}`);
        }
      } else {
        // Operate on HTML, replace first occurrence outside existing <a> tags
        const { html, replaced } = replaceFirstPlain(workingContent, brand, targetUrl);
        if (replaced) {
          workingContent = html;
          linksAdded++;
          totalLinksAdded++;
          additions.push(`${brand} -> ${target.slug}`);
        }
      }
    }

    if (linksAdded === 0) continue;

    articlesUpdated++;
    summary.push({ title: article.title, additions });
    console.log(`\n[${articlesUpdated}] ${article.title.slice(0, 60)}`);
    additions.forEach((a) => console.log(`     + ${a}`));

    if (!DRY) {
      try {
        await wp("POST", `posts/${article.wp_post_id}`, { content: workingContent });
        console.log(`     WP #${article.wp_post_id} ✓`);
      } catch (e) {
        console.log(`     ❌ ${e.message.slice(0, 80)}`);
      }
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  ${DRY ? "DRY RUN " : ""}Summary`);
  console.log(`  Articles updated:  ${articlesUpdated}`);
  console.log(`  Links added:       ${totalLinksAdded}`);
  console.log(`═══════════════════════════════════════════════════════`);
  if (DRY) console.log(`\nRun with --go to apply.`);
})().catch((e) => { console.error("❌", e); process.exit(1); });
