#!/usr/bin/env node
/**
 * AIPickd — Daily Digest
 *
 * Corre cada día a las 9am (hora México) via GitHub Actions.
 * Manda resumen del día a #pipeline-status de Discord.
 *
 * Stats que incluye:
 *   - Artículos publicados hoy vs ayer
 *   - Gasto hoy y del mes
 *   - Keywords en cola
 *   - Uptime del sitio
 *   - Último artículo publicado
 *   - Alerta si presupuesto >= 70%
 *
 * Usage: node scripts/daily-report.js
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

const { notifyDailyDigest, notifyBudgetAlert } = require('./notify.js');

const MONTHLY_BUDGET = parseFloat(env.MONTHLY_BUDGET || process.env.MONTHLY_BUDGET || '50');
const DAILY_BUDGET = parseFloat(env.DAILY_BUDGET || process.env.DAILY_BUDGET || '3');

async function supa(endpoint) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) return null;
  return r.json();
}

async function checkSite() {
  const start = Date.now();
  try {
    const r = await fetch('https://aipickd.com/', {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 AIPickd-monitor/1.0' },
    });
    return { status: r.ok ? 'up' : 'down', ms: Date.now() - start, code: r.status };
  } catch (e) {
    return { status: 'down', ms: Date.now() - start, code: null };
  }
}

(async () => {
  console.log('📅 AIPickd Daily Digest\n');

  const now = new Date();
  const today     = now.toISOString().slice(0, 10);
  const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
  const monthStart = now.toISOString().slice(0, 7) + '-01';

  // Fetch data in parallel
  const [todayArticlesRaw, yesterdayArticlesRaw, monthArticlesRaw, keywordsRaw, allArticlesRaw, site] =
    await Promise.all([
      supa(`articles?published_at=gte.${today}&select=id,title,wp_url,generation_cost_usd,word_count&order=published_at.desc`),
      supa(`articles?published_at=gte.${yesterday}&published_at=lt.${today}&select=id`),
      supa(`articles?published_at=gte.${monthStart}&select=generation_cost_usd`),
      supa(`keywords?status=eq.queued&select=id`),
      supa(`articles?select=id&limit=1`),
      checkSite(),
    ]);

  const todayArticles     = Array.isArray(todayArticlesRaw) ? todayArticlesRaw : [];
  const yesterdayArticles = Array.isArray(yesterdayArticlesRaw) ? yesterdayArticlesRaw : [];
  const monthArticles     = Array.isArray(monthArticlesRaw) ? monthArticlesRaw : [];
  const keywords          = Array.isArray(keywordsRaw) ? keywordsRaw : [];

  // Get total article count
  const totalCount = await supa(`articles?select=id&limit=1`);
  // Can't get count easily without count endpoint — use a workaround
  const totalArticlesCount = await (async () => {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/articles?select=id`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Prefer': 'count=exact',
          'Range': '0-0',
        },
      }
    );
    const contentRange = r.headers.get('content-range') || '';
    const match = contentRange.match(/\/(\d+)/);
    return match ? parseInt(match[1]) : 0;
  })().catch(() => 0);

  const todayCost = todayArticles.reduce((s, a) => s + (parseFloat(a.generation_cost_usd) || 0), 0);
  const monthCost = monthArticles.reduce((s, a) => s + (parseFloat(a.generation_cost_usd) || 0), 0);

  const lastArticle = todayArticles.length > 0
    ? { title: todayArticles[0].title, url: todayArticles[0].wp_url }
    : null;

  console.log(`  Today: ${todayArticles.length} articles, $${todayCost.toFixed(3)}`);
  console.log(`  Yesterday: ${yesterdayArticles.length} articles`);
  console.log(`  Month cost: $${monthCost.toFixed(2)} / $${MONTHLY_BUDGET}`);
  console.log(`  Keywords in queue: ${keywords.length}`);
  console.log(`  Site: ${site.status} (${site.ms}ms)`);

  // Send daily digest
  await notifyDailyDigest({
    todayArticles: todayArticles.length,
    yesterdayArticles: yesterdayArticles.length,
    todayCost,
    monthCost,
    keywordsInQueue: keywords.length,
    siteStatus: site.status,
    lastArticle,
    totalArticles: totalArticlesCount,
  });
  console.log('\n✅ Daily digest sent to Discord #pipeline-status');

  // Budget alert if >= 70%
  const monthPct = (monthCost / MONTHLY_BUDGET) * 100;
  if (monthPct >= 70) {
    await notifyBudgetAlert(monthPct, monthCost, MONTHLY_BUDGET, 'monthly');
    console.log(`⚠️ Budget alert sent (${monthPct.toFixed(0)}% used)`);
  }

  const dayPct = (todayCost / DAILY_BUDGET) * 100;
  if (dayPct >= 70) {
    await notifyBudgetAlert(dayPct, todayCost, DAILY_BUDGET, 'daily');
    console.log(`⚠️ Daily budget alert sent (${dayPct.toFixed(0)}% used)`);
  }

  console.log('\nDone!');
})().catch((e) => {
  console.error('❌ Daily report failed:', e.message);
  process.exit(1);
});
