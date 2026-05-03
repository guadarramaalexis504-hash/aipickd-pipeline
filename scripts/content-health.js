#!/usr/bin/env node
/**
 * AIPickd — Content Health Audit
 *
 * Audits four content quality dimensions and sends ONE consolidated
 * Discord report to #alertas:
 *
 *   1. Thin content       — published articles with word_count < 1500
 *   2. Date freshness     — titles containing a year older than current year
 *   3. Duplicate titles   — pairs with Jaccard similarity > 0.75
 *   4. No featured image  — published articles with featured_image_url IS NULL
 *
 * This script is always read-only (no writes to Supabase or WordPress).
 *
 * Usage:
 *   node scripts/content-health.js           # audit + Discord report
 *   node scripts/content-health.js --dry-run # audit only, no Discord
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const env = {};
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch (e) {
  console.error('❌ .env not found:', envPath);
  process.exit(1);
}

const DRY_RUN     = process.argv.includes('--dry-run');
const CURRENT_YEAR = new Date().getFullYear();

// Thresholds
const THIN_WORD_COUNT    = 1500;
const JACCARD_THRESHOLD  = 0.75;

// Jaccard stop words (keep in sync with dedup-keywords.js)
const STOP_WORDS = new Set([
  'the','a','an','in','of','for','and','or','to','is','are','with',
  'how','best','top','vs','ai','tool','tools','your','you','use',
  'using','guide','review','what','why','when','which',
  'most','more','all','any','from','that','this','these','those',
  'good','great','free','new','old','get','has','have',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function supa(endpoint) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().then(t => t.slice(0, 200));
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  return res.json();
}

async function discord(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (_) {}
}

/** Tokenise title into meaningful words for Jaccard. */
function tokenize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Jaccard similarity between two strings (0 = nothing in common, 1 = identical). */
function jaccard(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  const intersection = [...sa].filter((w) => sb.has(w)).length;
  const union = new Set([...sa, ...sb]).size;
  return intersection / union;
}

/** Truncate a string for display. */
const trunc = (s, n = 60) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

// ─── Audit functions ──────────────────────────────────────────────────────────

/** 1. Thin content: word_count < THIN_WORD_COUNT */
async function findThinContent(articles) {
  console.log(`\n📝 [1/4] Thin content (< ${THIN_WORD_COUNT} words)…`);
  const thin = articles.filter((a) => (a.word_count || 0) < THIN_WORD_COUNT);
  console.log(`   Found ${thin.length} thin articles.`);
  thin.forEach((a) =>
    console.log(`   • ${trunc(a.title, 55)} — ${a.word_count || 0}w`)
  );
  return thin;
}

/** 2. Date freshness: title contains a year < current year */
async function findStaleYears(articles) {
  console.log(`\n📅 [2/4] Date freshness (year in title < ${CURRENT_YEAR})…`);
  const stale = articles.filter((a) => {
    const match = (a.title || '').match(/\b(20\d{2})\b/);
    return match && parseInt(match[1], 10) < CURRENT_YEAR;
  });
  console.log(`   Found ${stale.length} articles with stale year in title.`);
  stale.forEach((a) => {
    const match = (a.title || '').match(/\b(20\d{2})\b/);
    console.log(`   • ${trunc(a.title, 55)} — year ${match ? match[1] : '?'}`);
  });
  return stale;
}

/** 3. Duplicate titles: Jaccard > JACCARD_THRESHOLD */
async function findDuplicateTitles(articles) {
  console.log(`\n🔁 [3/4] Duplicate titles (Jaccard > ${JACCARD_THRESHOLD})…`);
  const pairs = [];
  const seen  = new Set();

  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      const score = jaccard(articles[i].title, articles[j].title);
      if (score >= JACCARD_THRESHOLD) {
        // Avoid reporting same pair twice if titles are mirrored
        const key = [articles[i].id, articles[j].id].sort().join('-');
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({
          a: articles[i],
          b: articles[j],
          score: parseFloat(score.toFixed(3)),
        });
      }
    }
  }

  console.log(`   Found ${pairs.length} near-duplicate title pair(s).`);
  pairs.forEach(({ a, b, score }) => {
    console.log(`   • [${score}] "${trunc(a.title, 45)}" ↔ "${trunc(b.title, 45)}"`);
  });
  return pairs;
}

