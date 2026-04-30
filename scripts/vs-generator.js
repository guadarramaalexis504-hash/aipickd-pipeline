#!/usr/bin/env node
/**
 * AIPickd — VS Article Generator
 *
 * Scans existing published articles to identify product pairs that
 * could generate high-value comparison ("vs") articles.
 * Adds the generated keywords to the queue automatically.
 *
 * Usage:
 *   node scripts/vs-generator.js             # suggest pairs, don't add to queue
 *   node scripts/vs-generator.js --add       # add top pairs to keyword queue
 *   node scripts/vs-generator.js --count 10  # add top N pairs (default: 5)
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

const args = process.argv.slice(2);
const ADD_TO_QUEUE = args.includes('--add');
const countIdx = args.indexOf('--count');
const MAX_TO_ADD = countIdx >= 0 ? parseInt(args[countIdx + 1]) : 5;

async function supa(method, endpoint, body) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function gpt(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an SEO keyword research specialist. Output JSON only.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    }),
  });
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

(async () => {
  console.log('⚔️ AIPickd VS Article Generator\n');

  // Fetch published articles, existing keywords, and niches
  const [articles, existingKeywords, niches] = await Promise.all([
    supa('GET', 'articles?status=eq.published&select=id,title,primary_keyword,niche_id,article_type&order=published_at.desc&limit=100'),
    supa('GET', 'keywords?select=keyword&status=in.(queued,published,in_progress)'),
    supa('GET', 'niches?select=id,name,slug'),
  ]);

  const existingKwSet = new Set((existingKeywords || []).map(k => k.keyword.toLowerCase().trim()));

  // Extract product names from review articles
  const reviewArticles = (articles || []).filter(a =>
    ['review', 'list', 'comparison'].includes(a.article_type)
  );

  // Extract brand/product names from titles
  const productNames = new Set();
  for (const art of reviewArticles) {
    // Common patterns: "Best X Tools", "X Review 2026", "X vs Y"
    const title = art.title || '';
    // Extract from review titles: "Jasper AI Review 2026" → "Jasper AI"
    const reviewMatch = title.match(/^([^:]+?)\s+(?:Review|Alternatives?)\s+\d{4}/i);
    if (reviewMatch) productNames.add(reviewMatch[1].trim());
    // Extract primary keyword products
    const kw = (art.primary_keyword || '').replace(/\b(review|vs|best|top|how|what|is)\b.*$/i, '').trim();
    if (kw.length > 3 && kw.length < 40) productNames.add(kw);
  }

  const products = [...productNames].slice(0, 30);
  console.log(`Found ${products.length} potential products for VS pairs:\n${products.slice(0, 10).join(', ')}...\n`);

  if (products.length < 2) {
    console.log('⚠️ Not enough products to generate VS pairs. Publish more review articles first.');
    return;
  }

  // Use GPT to suggest the best VS pairs based on market competition
  const data = await gpt(`Given these AI tool products from a review site, suggest the top 15 most searched "vs" comparison keywords for 2026.

Products: ${products.join(', ')}

Rules:
- Only pair products that directly compete (similar category)
- Format: "Product A vs Product B 2026"
- Prioritize pairs where both products are well-known
- Estimate monthly search volume (be realistic)
- Return JSON: { "pairs": [{ "keyword": "X vs Y 2026", "search_volume": 3200, "niche": "ai-writing" }, ...] }
- Use these niche slugs: ${niches.map(n => n.slug).join(', ')}
- Return exactly 15 pairs`);

  const pairs = (data.pairs || [])
    .filter(p => p.keyword && !existingKwSet.has(p.keyword.toLowerCase().trim()))
    .sort((a, b) => (b.search_volume || 0) - (a.search_volume || 0));

  console.log(`\n📊 Top VS pairs suggested (${pairs.length} new):\n`);
  pairs.slice(0, 15).forEach((p, i) => {
    const vol = p.search_volume ? `${p.search_volume.toLocaleString()} vol` : 'vol unknown';
    const checkmark = i < MAX_TO_ADD && ADD_TO_QUEUE ? '✅' : '  ';
    console.log(`${checkmark} ${(i + 1).toString().padStart(2)}. [${vol.padStart(10)}] ${p.keyword}`);
  });

  if (!ADD_TO_QUEUE) {
    console.log('\n💡 Run with --add to add these to the keyword queue.');
    return;
  }

  // Add top pairs to keyword queue
  const toAdd = pairs.slice(0, MAX_TO_ADD);
  let added = 0;
  for (const pair of toAdd) {
    const niche = niches.find(n => n.slug === pair.niche) || niches[0];
    if (!niche) continue;
    try {
      await supa('POST', 'keywords', {
        keyword: pair.keyword,
        niche_id: niche.id,
        article_type: 'comparison',
        intent: 'informational',
        search_volume: pair.search_volume || null,
        priority: 1, // medium priority
        status: 'queued',
      });
      added++;
      console.log(`   ➕ Added: "${pair.keyword}"`);
    } catch (e) {
      console.log(`   ⚠️ Could not add "${pair.keyword}": ${e.message.slice(0, 60)}`);
    }
  }

  console.log(`\n✅ Added ${added} VS comparison keywords to queue.`);
})().catch((e) => {
  console.error('❌ VS generator failed:', e.message);
  process.exit(1);
});
