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

  const weekAgo  = new Date(now - 7 * 86400000).toISOString().slice(0, 10);

  // Fetch data in parallel
  const [todayArticlesRaw, yesterdayArticlesRaw, monthArticlesRaw, keywordsRaw, allArticlesRaw, site,
         weekArticlesRaw, qaFailedRaw, qaFailedThisWeekRaw] =
    await Promise.all([
      supa(`articles?published_at=gte.${today}&select=id,title,wp_url,generation_cost_usd,word_count&order=published_at.desc`),
      supa(`articles?published_at=gte.${yesterday}&published_at=lt.${today}&select=id`),
      supa(`articles?published_at=gte.${monthStart}&select=generation_cost_usd`),
      supa(`keywords?status=eq.queued&select=id`),
      supa(`articles?select=id&limit=1`),
      checkSite(),
      // This week's articles for avg word count + publish rate
      supa(`articles?published_at=gte.${weekAgo}&select=id,word_count,status,generation_cost_usd`),
      // Total qa_failed count
      supa(`articles?status=eq.qa_failed&select=id`),
      // qa_failed this week
      supa(`articles?status=eq.qa_failed&created_at=gte.${weekAgo}&select=id,title,word_count`),
    ]);

  const todayArticles     = Array.isArray(todayArticlesRaw) ? todayArticlesRaw : [];
  const yesterdayArticles = Array.isArray(yesterdayArticlesRaw) ? yesterdayArticlesRaw : [];
  const monthArticles     = Array.isArray(monthArticlesRaw) ? monthArticlesRaw : [];
  const keywords          = Array.isArray(keywordsRaw) ? keywordsRaw : [];
  const weekArticles      = Array.isArray(weekArticlesRaw) ? weekArticlesRaw : [];
  const qaFailed          = Array.isArray(qaFailedRaw) ? qaFailedRaw : [];
  const qaFailedThisWeek  = Array.isArray(qaFailedThisWeekRaw) ? qaFailedThisWeekRaw : [];

  // Publish rate this week: published / (published + qa_failed)
  const publishedThisWeek = weekArticles.filter(a => a.status === 'published').length;
  const generatedThisWeek = publishedThisWeek + qaFailedThisWeek.length;
  const publishRate = generatedThisWeek > 0 ? Math.round((publishedThisWeek / generatedThisWeek) * 100) : 100;

  // Average word count for published articles this week
  const publishedWithWords = weekArticles.filter(a => a.status === 'published' && a.word_count > 0);
  const avgWordCount = publishedWithWords.length > 0
    ? Math.round(publishedWithWords.reduce((s, a) => s + a.word_count, 0) / publishedWithWords.length)
    : 0;

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

  // Cost per article this month
  const monthWithCost = monthArticles.filter(a => parseFloat(a.generation_cost_usd) > 0);
  const costPerArticle = monthWithCost.length > 0 ? monthCost / monthWithCost.length : 0;

  // Month-end cost projection (linear extrapolation)
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const projectedMonthlyCost = dayOfMonth > 0 ? (monthCost / dayOfMonth) * daysInMonth : monthCost;

  const lastArticle = todayArticles.length > 0
    ? { title: todayArticles[0].title, url: todayArticles[0].wp_url }
    : null;

  // Build today's article list for Discord (with word counts)
  const todayArticlesList = todayArticles.map(a => ({
    title: a.title || 'Sin título',
    url: a.wp_url || null,
    wordCount: a.word_count || 0,
  }));

  // Count today's qa_failed articles (created today, not published)
  const todayStart = today; // "2026-04-28"
  const todayQaFailed = qaFailedThisWeek.filter(a => (a.created_at || '').startsWith(todayStart)).length;

  console.log(`  Today: ${todayArticles.length} articles, $${todayCost.toFixed(3)}`);
  console.log(`  Yesterday: ${yesterdayArticles.length} articles`);
  console.log(`  Month cost: $${monthCost.toFixed(2)} / $${MONTHLY_BUDGET}`);
  console.log(`  Keywords in queue: ${keywords.length}`);
  console.log(`  Site: ${site.status} (${site.ms}ms)`);
  console.log(`  Publish rate (7d): ${publishRate}% (${publishedThisWeek}/${generatedThisWeek})`);
  console.log(`  Avg word count (7d): ${avgWordCount} words`);
  console.log(`  QA failed (total): ${qaFailed.length}, this week: ${qaFailedThisWeek.length}`);

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
    publishRate,
    avgWordCount,
    qaFailedCount: qaFailed.length,
    todayArticlesList,
    todayQaFailed,
    siteResponseMs: site.ms,
    costPerArticle,
    projectedMonthlyCost,
  });
  console.log('\n✅ Daily digest sent to Discord #pipeline-status');

  // Publish rate alert — if below 60% this week
  if (generatedThisWeek >= 5 && publishRate < 60) {
    const { notifyAlert } = require('./notify.js');
    await notifyAlert(
      `📉 **Tasa de publicación baja: ${publishRate}%** esta semana\n${publishedThisWeek} publicados de ${generatedThisWeek} generados.\nDemasiados artículos fallando QA — revisar calidad de generación.`,
      'high'
    ).catch(() => {});
    console.log(`⚠️ Publish rate alert sent (${publishRate}%)`);
  }

  // Alert if qa_failed accumulating (>5 this week)
  if (qaFailedThisWeek.length > 5) {
    const { notifyAlert } = require('./notify.js');
    const titles = qaFailedThisWeek.slice(0, 3).map(a => `• ${(a.title||'').slice(0,50)} (${a.word_count||0}w)`).join('\n');
    await notifyAlert(
      `🚫 **${qaFailedThisWeek.length} artículos fallaron QA esta semana**\n${titles}\n\nRevisar prompt de generación — mayoría por contenido muy corto.`,
      'warning'
    ).catch(() => {});
  }

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
