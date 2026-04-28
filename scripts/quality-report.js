#!/usr/bin/env node
/**
 * AIPickd — Weekly Quality Report
 *
 * Corre cada lunes 10am CDMX via GitHub Actions.
 * Analiza métricas de calidad de la semana pasada y envía reporte a #reportes-semanales.
 *
 * Métricas:
 *   - Tasa de publicación (publicados / generados)
 *   - Promedio de palabras por artículo
 *   - Distribución por tipo de artículo
 *   - Top artículos por word count
 *   - Artículos en qa_failed (con títulos para revisión manual)
 *   - Tendencia semana vs semana anterior
 *   - Costo promedio por artículo
 *   - Nicho más activo
 *
 * Usage: node scripts/quality-report.js
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

const { notifyReport, notifyAlert } = require('./notify.js');

async function supa(endpoint, headers = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...headers,
    },
  });
  if (!r.ok) return null;
  return r.json();
}

async function supaCount(table, filter = '') {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}?select=id${filter ? '&' + filter : ''}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    }
  );
  const cr = r.headers.get('content-range') || '';
  const m = cr.match(/\/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

(async () => {
  console.log('\n📊 AIPickd Quality Report\n');

  const now = new Date();
  const weekAgo      = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
  const twoWeeksAgo  = new Date(now - 14 * 86400000).toISOString().slice(0, 10);
  const monthStart   = now.toISOString().slice(0, 7) + '-01';

  // ── Fetch all data in parallel ──────────────────────────────────────
  const [
    thisWeekPub,
    lastWeekPub,
    thisWeekQaFailed,
    monthArticles,
    keywordsQueued,
    topArticles,
    affiliateArticles,
    totalCount,
  ] = await Promise.all([
    // This week's published articles
    supa(`articles?status=eq.published&published_at=gte.${weekAgo}&select=id,title,word_count,generation_cost_usd,article_type,wp_url,niche:niches(name)&order=word_count.desc`),
    // Last week's published articles (for comparison)
    supa(`articles?status=eq.published&published_at=gte.${twoWeeksAgo}&published_at=lt.${weekAgo}&select=id,word_count,generation_cost_usd`),
    // QA failed this week
    supa(`articles?status=eq.qa_failed&created_at=gte.${weekAgo}&select=id,title,word_count,created_at&order=created_at.desc`),
    // Month cost
    supa(`articles?status=eq.published&published_at=gte.${monthStart}&select=generation_cost_usd`),
    // Keywords in queue
    supa(`keywords?status=eq.queued&select=id`),
    // Top 3 articles by word count this week
    supa(`articles?status=eq.published&published_at=gte.${weekAgo}&select=title,word_count,wp_url&order=word_count.desc&limit=3`),
    // Articles with affiliate links this week
    supa(`articles?status=eq.published&published_at=gte.${weekAgo}&select=affiliates_mentioned`),
    // Total published all-time
    supaCount('articles', 'status=eq.published'),
  ]);

  const published    = Array.isArray(thisWeekPub) ? thisWeekPub : [];
  const prevWeek     = Array.isArray(lastWeekPub) ? lastWeekPub : [];
  const qaFailed     = Array.isArray(thisWeekQaFailed) ? thisWeekQaFailed : [];
  const monthArts    = Array.isArray(monthArticles) ? monthArticles : [];
  const kwQueue      = Array.isArray(keywordsQueued) ? keywordsQueued.length : 0;
  const topArts      = Array.isArray(topArticles) ? topArticles : [];

  // ── Calculate metrics ───────────────────────────────────────────────
  const generatedThisWeek = published.length + qaFailed.length;
  const publishRate = generatedThisWeek > 0
    ? Math.round((published.length / generatedThisWeek) * 100)
    : 100;

  const avgWords = published.length > 0
    ? Math.round(published.reduce((s, a) => s + (a.word_count || 0), 0) / published.length)
    : 0;

  const prevAvgWords = prevWeek.length > 0
    ? Math.round(prevWeek.reduce((s, a) => s + (a.word_count || 0), 0) / prevWeek.length)
    : 0;

  const weekCost = published.reduce((s, a) => s + (parseFloat(a.generation_cost_usd) || 0), 0);
  const monthCost = monthArts.reduce((s, a) => s + (parseFloat(a.generation_cost_usd) || 0), 0);
  const avgCost = published.length > 0 ? weekCost / published.length : 0;

  // Article type breakdown
  const byType = {};
  published.forEach(a => {
    const t = a.article_type || 'unknown';
    byType[t] = (byType[t] || 0) + 1;
  });

  // Niche breakdown
  const byNiche = {};
  published.forEach(a => {
    const n = a.niche?.name || 'unknown';
    byNiche[n] = (byNiche[n] || 0) + 1;
  });
  const topNiche = Object.entries(byNiche).sort((a, b) => b[1] - a[1])[0];

  // Articles with affiliates
  const withAffiliates = (affiliateArticles || []).filter(
    a => Array.isArray(a.affiliates_mentioned) && a.affiliates_mentioned.length > 0
  ).length;

  // ── Console summary ─────────────────────────────────────────────────
  console.log(`  Published this week: ${published.length} (prev: ${prevWeek.length})`);
  console.log(`  QA failed this week: ${qaFailed.length}`);
  console.log(`  Publish rate: ${publishRate}%`);
  console.log(`  Avg word count: ${avgWords}w (prev: ${prevAvgWords}w)`);
  console.log(`  Week cost: $${weekCost.toFixed(3)} | Month: $${monthCost.toFixed(2)}`);
  console.log(`  Avg cost/article: $${avgCost.toFixed(4)}`);
  console.log(`  Keywords in queue: ${kwQueue}`);
  console.log(`  Total published all-time: ${totalCount}`);

  // ── Send to Discord #reportes-semanales ─────────────────────────────
  await notifyReport({
    totalArticles: totalCount,
    weekArticles: published.length,
    lastWeekArticles: prevWeek.length,
    monthCost,
    budget: parseFloat(env.MONTHLY_BUDGET || '50'),
    activeAffiliates: withAffiliates,
    pendingAffiliates: 0,
    keywordsInQueue: kwQueue,
    publishRate,
    avgWordCount: avgWords,
    prevAvgWordCount: prevAvgWords,
    topArticles: topArts.map(a => ({ title: a.title, words: a.word_count, url: a.wp_url })),
    byType,
    topNiche: topNiche ? topNiche[0] : null,
    qaFailedCount: qaFailed.length,
    estimatedMonthlyEarnings: null, // calculated in notify.js
  });
  console.log('\n✅ Quality report sent to Discord #reportes-semanales');

  // Alert if publish rate is bad
  if (generatedThisWeek >= 5 && publishRate < 60) {
    await notifyAlert(
      `📉 **Tasa de publicación semanal: ${publishRate}%**\n${published.length} publicados de ${generatedThisWeek} generados.\nRevisar prompt de generación — demasiados artículos cortos.`,
      'high'
    ).catch(() => {});
  }

  // Alert if word count is dropping
  if (prevAvgWords > 0 && avgWords < prevAvgWords * 0.85) {
    await notifyAlert(
      `⬇️ **Promedio de palabras bajó ${Math.round(((prevAvgWords - avgWords) / prevAvgWords) * 100)}%**\nEsta semana: ${avgWords}w | Semana pasada: ${prevAvgWords}w\nMonitorear calidad del prompt.`,
      'warning'
    ).catch(() => {});
  }

  // Show qa_failed titles if any
  if (qaFailed.length > 0) {
    console.log(`\n  QA Failed articles:`);
    qaFailed.forEach(a => console.log(`    - ${a.word_count||0}w | ${(a.title||'').slice(0,60)}`));
  }

  console.log('\nDone!');
})().catch((e) => {
  console.error('❌ Quality report failed:', e.message);
  process.exit(1);
});
