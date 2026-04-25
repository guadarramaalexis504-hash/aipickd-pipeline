#!/usr/bin/env node
/**
 * AIPickd — Generate DALL-E featured images for articles that don't have one
 *
 * For each article without featured_image_url:
 *   1. Generate a hero image with DALL-E 3 based on the title
 *   2. Download the image (temp URL expires in ~1 hour)
 *   3. Upload to WordPress as media
 *   4. Set as featured image on the WP post
 *   5. Save the WP media URL in Supabase
 *
 * Cost: ~$0.04 per image (DALL-E 3 standard 1792x1024)
 *
 * Usage:
 *   node scripts/add-featured-images.js                # all articles without image
 *   node scripts/add-featured-images.js --limit 5      # only 5 articles
 *   node scripts/add-featured-images.js --force        # regenerate even if already has image
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, WP_USERNAME, WP_ADMIN_PASSWORD } = env;
const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");

const args = process.argv.slice(2);
const LIMIT = parseInt(args[args.indexOf("--limit") + 1]) || 999;
const FORCE = args.includes("--force");

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

async function wp(method, endpoint, body, extraHeaders = {}) {
  const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WP: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function generateDallE(title, slug) {
  const prompt = `Modern editorial hero image for a tech/SaaS article titled: "${title}". Clean minimalist illustration style, abstract geometric concepts, vibrant blues and purples with accent of green, 16:9 aspect ratio, flat design aesthetic, professional magazine-cover quality. NO text, NO logos, NO people's faces, NO brand names, NO specific product screenshots. Pure abstract visualization.`;

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt,
      n: 1,
      size: "1792x1024",
      quality: "standard",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`DALL-E: ${JSON.stringify(data).slice(0, 300)}`);
  return data.data[0].url;
}

async function uploadToWp(imageUrl, filename, altText) {
  // Download DALL-E image
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Download image: ${imgRes.status}`);
  const buffer = Buffer.from(await imgRes.arrayBuffer());

  // Upload to WP media
  const uploadRes = await fetch("https://aipickd.com/wp-json/wp/v2/media", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="${filename}.png"`,
    },
    body: buffer,
  });
  const data = await uploadRes.json();
  if (!uploadRes.ok) throw new Error(`WP media upload: ${uploadRes.status} ${JSON.stringify(data).slice(0, 200)}`);

  // Set alt text
  await wp("POST", `media/${data.id}`, JSON.stringify({ alt_text: altText }));

  return { id: data.id, url: data.source_url };
}

(async () => {
  console.log("== add-featured-images ==\n");

  // Find articles that need images
  let query = "articles?select=id,title,slug,wp_post_id,featured_image_url&wp_post_id=not.is.null";
  if (!FORCE) query += "&featured_image_url=is.null";
  query += "&order=created_at.asc";

  const articles = await supa("GET", query);
  const toProcess = articles.slice(0, LIMIT);

  if (toProcess.length === 0) {
    console.log("All articles already have featured images. ✅");
    return;
  }

  console.log(`Processing ${toProcess.length} article(s)...\n`);
  let done = 0;
  let failed = 0;
  const start = Date.now();

  for (const [i, a] of toProcess.entries()) {
    const prefix = `  [${i + 1}/${toProcess.length}]`;
    try {
      console.log(`${prefix} "${a.title.slice(0, 55)}..."`);
      console.log(`         → DALL-E generating...`);
      const imgUrl = await generateDallE(a.title, a.slug);

      console.log(`         → Uploading to WP...`);
      const media = await uploadToWp(imgUrl, a.slug, a.title);

      console.log(`         → Setting as featured image on post #${a.wp_post_id}...`);
      await wp("POST", `posts/${a.wp_post_id}`, JSON.stringify({ featured_media: media.id }));

      await supa("PATCH", `articles?id=eq.${a.id}`, {
        featured_image_url: media.url,
      });

      done++;
      console.log(`         ✓ Done (${media.url})\n`);
    } catch (e) {
      failed++;
      console.log(`         ✗ Failed: ${e.message.slice(0, 120)}\n`);
    }
  }

  const mins = ((Date.now() - start) / 60000).toFixed(1);
  console.log(`\n✅ Done in ${mins} min: ${done} images added, ${failed} failed.`);
  console.log(`   Cost: ~$${(done * 0.04).toFixed(2)} USD (DALL-E @ $0.04/image)`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
