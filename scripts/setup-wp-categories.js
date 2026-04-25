#!/usr/bin/env node
/**
 * Setup WP categories matching Supabase niches, then assign each article to its category.
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

async function supa(endpoint) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  return await res.json();
}

async function wp(method, endpoint, body) {
  const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WP ${method} ${endpoint}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// Map Supabase niche slugs → WP category config
const CATEGORIES = {
  "ai-writing": { name: "AI Writing", slug: "ai-writing", description: "AI tools for content creation, copywriting, and blogging" },
  "ai-business": { name: "AI Business & Productivity", slug: "ai-business", description: "AI tools for productivity, automation, and business operations" },
  "ai-image-video": { name: "AI Image & Video", slug: "ai-image-video", description: "AI tools for image generation, video creation, and visual content" },
  "ai-coding": { name: "AI Coding", slug: "ai-coding", description: "AI-powered coding assistants and development tools" },
  "ai-hosting": { name: "AI Infrastructure & Hosting", slug: "ai-infrastructure", description: "Backend, hosting, and infrastructure for AI-powered products" },
};

(async () => {
  console.log("== setup-wp-categories ==\n");

  // Step 1: Ensure categories exist in WP
  const existing = await wp("GET", "categories?per_page=100&_fields=id,slug,name");
  const existingBySlug = new Map(existing.map((c) => [c.slug, c]));

  const catMap = {}; // slug -> wp_category_id
  for (const [nicheSlug, config] of Object.entries(CATEGORIES)) {
    if (existingBySlug.has(config.slug)) {
      catMap[nicheSlug] = existingBySlug.get(config.slug).id;
      console.log(`  ⊘ Category exists: ${config.name} (#${catMap[nicheSlug]})`);
    } else {
      const created = await wp("POST", "categories", {
        name: config.name,
        slug: config.slug,
        description: config.description,
      });
      catMap[nicheSlug] = created.id;
      console.log(`  ✓ Created: ${config.name} (#${created.id})`);
    }
  }
  console.log();

  // Step 2: Link articles to categories
  console.log("Assigning articles to categories...");
  const niches = await supa("niches");
  const nicheIdToSlug = new Map(niches.map((n) => [n.id, n.slug]));

  const articles = await supa("articles?wp_post_id=not.is.null&select=id,title,wp_post_id,niche_id");
  let assigned = 0;
  for (const a of articles) {
    const nicheSlug = nicheIdToSlug.get(a.niche_id);
    const catId = catMap[nicheSlug];
    if (!catId) continue;
    try {
      await wp("POST", `posts/${a.wp_post_id}`, {
        categories: [catId],
      });
      assigned++;
    } catch (e) {
      console.log(`  ✗ #${a.wp_post_id} failed: ${e.message.slice(0, 80)}`);
    }
  }
  console.log(`  ✓ Assigned ${assigned}/${articles.length} articles to categories.\n`);

  console.log("✅ Done.");
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
