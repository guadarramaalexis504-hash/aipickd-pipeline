#!/usr/bin/env node
/**
 * AIPickd — Trending Keywords Generator
 *
 * Uses GPT-4o-mini to discover trending AI tool topics and adds them to
 * the keyword queue in Supabase.
 *
 * Runs automatically on Mondays only (to avoid flooding the queue).
 * Pass --force to run any day of the week.
 *
 * Logic:
 *   1. Check if today is Monday (or --force flag is set)
 *   2. Fetch existing keywords from Supabase (to avoid duplicates)
 *   3. Fetch niches from Supabase
 *   4. Call GPT-4o-mini asking for N trending AI tool keywords
 *   5. Insert new keywords with status=queued
 *   6. Send Discord alert listing added keywords
 *
 * Usage:
 *   node scripts/trending-keywords.js             # only runs on Monday
 *   node scripts/trending-keywords.js --force     # runs any day
 *   node scripts/trending-keywords.js --count 15  # generate 15 keywords (default 10)
 *   node scripts/trending-keywords.js --force --count 20
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Load .env ────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
const env = {};
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch {}

const { notifyAlert } = require('./notify.js');

// ── Args ─────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const FORCE   = args.includes('--force');
const countIdx = args.indexOf('--count');
const COUNT   = countIdx >= 0 ? parseInt(args[countIdx + 1], 10) || 10 : 10;

// ── Supabase helper ──────────────────────────────────────────────────────────
async function supa(method, endpoint, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${endpoint}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ── GPT-4o-mini call returning parsed JSON ───────────────────────────────────
async function gptJson(systemPrompt, userPrompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 2000,
      temperature: 0.8,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GPT-4o-mini error: ${JSON.stringify(data).slice(0, 200)}`);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('GPT returned empty content');
  return JSON.parse(content);
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🔥 AIPickd Trending Keywords Generator\n');

  // ── 1. Day-of-week check ───────────────────────────────────────────────────
  const today    = new Date();
  const dayOfWeek = today.getDay(); // 0=Sunday … 1=Monday … 6=Saturday
  const isMonday  = dayOfWeek === 1;

  if (!FORCE && !isMonday) {
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    console.log(`   ⏭️  Skipping — today is ${dayNames[dayOfWeek]}, not Monday.`);
    console.log('   Pass --force to run on any day.\n');
    process.exit(0);
  }

  if (FORCE && !isMonday) {
    console.log('   ⚡ --force flag set — running despite non-Monday.\n');
  } else {
    console.log('   📅 It\'s Monday — running trending keyword discovery.\n');
  }

  // ── 2. Fetch existing keywords (deduplicate) ───────────────────────────────
  console.log('   Fetching existing keywords to avoid duplicates...');
  let existingKeywords = [];
  try {
    // Grab the most recent 500 to keep the prompt manageable
    const rows = await supa('GET', 'keywords?select=keyword&limit=500&order=discovered_at.desc');
    if (Array.isArray(rows)) existingKeywords = rows;
  } catch (e) {
    console.error(`   ⚠️  Could not fetch existing keywords: ${e.message.slice(0, 100)}`);
    // Non-fatal — we'll just skip duplicate prevention
  }
  const existingSet = new Set(existingKeywords.map(k => (k.keyword || '').toLowerCase().trim()));
  console.log(`   ${existingSet.size} existing keywords loaded.\n`);

  // ── 3. Fetch niches ────────────────────────────────────────────────────────
  console.log('   Fetching niches...');
  let niches = [];
  try {
    const rows = await supa('GET', 'niches?select=id,name,slug&order=name.asc');
    if (Array.isArray(rows)) niches = rows;
  } catch (e) {
    console.error(`   ⚠️  Could not fetch niches: ${e.message.slice(0, 100)}`);
  }

  if (niches.length === 0) {
    console.error('   ❌ No niches found in database. Cannot assign niche_id. Exiting.');
    process.exit(1);
  }

  const nicheNames = niches.map(n => n.name).join(', ');
  console.log(`   Niches: ${nicheNames}\n`);

  // ── 4. Ask GPT-4o-mini for trending keywords ───────────────────────────────
  console.log(`   Asking GPT-4o-mini for ${COUNT} trending AI tool keywords...\n`);

  const currentYear = today.getFullYear();
  const currentMonth = today.toLocaleString('en-US', { month: 'long' });

  const systemPrompt =
    'You are an expert SEO keyword researcher specializing in AI tools and software. ' +
    'You identify high-opportunity, search-ready keywords for an English-language affiliate blog. ' +
    'Output JSON only — no markdown, no commentary.';

  const avoidList = Array.from(existingSet).slice(0, 150).join(', ');
  const userPrompt =
    `Today is ${currentMonth} ${currentYear}. I run an AI tools review blog called AIPickd (aipickd.com) ` +
    `covering these niches: ${nicheNames}.\n\n` +
    `Generate exactly ${COUNT} trending AI tool keywords for ${currentYear} that I should write about NOW. ` +
    `Focus on what's currently trending, newly launched tools, and hot topics in the AI space.\n\n` +
    `Requirements:\n` +
    `- Mix of formats: comparison ("X vs Y ${currentYear}"), review ("Best X for Y"), ` +
    `  how-to ("How to use X for Y"), and list ("Top X AI tools for Y")\n` +
    `- Each keyword must be 4–9 words, specific, and have clear search intent\n` +
    `- Target audience: marketers, entrepreneurs, content creators evaluating AI tools\n` +
    `- Include the niche it belongs to (must be one of: ${nicheNames})\n` +
    `- Prioritize tools/categories that launched or surged in popularity recently\n` +
    `- AVOID keywords already in our database: ${avoidList || '(none yet)'}\n\n` +
    `Return JSON in this exact format:\n` +
    `{\n` +
    `  "keywords": [\n` +
    `    {\n` +
    `      "keyword": "string (4-9 words)",\n` +
    `      "niche": "exact niche name from the list above",\n` +
    `      "article_type": "comparison|list|review|how-to",\n` +
    `      "intent": "comparison|informational|review|how-to",\n` +
    `      "search_volume_estimate": 100,\n` +
    `      "priority": 7,\n` +
    `      "trend_reason": "one sentence why this is trending now"\n` +
    `    }\n` +
    `  ]\n` +
    `}`;

  let gptKeywords = [];
  try {
    const result = await gptJson(systemPrompt, userPrompt);
    if (Array.isArray(result.keywords)) {
      gptKeywords = result.keywords;
    } else {
      throw new Error('GPT response missing "keywords" array');
    }
  } catch (e) {
    console.error(`   ❌ GPT call failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`   GPT returned ${gptKeywords.length} keyword(s).\n`);

  // ── 5. Insert into Supabase ────────────────────────────────────────────────
  const now = new Date().toISOString();
  const inserted = [];
  const skipped  = [];

  for (const kw of gptKeywords) {
    const keyword = (kw.keyword || '').trim();
    if (!keyword) {
      skipped.push('(empty keyword)');
      continue;
    }

    // Deduplicate against existing keywords
    if (existingSet.has(keyword.toLowerCase())) {
      console.log(`   ⏭️  Skip (duplicate): "${keyword}"`);
      skipped.push(keyword);
      continue;
    }

    // Resolve niche_id from the name GPT returned
    const nicheName = (kw.niche || '').trim();
    const matchedNiche = niches.find(
      n => n.name.toLowerCase() === nicheName.toLowerCase() ||
           n.slug.toLowerCase() === nicheName.toLowerCase()
    );

    // Fall back to the first niche if GPT gave an unrecognized name
    const nicheId = matchedNiche?.id ?? niches[0].id;

    const row = {
      keyword,
      niche_id:     nicheId,
      article_type: kw.article_type || 'list',
      intent:       kw.intent       || 'informational',
      search_volume: parseInt(kw.search_volume_estimate, 10) || 500,
      priority:     Math.min(10, Math.max(1, parseInt(kw.priority, 10) || 5)),
      status:       'queued',
      discovered_at: now,
    };

    try {
      await supa('POST', 'keywords', row);
      existingSet.add(keyword.toLowerCase()); // prevent self-duplicates in the same batch
      inserted.push({ keyword, nicheName: matchedNiche?.name || niches[0].name });
      console.log(`   ✅ Inserted: "${keyword}" [${row.article_type}]`);
    } catch (e) {
      console.error(`   ❌ Failed to insert "${keyword}": ${e.message.slice(0, 100)}`);
      skipped.push(keyword);
    }
  }

  console.log(`\n   Summary: ${inserted.length} inserted, ${skipped.length} skipped\n`);

  // ── 6. Discord alert ───────────────────────────────────────────────────────
  if (inserted.length > 0) {
    const lines = inserted
      .map(k => `• **${k.keyword}** _(${k.nicheName})_`)
      .join('\n');

    const dateStr = today.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    await notifyAlert(
      `🔥 **Trending Keywords — ${inserted.length} added to queue** (${dateStr})\n\n` +
      `${lines}\n\n` +
      `These are trending AI tool topics for ${currentYear}. ` +
      `The pipeline will pick them up on the next run.`,
      'info'
    ).catch(e => console.error(`   ⚠️  Discord alert failed: ${e.message.slice(0, 80)}`));

    console.log('   📣 Discord alert sent.\n');
  } else {
    console.log('   ℹ️  No new keywords inserted — Discord alert skipped.\n');
  }

  console.log('Done!');
})().catch(e => {
  console.error(`❌ trending-keywords failed: ${e.message}`);
  process.exit(1);
});
