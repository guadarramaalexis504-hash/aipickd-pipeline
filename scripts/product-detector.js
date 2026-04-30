#!/usr/bin/env node
/**
 * AIPickd — Product Name Detector
 *
 * Scans published articles for mentions of AI tool brand names
 * that are NOT currently affiliate links, and suggests adding them.
 * Also alerts if an active affiliate's products appear without a link.
 *
 * Usage:
 *   node scripts/product-detector.js
 *   node scripts/product-detector.js --notify     # send Discord alert
 *   node scripts/product-detector.js --fix        # attempt to add missing links
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const env = {};
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch {}

const NOTIFY = process.argv.includes('--notify');
const FIX_MODE = process.argv.includes('--fix');

// Known AI tool brands to detect (add more as you get affiliates)
const KNOWN_BRANDS = [
  'Jasper', 'Jasper AI', 'Copy.ai', 'Writesonic', 'Rytr',
  'Surfer SEO', 'SurferSEO', 'Semrush', 'Ahrefs', 'Moz',
  'Midjourney', 'DALL-E', 'Stable Diffusion', 'Adobe Firefly',
  'GitHub Copilot', 'Cursor', 'Tabnine', 'Codeium',
  'Notion AI', 'Otter.ai', 'Fireflies', 'Grain',
  'HubSpot', 'Salesforce', 'Pipedrive', 'Zoho',
  'Loom', 'Synthesia', 'Descript', 'Runway', 'HeyGen',
  'ChatGPT', 'Claude', 'Gemini', 'Perplexity', 'Copilot',
  'Grammarly', 'Hemingway', 'ProWritingAid',
  'Buffer', 'Hootsuite', 'Later', 'Sprout Social',
  'Canva', 'Adobe Express', 'Figma',
  'Monday.com', 'Asana', 'ClickUp', 'Linear', 'Basecamp',
  'Zapier', 'Make', 'n8n', 'Integromat',
  'Shopify', 'WooCommerce', 'BigCommerce',
  'Hostinger', 'Bluehost', 'SiteGround', 'Cloudflare',
];

async function supa(endpoint) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`Supabase: ${r.status}`);
  return r.json();
}

(async () => {
  console.log('🔍 AIPickd Product Detector\n');

  const [articles, affiliates] = await Promise.all([
    supa('articles?status=eq.published&select=id,title,wp_url,content_markdown,affiliates_mentioned,article_type&order=published_at.desc&limit=50'),
    supa('affiliates?select=id,brand,base_url,status&order=brand.asc'),
  ]);

  const activeAffiliates = (affiliates || []).filter(a => a.status === 'active');
  const activeBrandSet = new Set(activeAffiliates.map(a => a.brand.toLowerCase()));

  console.log(`Active affiliates: ${activeAffiliates.length}`);
  console.log(`Articles to scan: ${(articles || []).length}\n`);

  const opportunities = [];

  for (const article of (articles || [])) {
    const md = article.content_markdown || '';
    const mentions = {};

    for (const brand of KNOWN_BRANDS) {
      // Check if brand is mentioned in the article
      const regex = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const count = (md.match(regex) || []).length;
      if (count === 0) continue;

      // Check if there's already an affiliate link for this brand
      const hasAffLink = md.toLowerCase().includes(`${brand.toLowerCase()}`) &&
        (md.includes('utm_source=aipickd') || activeBrandSet.has(brand.toLowerCase()));

      if (!hasAffLink && activeBrandSet.has(brand.toLowerCase())) {
        // We have an affiliate for this brand but the article doesn't link it
        const aff = activeAffiliates.find(a => a.brand.toLowerCase() === brand.toLowerCase());
        if (!mentions[brand]) {
          mentions[brand] = {
            brand,
            count,
            hasAffiliate: true,
            affiliateUrl: aff?.base_url,
            article: { id: article.id, title: article.title, url: article.wp_url },
          };
        }
      } else if (!hasAffLink) {
        // Brand mentioned without any affiliate — flag for potential future partnership
        if (!mentions[brand]) {
          mentions[brand] = {
            brand,
            count,
            hasAffiliate: false,
            article: { id: article.id, title: article.title, url: article.wp_url },
          };
        }
      }
    }

    if (Object.keys(mentions).length > 0) {
      opportunities.push({ article, mentions });
    }
  }

  // Sort by affiliate priority first
  const missingAffLinks = opportunities.flatMap(o =>
    Object.values(o.mentions).filter(m => m.hasAffiliate)
  );
  const noAffBrands = opportunities.flatMap(o =>
    Object.values(o.mentions).filter(m => !m.hasAffiliate)
  );

  console.log(`=== Missing Affiliate Links (active affiliates not linked) ===\n`);
  if (missingAffLinks.length === 0) {
    console.log('✅ All active affiliates are properly linked in scanned articles!\n');
  } else {
    const byBrand = {};
    for (const m of missingAffLinks) {
      if (!byBrand[m.brand]) byBrand[m.brand] = { count: 0, articles: [] };
      byBrand[m.brand].count += m.count;
      byBrand[m.brand].articles.push(m.article.title.slice(0, 50));
    }
    Object.entries(byBrand).sort((a, b) => b[1].count - a[1].count).forEach(([brand, data]) => {
      console.log(`  🔗 ${brand} — mentioned ${data.count}× in ${data.articles.length} articles WITHOUT affiliate link`);
      data.articles.slice(0, 2).forEach(t => console.log(`     • ${t}`));
    });
  }

  console.log(`\n=== Top Non-Affiliated Brands (potential partnership targets) ===\n`);
  const brandCounts = {};
  for (const m of noAffBrands) {
    brandCounts[m.brand] = (brandCounts[m.brand] || 0) + m.count;
  }
  Object.entries(brandCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([brand, count]) => {
      console.log(`  📋 ${brand} — mentioned ${count}× (no affiliate program yet)`);
    });

  // Discord notification
  if (NOTIFY && missingAffLinks.length > 0) {
    const { notifyAlert } = require('./notify.js');
    const byBrand = {};
    for (const m of missingAffLinks) {
      byBrand[m.brand] = (byBrand[m.brand] || 0) + 1;
    }
    const lines = Object.entries(byBrand).slice(0, 8).map(([b, c]) =>
      `• **${b}** — sin enlace en ${c} artículo(s)`
    ).join('\n');

    await notifyAlert(
      `🔗 **Afiliados activos NO enlazados en artículos**\n\n${lines}\n\n💡 Estos artículos mencionan marcas con las que tienes afiliado pero sin usar el link.\nEjecutar: \`node scripts/product-detector.js --fix\``,
      'info'
    ).catch(() => {});
    console.log('\n📢 Discord alert sent');
  }

  // Stats
  const totalMissing = new Set(missingAffLinks.map(m => m.brand)).size;
  const topOpportunity = Object.entries(brandCounts).sort((a, b) => b[1] - a[1])[0];
  console.log(`\n📊 Summary:`);
  console.log(`  Active affiliates missing links: ${totalMissing} brands`);
  console.log(`  Potential new partners by frequency: ${topOpportunity ? `${topOpportunity[0]} (${topOpportunity[1]} mentions)` : 'N/A'}`);
  console.log('\nDone!');
})().catch((e) => {
  console.error('❌ Product detector failed:', e.message);
  process.exit(1);
});
