#!/usr/bin/env node
/**
 * AIPickd — Article Refresh Queuer
 *
 * Finds published articles that haven't been reviewed in 90+ days and
 * re-queues their keywords so the pipeline regenerates updated versions.
 *
 * Logic:
 *   1. Find published articles where published_at < 90 days ago
 *      AND (next_review_at IS NULL OR next_review_at < today)
 *   2. For each stale article (up to 3 per run), set keyword status = 'queued'
 *   3. Set article next_review_at = today + 90 days
 *   4. Send Discord alert listing which articles were queued for refresh
 *
 * Usage:
 *   node scripts/article-refresh.js           # normal run (max 3 articles)
 *   node scripts/article-refresh.js --dry-run # show what would happen, no changes
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

// ── Config ───────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CAP     = 3; // max articles refreshed per run
const STALE_DAYS = 90;

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

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🔄 AIPickd Article Refresh${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  const today   = new Date();
  const cutoff  = new Date(today.getTime() - STALE_DAYS * 86400000).toISOString();
  const todayIso = today.toISOString().slice(0, 10); // YYYY-MM-DD

  // Next review date = today + 90 days
  const nextReview = new Date(today.getTime() + STALE_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);

  console.log(`   Cutoff: articles published before ${cutoff.slice(0, 10)}`);
  console.log(`   Next review will be set to: ${nextReview}\n`);

  // ── 1. Find stale articles ─────────────────────────────────────────────────
  // Condition: published_at < cutoff AND (next_review_at IS NULL OR next_review_at < today)
  // We need two queries because PostgREST OR with IS NULL requires a special filter.

  let staleArticles = [];

  // Query A: next_review_at IS NULL
  try {
    const noReview = await supa(
      'GET',
      `articles?status=eq.published&published_at=lt.${cutoff}&next_review_at=is.null` +
      `&select=id,title,slug,keyword_id,published_at,next_review_at&order=published_at.asc&limit=20`
    );
    if (Array.isArray(noReview)) staleArticles.push(...noReview);
  } catch (e) {
    console.error(`   ⚠️  Error fetching null-review articles: ${e.message.slice(0, 100)}`);
  }

  // Query B: next_review_at < today (already past due)
  try {
    const pastDue = await supa(
      'GET',
      `articles?status=eq.published&published_at=lt.${cutoff}&next_review_at=lt.${todayIso}` +
      `&select=id,title,slug,keyword_id,published_at,next_review_at&order=next_review_at.asc&limit=20`
    );
    if (Array.isArray(pastDue)) staleArticles.push(...pastDue);
  } catch (e) {
    console.error(`   ⚠️  Error fetching past-due articles: ${e.message.slice(0, 100)}`);
  }

  // Deduplicate by article id (an article might match both queries)
  const seen = new Set();
  staleArticles = staleArticles.filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  // Sort by oldest published_at first, then cap
  staleArticles.sort((a, b) => new Date(a.published_at) - new Date(b.published_at));
  const toRefresh = staleArticles.slice(0, CAP);

  console.log(`   Found ${staleArticles.length} stale article(s). Processing up to ${CAP}.\n`);

  if (toRefresh.length === 0) {
    console.log('   ✅ No stale articles found. Nothing to refresh.');
    return;
  }

  // ── 2 & 3. Requeue keywords + update next_review_at ───────────────────────
  const refreshed = [];
  const failed    = [];

  for (const article of toRefresh) {
    const titleShort = (article.title || article.slug || 'Untitled').slice(0, 60);
    const agedays    = Math.round((today - new Date(article.published_at)) / 86400000);

    console.log(`   Processing: "${titleShort}" (${agedays}d old)`);

    if (!article.keyword_id) {
      console.log(`      ⏭️  Skipped — no keyword_id`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`      [dry-run] Would requeue keyword ${article.keyword_id} + set next_review_at=${nextReview}`);
      refreshed.push({ title: article.title || article.slug, agedays, id: article.id });
      continue;
    }

    // Reset keyword status to 'queued' so the pipeline picks it up
    let keywordOk = false;
    try {
      await supa('PATCH', `keywords?id=eq.${article.keyword_id}`, { status: 'queued' });
      keywordOk = true;
      console.log(`      ✅ Keyword ${article.keyword_id} → queued`);
    } catch (e) {
      console.error(`      ❌ Failed to requeue keyword: ${e.message.slice(0, 100)}`);
      failed.push(titleShort);
      continue; // Don't update the article review date if keyword reset failed
    }

    // Update article next_review_at so it won't be picked again for 90 days
    try {
      await supa('PATCH', `articles?id=eq.${article.id}`, { next_review_at: nextReview });
      console.log(`      ✅ Article next_review_at → ${nextReview}`);
    } catch (e) {
      console.error(`      ⚠️  Failed to update next_review_at: ${e.message.slice(0, 100)}`);
      // Non-fatal — keyword is already re-queued, article will just show up again next time
    }

    refreshed.push({ title: article.title || article.slug, agedays, id: article.id });
  }

  // ── 4. Discord alert ───────────────────────────────────────────────────────
  console.log(`\n   Summary: ${refreshed.length} queued for refresh, ${failed.length} failed\n`);

  if (refreshed.length > 0 && !DRY_RUN) {
    const lines = refreshed
      .map(a => `• ${(a.title || '').slice(0, 60)} (${a.agedays}d old)`)
      .join('\n');

    const moreStale = staleArticles.length > CAP
      ? `\n\n_(${staleArticles.length - CAP} more stale articles waiting for the next run)_`
      : '';

    await notifyAlert(
      `🔄 **Article Refresh: ${refreshed.length} article(s) queued for regeneration**\n\n` +
      `These articles were 90+ days old and have been re-queued:\n\n${lines}` +
      `${moreStale}\n\n` +
      `Next review set to **${nextReview}** (90 days from now).`,
      'info'
    ).catch(e => console.error(`   ⚠️  Discord alert failed: ${e.message.slice(0, 80)}`));

    console.log('   📣 Discord alert sent.');
  }

  if (DRY_RUN) {
    console.log('   [dry-run] No changes were made. Pass without --dry-run to apply.\n');
  } else {
    console.log('   Done! The pipeline will regenerate these articles on the next run.\n');
  }
})().catch(e => {
  console.error(`❌ article-refresh failed: ${e.message}`);
  process.exit(1);
});