/** 4. No featured image: featured_image_url IS NULL */
async function findNoImage(articles) {
  console.log('\n🖼️  [4/4] Articles with no featured image…');
  const noImage = articles.filter((a) => !a.featured_image_url);
  console.log(`   Found ${noImage.length} articles without a featured image.`);
  noImage.forEach((a) => console.log(`   • ${trunc(a.title, 60)}`));
  return noImage;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('🩺 AIPickd Content Health Audit');
  console.log(`   Year: ${CURRENT_YEAR} | Mode: ${DRY_RUN ? 'DRY RUN' : 'live'}\n`);

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  // Fetch all published articles once
  console.log('Fetching all published articles from Supabase…');
  const articles = await supa(
    'articles?status=eq.published&select=id,title,slug,word_count,wp_url,featured_image_url,published_at&order=published_at.desc'
  );

  if (!Array.isArray(articles) || articles.length === 0) {
    console.log('⚠️  No published articles found.');
    return;
  }
  console.log(`Loaded ${articles.length} published articles.`);

  // Run all four checks
  const [thin, stale, dupes, noImage] = await Promise.all([
    findThinContent(articles),
    findStaleYears(articles),
    findDuplicateTitles(articles),
    findNoImage(articles),
  ]);

  // ── Console summary ─────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  CONTENT HEALTH SUMMARY');
  console.log(`  Total published articles : ${articles.length}`);
  console.log(`  Thin content (< ${THIN_WORD_COUNT}w)    : ${thin.length}`);
  console.log(`  Stale year in title      : ${stale.length}`);
  console.log(`  Near-duplicate titles    : ${dupes.length} pair(s)`);
  console.log(`  No featured image        : ${noImage.length}`);
  console.log('═══════════════════════════════════════════════════════');

  const totalIssues = thin.length + stale.length + dupes.length + noImage.length;

  if (totalIssues === 0) {
    console.log('\n✅ No content issues found!');
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] Discord report skipped.');
    return;
  }

  if (!env.DISCORD_WEBHOOK_ALERTAS) {
    console.log('\n⚠️  DISCORD_WEBHOOK_ALERTAS not set — skipping Discord report.');
    return;
  }

  // ── Build Discord embed ──────────────────────────────────────────────────────

  if (totalIssues === 0) {
    await discord(env.DISCORD_WEBHOOK_ALERTAS, {
      username: 'AIPickd Alert 🚨',
      embeds: [{
        title: '🩺 Content Health — ✅ All Clear',
        description:
          `Audited **${articles.length}** published articles.\n` +
          `No thin content, stale dates, duplicate titles, or missing images found.`,
        color: 0x00cc66,
        footer: { text: 'aipickd.com • content-health.js' },
        timestamp: new Date().toISOString(),
      }],
    });
    console.log('\n✅ Discord all-clear sent.');
    return;
  }

  const fields = [];

  // Field 1: Thin content
  if (thin.length > 0) {
    const lines = thin
      .slice(0, 10)
      .map((a) => `• \`${a.word_count || 0}w\` ${trunc(a.title, 50)}${a.wp_url ? ` — [link](${a.wp_url})` : ''}`)
      .join('\n');
    const extra = thin.length > 10 ? `\n…+${thin.length - 10} more` : '';
    fields.push({
      name: `📝 Thin Content (< ${THIN_WORD_COUNT} words) — ${thin.length} articles`,
      value: (lines + extra).slice(0, 1024),
      inline: false,
    });
  }

  // Field 2: Stale year in title
  if (stale.length > 0) {
    const lines = stale
      .slice(0, 10)
      .map((a) => {
        const match = (a.title || '').match(/\b(20\d{2})\b/);
        return `• ${trunc(a.title, 55)} _(${match ? match[1] : '?'} → ${CURRENT_YEAR})_`;
      })
      .join('\n');
    const extra = stale.length > 10 ? `\n…+${stale.length - 10} more` : '';
    fields.push({
      name: `📅 Stale Year in Title — ${stale.length} articles`,
      value: (lines + extra).slice(0, 1024),
      inline: false,
    });
  }

  // Field 3: Duplicate titles
  if (dupes.length > 0) {
    const lines = dupes
      .slice(0, 8)
      .map(
        ({ a, b, score }) =>
          `• [${score}] "${trunc(a.title, 38)}" ↔ "${trunc(b.title, 38)}"`
      )
      .join('\n');
    const extra = dupes.length > 8 ? `\n…+${dupes.length - 8} more pairs` : '';
    fields.push({
      name: `🔁 Near-Duplicate Titles (Jaccard > ${JACCARD_THRESHOLD}) — ${dupes.length} pair(s)`,
      value: (lines + extra).slice(0, 1024),
      inline: false,
    });
  }

  // Field 4: No featured image
  if (noImage.length > 0) {
    const lines = noImage
      .slice(0, 10)
      .map((a) => `• ${trunc(a.title, 60)}`)
      .join('\n');
    const extra = noImage.length > 10 ? `\n…+${noImage.length - 10} more` : '';
    fields.push({
      name: `🖼️ No Featured Image — ${noImage.length} articles`,
      value: (lines + extra).slice(0, 1024),
      inline: false,
    });
  }

  // Severity color: red if any thin or dupes, orange if stale/no-image only
  const color =
    thin.length > 0 || dupes.length > 0
      ? 0xff4400
      : stale.length > 0 || noImage.length > 0
      ? 0xff9900
      : 0x00cc66;

  const summary =
    `📊 Audited **${articles.length}** articles — **${totalIssues}** issue(s) found\n` +
    `📝 Thin: **${thin.length}** | 📅 Stale year: **${stale.length}** | 🔁 Dupes: **${dupes.length}** | 🖼️ No image: **${noImage.length}**`;

  await discord(env.DISCORD_WEBHOOK_ALERTAS, {
    username: 'AIPickd Alert 🚨',
    embeds: [{
      title: '🩺 Content Health Audit',
      description: summary,
      color,
      fields,
      footer: { text: 'aipickd.com • content-health.js' },
      timestamp: new Date().toISOString(),
    }],
  });

  console.log(`\n🔔 Discord report sent (${totalIssues} total issues found).`);
})().catch((e) => {
  console.error('❌ content-health.js failed:', e.message);
  process.exit(1);
});
