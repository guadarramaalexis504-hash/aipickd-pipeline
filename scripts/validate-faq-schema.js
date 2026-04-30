#!/usr/bin/env node
/**
 * AIPickd — FAQ Schema Validator
 *
 * Checks that published articles on WordPress have valid FAQPage schema.
 * Articles with FAQ schema get rich results in Google (accordion in SERPs).
 *
 * Usage:
 *   node scripts/validate-faq-schema.js              # check last 20 articles
 *   node scripts/validate-faq-schema.js --count 50   # check 50 articles
 *   node scripts/validate-faq-schema.js --notify     # send Discord report
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
const countIdx = args.indexOf('--count');
const COUNT = countIdx >= 0 ? parseInt(args[countIdx + 1]) : 20;
const NOTIFY = args.includes('--notify');

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

async function fetchPageSchema(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': 'Mozilla/5.0 AIPickd-schema-validator/1.0' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const html = await res.text();

    // Extract all JSON-LD blocks
    const schemas = [];
    const regex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = regex.exec(html)) !== null) {
      try {
        const data = JSON.parse(m[1]);
        // Handle arrays
        const items = Array.isArray(data) ? data : [data];
        schemas.push(...items);
      } catch {}
    }

    const hasFaqPage = schemas.some(s => s['@type'] === 'FAQPage');
    const hasArticle  = schemas.some(s => ['Article', 'Review'].includes(s['@type']));

    // Check FAQPage quality
    let faqCount = 0;
    const faqSchema = schemas.find(s => s['@type'] === 'FAQPage');
    if (faqSchema) {
      faqCount = (faqSchema.mainEntity || []).length;
    }

    return { hasFaqPage, hasArticle, faqCount, schemas: schemas.length };
  } catch (e) {
    return { error: e.message.slice(0, 80) };
  }
}

(async () => {
  console.log(`🔍 AIPickd FAQ Schema Validator (checking ${COUNT} articles)\n`);

  const articles = await supa(
    `articles?status=eq.published&wp_url=not.is.null&order=published_at.desc&limit=${COUNT}&select=id,title,wp_url,article_type,published_at`
  );

  if (!Array.isArray(articles) || articles.length === 0) {
    console.log('No articles to validate.');
    return;
  }

  // Check URLs in batches to avoid hammering the server
  const results = [];
  const batchSize = 5;
  for (let i = 0; i < articles.length; i += batchSize) {
    const batch = articles.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(a => fetchPageSchema(a.wp_url).then(r => ({ ...r, article: a })))
    );
    results.push(...batchResults);
    if (i + batchSize < articles.length) await new Promise(r => setTimeout(r, 1000));
    process.stdout.write(`\r  Progress: ${Math.min(i + batchSize, articles.length)}/${articles.length}`);
  }
  console.log('\n');

  const hasSchema    = results.filter(r => r.hasFaqPage);
  const missingFaq   = results.filter(r => !r.hasFaqPage && !r.error);
  const withErrors   = results.filter(r => r.error);
  const lowFaqCount  = results.filter(r => r.hasFaqPage && r.faqCount < 3);

  console.log(`✅ Articles with FAQPage schema: ${hasSchema.length}/${results.length}`);
  if (lowFaqCount.length > 0) {
    console.log(`⚠️  FAQPage with < 3 questions: ${lowFaqCount.length}`);
  }

  if (missingFaq.length > 0) {
    console.log(`\n🔴 Missing FAQPage schema (${missingFaq.length} articles):`);
    missingFaq.slice(0, 10).forEach(r => {
      console.log(`  • ${r.article.article_type.padEnd(12)} — ${r.article.title.slice(0, 55)}`);
      console.log(`    ${r.article.wp_url}`);
    });
  }

  const coveragePct = results.length > 0 ? Math.round((hasSchema.length / results.length) * 100) : 0;
  console.log(`\n📊 FAQPage coverage: ${coveragePct}%`);

  if (coveragePct < 80 && NOTIFY) {
    const { notifyAlert } = require('./notify.js');
    const missing = missingFaq.slice(0, 5).map(r =>
      `• [${r.article.title.slice(0, 50)}](${r.article.wp_url})`
    ).join('\n');
    await notifyAlert(
      `📋 **FAQ Schema Coverage: ${coveragePct}%**\n\n${hasSchema.length} de ${results.length} artículos tienen FAQPage schema.\n\nSin FAQPage (muestra):\n${missing}\n\n💡 Artículos sin FAQ schema no califican para rich results en Google (acordeones en SERPs).\nRe-publicar con pipeline actualizado agrega el schema automáticamente.`,
      coveragePct < 50 ? 'high' : 'info'
    ).catch(() => {});
    console.log('📢 Discord alert sent');
  }

  console.log('\nDone!');
})().catch((e) => {
  console.error('❌ Schema validator failed:', e.message);
  process.exit(1);
});
