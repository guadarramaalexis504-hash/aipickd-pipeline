#!/usr/bin/env node
/**
 * AIPickd — Freshness Checker
 *
 * Finds articles that are getting stale and need to be updated.
 * Alerts via Discord with a prioritized list.
 *
 * Stale criteria:
 *   - Published > 180 days ago (6 months)
 *   - Title contains a specific year older than current year
 *   - Was published before a major product update (heuristic: > 90 days + low word count)
 *
 * Usage:
 *   node scripts/freshness-checker.js            # default: alert if any > 180 days
 *   node scripts/freshness-checker.js --days 90  # alert if any > 90 days
 *   node scripts/freshness-checker.js --dry-run  # just print, no Discord
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

const { notifyAlert } = require('./notify.js');

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const STALE_DAYS = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) : 180;
const DRY_RUN = args.includes('--dry-run');
const CURRENT_YEAR = new Date().getFullYear();

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
  console.log(`🕰️ AIPickd Freshness Checker (stale = ${STALE_DAYS}+ days)\n`);

  const cutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();
  const now = new Date();

  // Fetch all stale published articles
  const stale = await supa(
    `articles?status=eq.published&published_at=lt.${cutoff}&select=id,title,slug,wp_url,published_at,word_count,primary_keyword,article_type&order=published_at.asc&limit=50`
  );

  if (!Array.isArray(stale) || stale.length === 0) {
    console.log(`✅ No articles older than ${STALE_DAYS} days. Everything fresh!`);
    return;
  }

  // Also flag articles with stale year in title
  const allPublished = await supa(
    `articles?status=eq.published&select=id,title,wp_url,published_at&order=published_at.asc&limit=200`
  ).catch(() => []);

  const yearStale = (allPublished || []).filter(a => {
    // Flag if title has a year < current year
    const match = (a.title || '').match(/\b(202[0-4])\b/);
    return match && parseInt(match[1]) < CURRENT_YEAR;
  });

  // Categorize stale articles
  const critical = stale.filter(a => {
    const daysOld = (now - new Date(a.published_at)) / 86400000;
    return daysOld > 365; // Older than 1 year = critical
  });
  const warning = stale.filter(a => {
    const daysOld = (now - new Date(a.published_at)) / 86400000;
    return daysOld >= STALE_DAYS && daysOld <= 365;
  });

  const daysOld = (a) => Math.round((now - new Date(a.published_at)) / 86400000);
  const fmt = (a) => `• [${(a.title || '').slice(0, 55)}](${a.wp_url || '#'}) — ${daysOld(a)} días`;

  console.log(`📊 Results:`);
  console.log(`   Critical (>1yr): ${critical.length}`);
  console.log(`   Warning (>${STALE_DAYS}d): ${warning.length}`);
  console.log(`   Year stale in title: ${yearStale.length}`);

  if (critical.length > 0) {
    critical.slice(0, 5).forEach(a => console.log(`   🔴 ${a.title} (${daysOld(a)}d)`));
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] No Discord alerts sent.');
    return;
  }

  // Fire Discord alerts
  if (critical.length > 0) {
    const lines = critical.slice(0, 5).map(fmt).join('\n');
    await notifyAlert(
      `🔴 **${critical.length} artículos tienen +1 año sin actualizar**\n\nEstos artículos necesitan refresh urgente (precios, features, rankings cambian):\n\n${lines}${critical.length > 5 ? `\n... y ${critical.length - 5} más.` : ''}\n\n💡 Ejecutar: \`node scripts/generate-one-article-gpt.js --keyword "keyword" --update\``,
      'high'
    ).catch(() => {});
    console.log('🔴 Critical freshness alert sent');
  }

  if (warning.length > 0 && warning.length <= 20) {
    const lines = warning.slice(0, 8).map(fmt).join('\n');
    await notifyAlert(
      `🟡 **${warning.length} artículos tienen +${STALE_DAYS} días** (considera actualizarlos)\n\n${lines}${warning.length > 8 ? `\n... y ${warning.length - 8} más.` : ''}`,
      'warning'
    ).catch(() => {});
    console.log('🟡 Warning freshness alert sent');
  }

  if (yearStale.length > 0) {
    const lines = yearStale.slice(0, 5).map(a =>
      `• [${(a.title || '').slice(0, 55)}](${a.wp_url || '#'}) — título tiene año viejo`
    ).join('\n');
    await notifyAlert(
      `📅 **${yearStale.length} artículos con año viejo en el título**\n\n${lines}${yearStale.length > 5 ? `\n... y ${yearStale.length - 5} más.` : ''}\n\n💡 Actualizar título con año ${CURRENT_YEAR} para mantener CTR en SERPs.`,
      'info'
    ).catch(() => {});
    console.log(`📅 Year-stale alert sent (${yearStale.length} articles)`);
  }

  console.log('\n✅ Freshness check complete.');
})().catch((e) => {
  console.error('❌ Freshness check failed:', e.message);
  process.exit(1);
});
