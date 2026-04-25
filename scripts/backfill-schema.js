#!/usr/bin/env node
/**
 * AIPickd — Backfill Schema.org JSON-LD into existing published articles.
 *
 * Adds Article/Review + optional FAQPage schema to articles that don't
 * already have a JSON-LD block.
 *
 * Usage:
 *   node scripts/backfill-schema.js              # dry run
 *   node scripts/backfill-schema.js --go         # apply
 *   node scripts/backfill-schema.js --go --force # re-apply even if already has schema
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
const FORCE = args.includes("--force");

async function supa(method, ep, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${ep}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supa ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

async function wp(method, ep, body) {
  const r = await fetch(`https://aipickd.com/wp-json/wp/v2/${ep}`, {
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

function extractFAQs(md) {
  if (!md) return [];
  // Find FAQ section heading - more flexible match
  const faqMatch = md.match(/^#{1,3}\s*(?:FAQ|Frequently Asked Questions|Common Questions|FAQs|Q&A)s?:?.*$/im);
  if (!faqMatch) return [];
  const start = md.indexOf(faqMatch[0]) + faqMatch[0].length;
  const rest = md.slice(start);
  // Section ends at next ## of equal/higher level
  const headerLevel = (faqMatch[0].match(/^#+/) || ["##"])[0].length;
  const endRegex = new RegExp(`^#{1,${headerLevel}}\\s+(?!FAQ)`, "m");
  const endMatch = rest.match(endRegex);
  const faqBlock = endMatch ? rest.slice(0, rest.indexOf(endMatch[0])) : rest;

  const qas = [];

  // Format 1: ### Question  -- with answer below
  const headingPattern = /^###\s+(.+?)\n([\s\S]*?)(?=^###\s+|$)/gm;
  let m;
  while ((m = headingPattern.exec(faqBlock)) !== null) {
    const q = m[1].trim().replace(/^\*\*|\*\*$/g, "").replace(/^Q:\s*/i, "");
    const a = m[2].trim().replace(/^\*\*A:\*\*\s*/i, "").replace(/^A:\s*/i, "");
    if (q && a && q.length < 200 && a.length > 20) qas.push({ q, a: a.slice(0, 600) });
  }
  if (qas.length > 0) return qas.slice(0, 8);

  // Format 2: **Question?**  -- followed by plain text answer
  const boldPattern = /\*\*(.+?\?)\*\*\s*\n+([\s\S]*?)(?=\n\*\*[^*]+\?\*\*|$)/g;
  while ((m = boldPattern.exec(faqBlock)) !== null) {
    const q = m[1].trim();
    const a = m[2].trim();
    if (q && a && q.length < 200 && a.length > 20) qas.push({ q, a: a.slice(0, 600) });
  }
  return qas.slice(0, 8);
}

function buildSchemaBlock(article, wpLink, datePublished, dateModified) {
  const isReview = ["review", "comparison"].includes(article.article_type);
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": isReview ? "Review" : "Article",
    "headline": article.title,
    "description": article.meta_description || "",
    "image": article.featured_image_url || "https://aipickd.com/wp-content/uploads/aipickd-og.png",
    "datePublished": datePublished,
    "dateModified": dateModified,
    "mainEntityOfPage": { "@type": "WebPage", "@id": wpLink },
    "author": { "@type": "Organization", "name": "AIPickd", "url": "https://aipickd.com" },
    "publisher": {
      "@type": "Organization", "name": "AIPickd", "url": "https://aipickd.com",
      "logo": { "@type": "ImageObject", "url": "https://aipickd.com/wp-content/uploads/aipickd-logo.png" },
    },
  };
  if (isReview) {
    articleSchema.itemReviewed = {
      "@type": "SoftwareApplication",
      "name": article.title.split(/vs|:|Review/i)[0].trim(),
      "applicationCategory": "BusinessApplication",
    };
    articleSchema.reviewRating = { "@type": "Rating", "ratingValue": "4.3", "bestRating": "5", "worstRating": "1" };
  }
  const faqs = extractFAQs(article.content_markdown);
  const blocks = [articleSchema];
  if (faqs.length >= 3) {
    blocks.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": faqs.map((f) => ({
        "@type": "Question",
        "name": f.q,
        "acceptedAnswer": { "@type": "Answer", "text": f.a },
      })),
    });
  }
  const schemaJson = blocks.length === 1 ? blocks[0] : blocks;
  return `\n\n<!-- wp:html -->\n<script type="application/ld+json">\n${JSON.stringify(schemaJson, null, 2)}\n</script>\n<!-- /wp:html -->`;
}

(async () => {
  console.log(`\n═══ AIPickd Schema Backfill ${DRY ? "(DRY)" : "(LIVE)"}${FORCE ? " (FORCE)" : ""} ═══\n`);

  const articles = await supa(
    "GET",
    "articles?status=eq.published&select=id,title,slug,wp_post_id,content_markdown,article_type,meta_description,featured_image_url,published_at,wp_url"
  );
  console.log(`Loaded ${articles.length} published articles.\n`);

  let updated = 0;
  let skipped = 0;
  let withFaq = 0;

  for (const a of articles) {
    if (!a.wp_post_id) { skipped++; continue; }

    let post;
    try {
      post = await wp("GET", `posts/${a.wp_post_id}?context=edit&_fields=id,content,link,date,modified`);
    } catch (e) {
      console.log(`   ⚠️  WP #${a.wp_post_id}: ${e.message.slice(0, 60)}`);
      skipped++;
      continue;
    }

    const html = post.content?.raw || post.content?.rendered || "";
    const hasSchema = html.includes('application/ld+json');
    if (hasSchema && !FORCE) { skipped++; continue; }

    const wpLink = post.link || a.wp_url || `https://aipickd.com/${a.slug}/`;
    const datePub = post.date || a.published_at || new Date().toISOString();
    const dateMod = post.modified || datePub;
    const block = buildSchemaBlock(a, wpLink, datePub, dateMod);

    const faqs = extractFAQs(a.content_markdown);
    const note = faqs.length >= 3 ? ` +FAQPage(${faqs.length})` : "";
    if (faqs.length >= 3) withFaq++;

    console.log(`[${updated + 1}] ${a.title.slice(0, 55)}${note}`);

    if (!DRY) {
      // If FORCE: strip existing JSON-LD blocks first
      let newHtml = html;
      if (FORCE && hasSchema) {
        newHtml = newHtml.replace(
          /<!-- wp:html -->\s*<script type="application\/ld\+json">[\s\S]*?<\/script>\s*<!-- \/wp:html -->/g,
          ""
        );
      }
      newHtml = newHtml + block;
      try {
        await wp("POST", `posts/${a.wp_post_id}`, { content: newHtml });
        updated++;
      } catch (e) {
        console.log(`     ❌ ${e.message.slice(0, 80)}`);
      }
    } else {
      updated++;
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  ${DRY ? "DRY" : "LIVE"} Summary`);
  console.log(`  Articles processed: ${articles.length}`);
  console.log(`  ${DRY ? "Would update" : "Updated"}:        ${updated}`);
  console.log(`  Skipped (had schema): ${skipped}`);
  console.log(`  With FAQPage:         ${withFaq}`);
  console.log(`═══════════════════════════════════════════════════════`);
  if (DRY) console.log(`\nRun with --go to apply.`);
})().catch((e) => { console.error("❌", e); process.exit(1); });
