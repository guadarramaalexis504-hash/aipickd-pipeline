#!/usr/bin/env node
/**
 * AIPickd — 2027 Keyword Variant Generator
 *
 * Takes existing published keywords and generates "2027" variants
 * before the year turns. Gets you ahead of the competition for
 * next-year searches that start trending in Q3-Q4 2026.
 *
 * Usage:
 *   node scripts/keyword-variants-2027.js            # suggest, don't add
 *   node scripts/keyword-variants-2027.js --add      # add to queue
 *   node scripts/keyword-variants-2027.js --count 30 # generate N variants (default: 20)
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
const TARGET_COUNT = countIdx >= 0 ? parseInt(args[countIdx + 1]) : 20;

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
        { role: 'system', content: 'You are an SEO keyword specialist. Output JSON only.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }),
  });
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

(async () => {
  console.log('🔮 AIPickd 2027 Keyword Variant Generator\n');

  // Fetch existing published/queued keywords and niches
  const [existingKeywords, niches] = await Promise.all([
    supa('GET', 'keywords?select=id,keyword,niche_id,article_type,search_volume,status&order=search_volume.desc&limit=100'),
    supa('GET', 'niches?select=id,name,slug'),
  ]);

  const existingKwSet = new Set((existingKeywords || []).map(k => k.keyword.toLowerCase().trim()));

  // Filter keywords that have "2026" in them — these are the ones to variant
  const yearKeywords = (existingKeywords || []).filter(k =>
    /\b2026\b/.test(k.keyword) && k.status === 'published'
  );

  // Also grab top-performing keywords even without year
  const topKeywords = (existingKeywords || [])
    .filter(k => (k.search_volume || 0) >= 500 && k.status === 'published' && !/\b202\d\b/.test(k.keyword))
    .slice(0, 20);

  const sourceKeywords = [...new Set([...yearKeywords, ...topKeywords])].slice(0, 50);

  console.log(`📚 Source keywords (${sourceKeywords.length}):`);
  sourceKeywords.slice(0, 5).forEach(k => console.log(`   • ${k.keyword}`));
  if (sourceKeywords.length > 5) console.log(`   ... and ${sourceKeywords.length - 5} more`);

  if (sourceKeywords.length === 0) {
    console.log('\n⚠️ No source keywords found. Publish more articles first.');
    return;
  }

  // Generate 2027 variants via GPT
  const kwList = sourceKeywords.map(k => k.keyword).join('\n');
  const data = await gpt(`For these AI tools review keywords, generate 2027 variants that will rank when next year's searches start trending (Q3-Q4 2026).

Source keywords:
${kwList}

Rules:
1. Replace "2026" with "2027" where applicable
2. For keywords without a year, add "2027"
3. Only suggest keywords that make sense for 2027 (avoid keywords about past events)
4. Estimate search volume for 2027 (typically 60-80% of 2026 volume until mid-2027)
5. Keep the same article type (comparison→comparison, list→list, etc.)
6. Return JSON: { "variants": [{ "original": "...", "keyword_2027": "...", "search_volume": 1200, "article_type": "list" }] }
7. Return up to ${TARGET_COUNT} variants

Available niches: ${niches.map(n => n.slug).join(', ')}`);

  const variants = (data.variants || [])
    .filter(v => v.keyword_2027 && !existingKwSet.has(v.keyword_2027.toLowerCase().trim()))
    .slice(0, TARGET_COUNT);

  if (variants.length === 0) {
    console.log('\n✅ No new 2027 variants to add (all already exist in queue).');
    return;
  }

  console.log(`\n📊 Generated ${variants.length} 2027 variants:\n`);
  variants.forEach((v, i) => {
    const vol = v.search_volume ? v.search_volume.toLocaleString() : 'N/A';
    const checkmark = ADD_TO_QUEUE ? '✅' : '  ';
    console.log(`${checkmark} ${(i + 1).toString().padStart(2)}. [${vol.padStart(8)} vol] ${v.keyword_2027} (from: ${v.original})`);
  });

  if (!ADD_TO_QUEUE) {
    console.log('\n💡 Run with --add to add these to the keyword queue.');
    return;
  }

  // Add to queue
  let added = 0;
  for (const v of variants) {
    // Find the original keyword's niche
    const origKw = (existingKeywords || []).find(k =>
      k.keyword.toLowerCase() === (v.original || '').toLowerCase()
    );
    const nicheId = origKw?.niche_id || niches[0]?.id;
    const articleType = v.article_type || origKw?.article_type || 'list';

    try {
      await supa('POST', 'keywords', {
        keyword: v.keyword_2027,
        niche_id: nicheId,
        article_type: articleType,
        intent: 'informational',
        search_volume: v.search_volume || null,
        priority: 2, // lower priority than fresh keywords
        status: 'queued',
      });
      added++;
    } catch (e) {
      if (!e.message.includes('duplicate') && !e.message.includes('unique')) {
        console.log(`   ⚠️ Could not add "${v.keyword_2027}": ${e.message.slice(0, 60)}`);
      }
    }
  }

  console.log(`\n✅ Added ${added} 2027 keyword variants to the queue.`);
  console.log('💡 These will be processed automatically by the pipeline in Q3-Q4 2026.');
})().catch((e) => {
  console.error('❌ 2027 variant generator failed:', e.message);
  process.exit(1);
});
