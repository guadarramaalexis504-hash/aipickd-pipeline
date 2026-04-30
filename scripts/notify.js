#!/usr/bin/env node
/**
 * AIPickd — Unified notifications v2
 *
 * 5 canales de Discord (AIPickd HQ):
 *   #articulos-publicados  → notifyArticle(title, url, words, affiliates, qualityScore, imageUrl)
 *   #alertas               → notifyAlert(message, severity)
 *   #pipeline-status       → notifyPipeline(message, stats) | notifyDailyDigest(stats)
 *   #reportes-semanales    → notifyReport(stats)
 *   #alertas               → notifyBudgetAlert(pct, spent, budget)
 *
 * CLI:
 *   node scripts/notify.js article "Título" "https://..." 2500 "Jasper,Semrush"
 *   node scripts/notify.js alert "Mensaje de alerta"
 *   node scripts/notify.js pipeline "Pipeline terminó: 3 artículos, $0.18"
 *   node scripts/notify.js report
 *   node scripts/notify.js daily
 *   node scripts/notify.js budget 72 36 50
 */

const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
const env = {};
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch {}

// ─────────────────────────────────────────────
// Core: POST to Discord webhook with embed
// ─────────────────────────────────────────────
async function postWebhook(url, payload) {
  if (!url) return { ok: false, reason: 'webhook URL not configured' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 204 || res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: text };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Barra visual de progreso: e.g. "████████░░ 80%" */
function progressBar(pct, blocks = 10) {
  const filled = Math.min(blocks, Math.round((pct / 100) * blocks));
  return '█'.repeat(filled) + '░'.repeat(blocks - filled);
}

/** Estimado de ingresos mensual basado en palabras + artículos activos */
function estimateEarnings(wordCount, totalArticles = 1) {
  // Rough: más palabras → más ranking → más tráfico
  // 1 article × avg 150 visits/month × 2% CTR × $4 commission
  const perArticle = 150 * 0.02 * 4; // $12/article/month at scale
  const wordBonus = wordCount >= 3000 ? 1.3 : wordCount >= 2500 ? 1.1 : 1.0;
  return (perArticle * wordBonus).toFixed(2);
}

/** Emoji de calidad según score */
function qualityEmoji(score) {
  if (!score && score !== 0) return '⚪';
  if (score >= 90) return '🌟';
  if (score >= 80) return '🟢';
  if (score >= 70) return '🟡';
  return '🔴';
}

/** Calcula score simple de calidad basado en word count e issues */
function calcQualityScore(wordCount = 0, issues = []) {
  let score = 100;
  // Word count
  if (wordCount >= 3000) score += 5;
  else if (wordCount >= 2500) score += 0;
  else if (wordCount >= 2000) score -= 5;
  else if (wordCount >= 1500) score -= 15;
  else score -= 30;
  // Issues
  score -= issues.length * 10;
  return Math.max(0, Math.min(100, score));
}

// ─────────────────────────────────────────────
// 1. #articulos-publicados
// ─────────────────────────────────────────────

/**
 * Notificación de artículo publicado — embed rico con calidad, earnings, thumbnail
 * @param {string} title
 * @param {string} url
 * @param {number} wordCount
 * @param {string|string[]} affiliates
 * @param {number|null} qualityScore - 0-100, null = no calculado
 * @param {string|null} imageUrl - URL de imagen destacada para thumbnail
 * @param {string} articleType - comparison|review|how-to|list|guide
 */
async function notifyArticle(title, url, wordCount = 0, affiliates = [], qualityScore = null, imageUrl = null, articleType = 'article') {
  const affiliateList = Array.isArray(affiliates)
    ? affiliates
    : String(affiliates).split(',').map(s => s.trim()).filter(Boolean);

  const words = Number(wordCount) || 0;
  const qScore = qualityScore ?? null;
  const qEmoji = qualityEmoji(qScore);
  const qText = qScore !== null ? `${qEmoji} ${qScore}/100` : `${qEmoji} N/A`;

  // Earnings estimate
  const earnings = estimateEarnings(words);

  // Reading time (avg 220 wpm)
  const readMins = Math.max(1, Math.round(words / 220));
  const readText = `~${readMins} min`;

  // Article type badge
  const typeBadges = {
    comparison: '⚖️ Comparison',
    review: '🔍 Review',
    'how-to': '🛠️ How-To',
    list: '📋 Listicle',
    guide: '📖 Guide',
    alternatives: '🔄 Alternatives',
  };
  const typeBadge = typeBadges[articleType] || `📄 ${articleType}`;

  // Color based on quality
  const color = qScore >= 90 ? 0x00ff88 : qScore >= 80 ? 0x00cc66 : qScore >= 70 ? 0xffd700 : qScore >= 60 ? 0xff9900 : 0x00cc66;

  const embed = {
    title: '📝 Nuevo artículo publicado',
    description: `**[${title}](${url})**\n${typeBadge}`,
    url,
    color,
    fields: [
      {
        name: '📊 Palabras',
        value: `**${words.toLocaleString()}w** • ${readText} lectura`,
        inline: true,
      },
      {
        name: '⭐ Calidad',
        value: qText,
        inline: true,
      },
      {
        name: '💰 Potencial/mes',
        value: `~$${earnings} USD`,
        inline: true,
      },
      {
        name: '🔗 Afiliados',
        value: affiliateList.length ? affiliateList.join(', ') : 'Sin afiliados activos',
        inline: false,
      },
    ],
    footer: { text: 'aipickd.com • Pipeline automático' },
    timestamp: new Date().toISOString(),
  };

  // Si hay imagen, agregarla como thumbnail en Discord
  if (imageUrl) {
    embed.thumbnail = { url: imageUrl };
  }

  const payload = {
    username: 'AIPickd Bot 🤖',
    embeds: [embed],
  };

  const result = await postWebhook(env.DISCORD_WEBHOOK_ARTICULOS || env.DISCORD_WEBHOOK_URL, payload);
  if (process.env.NOTIFY_DEBUG) console.log('[notify:article]', result);
  return result;
}

// ─────────────────────────────────────────────
// 2. #alertas
// ─────────────────────────────────────────────

/** Alerta de error, anomalía, o evento crítico */
async function notifyAlert(message, severity = 'warning') {
  const colors = { critical: 0xff0000, high: 0xff4400, warning: 0xff9900, info: 0x3399ff };
  const icons  = { critical: '🚨', high: '🟠', warning: '⚠️', info: 'ℹ️' };
  const severityNorm = colors[severity] ? severity : 'warning';

  const payload = {
    username: 'AIPickd Alert 🚨',
    embeds: [{
      title: `${icons[severityNorm]} Alerta AIPickd — ${severityNorm.toUpperCase()}`,
      description: String(message).slice(0, 4000),
      color: colors[severityNorm],
      footer: { text: 'aipickd.com • Sistema de monitoreo' },
      timestamp: new Date().toISOString(),
    }],
  };

  const result = await postWebhook(env.DISCORD_WEBHOOK_ALERTAS, payload);
  if (process.env.NOTIFY_DEBUG) console.log('[notify:alert]', result);
  return result;
}

// ─────────────────────────────────────────────
// 3. #alertas — Alerta de presupuesto
// ─────────────────────────────────────────────

/**
 * @param {number} pct - Porcentaje usado (0-100+)
 * @param {number} spent - Gasto actual
 * @param {number} budget - Presupuesto máximo
 * @param {string} period - 'daily' | 'monthly'
 */
async function notifyBudgetAlert(pct, spent, budget, period = 'monthly') {
  const color = pct >= 100 ? 0xff0000 : pct >= 90 ? 0xff6600 : 0xffaa00;
  const icon  = pct >= 100 ? '🔴' : pct >= 90 ? '🟠' : '🟡';
  const bar   = progressBar(Math.min(pct, 100));
  const remaining = Math.max(0, budget - spent).toFixed(2);

  const statusMsg = pct >= 100
    ? '❌ **Presupuesto agotado** — pipeline detenido automáticamente'
    : pct >= 90
    ? '⚠️ Presupuesto casi agotado — considera pausar el pipeline'
    : '💡 Presupuesto al 70% — todo bajo control, solo un aviso';

  const payload = {
    username: 'AIPickd Alert 🚨',
    embeds: [{
      title: `${icon} Alerta de Presupuesto ${period === 'daily' ? 'Diario' : 'Mensual'} — ${pct.toFixed(0)}%`,
      description: statusMsg,
      color,
      fields: [
        { name: `💰 Gasto ${period === 'daily' ? 'hoy' : 'este mes'}`, value: `$${spent.toFixed(3)} / $${budget}`, inline: true },
        { name: '📊 Progreso', value: `${bar} **${pct.toFixed(0)}%**`, inline: false },
        { name: '💵 Disponible', value: `$${remaining}`, inline: true },
      ],
      footer: { text: 'aipickd.com • Monitor de presupuesto' },
      timestamp: new Date().toISOString(),
    }],
  };

  const result = await postWebhook(env.DISCORD_WEBHOOK_ALERTAS, payload);
  if (process.env.NOTIFY_DEBUG) console.log('[notify:budget]', result);
  return result;
}

// ─────────────────────────────────────────────
// 4. #alertas — Uptime del sitio
// ─────────────────────────────────────────────

async function notifyUptimeDown(statusCode, responseMs = null) {
  const detail = statusCode
    ? `HTTP ${statusCode} — el servidor respondió pero con error`
    : `Timeout / sin respuesta — el sitio no está accesible`;

  const payload = {
    username: 'AIPickd Alert 🚨',
    embeds: [{
      title: '🔴 aipickd.com CAÍDO',
      description: `**El sitio no está disponible.**\n${detail}`,
      color: 0xff0000,
      fields: [
        { name: '🌐 URL', value: 'https://aipickd.com', inline: true },
        { name: '⏱️ Tiempo de respuesta', value: responseMs ? `${responseMs}ms` : 'timeout', inline: true },
        { name: '📋 Estado HTTP', value: String(statusCode || 'N/A'), inline: true },
      ],
      footer: { text: 'aipickd.com • Monitor automático' },
      timestamp: new Date().toISOString(),
    }],
  };

  return postWebhook(env.DISCORD_WEBHOOK_ALERTAS, payload);
}

async function notifyUptimeRestored(responseMs = null) {
  const payload = {
    username: 'AIPickd Alert 🚨',
    embeds: [{
      title: '🟢 aipickd.com RESTAURADO',
      description: '**El sitio volvió a estar en línea.** ✅',
      color: 0x00cc66,
      fields: responseMs
        ? [{ name: '⏱️ Tiempo de respuesta', value: `${responseMs}ms`, inline: true }]
        : [],
      footer: { text: 'aipickd.com • Monitor automático' },
      timestamp: new Date().toISOString(),
    }],
  };
  return postWebhook(env.DISCORD_WEBHOOK_ALERTAS, payload);
}

// ─────────────────────────────────────────────
// 5. #pipeline-status
// ─────────────────────────────────────────────

async function notifyPipeline(message, stats = {}) {
  const fields = [];
  if (stats.articlesGenerated !== undefined)
    fields.push({ name: '🧠 Generados', value: String(stats.articlesGenerated), inline: true });
  if (stats.articlesPublished !== undefined)
    fields.push({ name: '📤 Publicados', value: String(stats.articlesPublished), inline: true });
  if (stats.qaFailed !== undefined)
    fields.push({ name: '🚫 QA Failed', value: String(stats.qaFailed), inline: true });
  if (stats.costUsd !== undefined)
    fields.push({ name: '💰 Costo run', value: `$${Number(stats.costUsd).toFixed(4)}`, inline: true });
  if (stats.budgetPct !== undefined)
    fields.push({ name: '📊 Budget día', value: `${progressBar(Math.min(stats.budgetPct, 100))} ${stats.budgetPct}%`, inline: false });
  if (stats.cost !== undefined && stats.costUsd === undefined)
    fields.push({ name: '💰 Costo', value: `$${Number(stats.cost).toFixed(3)}`, inline: true });
  if (stats.duration !== undefined)
    fields.push({ name: '⏱️ Duración', value: `${stats.duration}s`, inline: true });
  if (stats.totalArticles !== undefined)
    fields.push({ name: '📚 Total artículos', value: String(stats.totalArticles), inline: true });
  if (stats.monthlyCost !== undefined)
    fields.push({ name: '📅 Gasto mes', value: `$${Number(stats.monthlyCost).toFixed(2)}`, inline: true });
  if (stats.keywordsRemaining !== undefined)
    fields.push({ name: '🔑 Keywords en cola', value: String(stats.keywordsRemaining), inline: true });

  const hasFailures = (stats.qaFailed || 0) > 0;
  const color = (stats.articlesPublished || 0) > 0 ? 0x00cc66 : hasFailures ? 0xff9900 : 0x5865F2;

  const embed = {
    title: '⚙️ Pipeline Status',
    description: String(message).slice(0, 2000),
    color,
    fields,
    footer: { text: 'aipickd.com • GitHub Actions' },
    timestamp: new Date().toISOString(),
  };

  if (stats.runUrl) embed.url = stats.runUrl;

  const payload = { username: 'AIPickd Pipeline ⚙️', embeds: [embed] };

  const result = await postWebhook(env.DISCORD_WEBHOOK_PIPELINE, payload);
  if (process.env.NOTIFY_DEBUG) console.log('[notify:pipeline]', result);
  return result;
}

// ─────────────────────────────────────────────
// 6. #pipeline-status — Daily Digest
// ─────────────────────────────────────────────

/**
 * Reporte diario de la mañana
 * @param {object} stats
 * @param {number} stats.todayArticles
 * @param {number} stats.yesterdayArticles
 * @param {number} stats.todayCost
 * @param {number} stats.monthCost
 * @param {number} stats.keywordsInQueue
 * @param {string} stats.siteStatus - 'up'|'down'|'unknown'
 * @param {object|null} stats.lastArticle - {title, url}
 * @param {number} stats.totalArticles
 * @param {Array} stats.todayArticlesList - [{title, url, wordCount}]
 * @param {number} stats.todayQaFailed - articles that failed QA today
 * @param {number} stats.siteResponseMs - site response time in ms
 */
async function notifyDailyDigest(stats = {}) {
  const {
    todayArticles = 0,
    yesterdayArticles = 0,
    todayCost = 0,
    monthCost = 0,
    keywordsInQueue = 0,
    siteStatus = 'unknown',
    lastArticle = null,
    totalArticles = 0,
    publishRate = null,
    avgWordCount = null,
    qaFailedCount = null,
    todayArticlesList = [],
    todayQaFailed = 0,
    siteResponseMs = null,
    costPerArticle = null,
    projectedMonthlyCost = null,
  } = stats;

  const now = new Date();
  const dateStr = now.toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const trendEmoji = todayArticles > yesterdayArticles ? '📈' :
                     todayArticles < yesterdayArticles ? '📉' : '➡️';
  const siteEmoji  = siteStatus === 'up' ? '🟢' : siteStatus === 'down' ? '🔴' : '⚪';
  const budgetPct  = (monthCost / 50) * 100;
  const bar        = progressBar(budgetPct);
  const siteLabel  = siteStatus === 'up'
    ? `Online ✅${siteResponseMs ? ` (${siteResponseMs}ms)` : ''}`
    : siteStatus === 'down' ? 'CAÍDO 🚨' : 'Desconocido';

  const fields = [
    {
      name: `📝 Artículos hoy ${trendEmoji}`,
      value: `**${todayArticles}** publicados${todayQaFailed > 0 ? ` • 🚫 ${todayQaFailed} fallaron QA` : ''} (ayer: ${yesterdayArticles})`,
      inline: false,
    },
    {
      name: '💰 Gasto hoy',
      value: `$${todayCost.toFixed(3)}`,
      inline: true,
    },
    {
      name: `${siteEmoji} Sitio`,
      value: siteLabel,
      inline: true,
    },
    {
      name: '📅 Presupuesto mensual',
      value: `${bar} **${budgetPct.toFixed(0)}%**\n$${monthCost.toFixed(2)} / $50`,
      inline: false,
    },
    {
      name: '🔑 Keywords en cola',
      value: String(keywordsInQueue),
      inline: true,
    },
    {
      name: '📚 Total artículos',
      value: String(totalArticles),
      inline: true,
    },
  ];

  // Cost per article + month-end projection
  if (costPerArticle !== null && costPerArticle > 0) {
    fields.push({
      name: '💡 Costo/artículo (mes)',
      value: `$${costPerArticle.toFixed(4)}`,
      inline: true,
    });
  }
  if (projectedMonthlyCost !== null && projectedMonthlyCost > 0) {
    const projectedPct = (projectedMonthlyCost / 50) * 100;
    const projEmoji = projectedPct >= 90 ? '🔴' : projectedPct >= 70 ? '🟡' : '🟢';
    fields.push({
      name: `${projEmoji} Proyección mes`,
      value: `$${projectedMonthlyCost.toFixed(2)} (${projectedPct.toFixed(0)}%)`,
      inline: true,
    });
  }

  // Optional quality metrics (shown if available)
  if (publishRate !== null) {
    const rateEmoji = publishRate >= 80 ? '✅' : publishRate >= 60 ? '⚠️' : '🚨';
    fields.push({
      name: `${rateEmoji} Tasa publicación (7d)`,
      value: `**${publishRate}%**`,
      inline: true,
    });
  }
  if (avgWordCount !== null && avgWordCount > 0) {
    const wcEmoji = avgWordCount >= 2000 ? '✅' : avgWordCount >= 1500 ? '⚠️' : '🚨';
    fields.push({
      name: `${wcEmoji} Promedio palabras (7d)`,
      value: `**${avgWordCount.toLocaleString()}** palabras`,
      inline: true,
    });
  }
  if (qaFailedCount !== null && qaFailedCount > 0) {
    fields.push({
      name: '🚫 QA Failed (total)',
      value: `**${qaFailedCount}** artículos`,
      inline: true,
    });
  }

  // Show list of today's articles if any were published
  if (todayArticlesList.length > 0) {
    const articleLines = todayArticlesList.slice(0, 5).map(a => {
      const wc = a.wordCount ? ` (${a.wordCount.toLocaleString()}w)` : '';
      return a.url ? `• [${a.title.slice(0, 55)}](${a.url})${wc}` : `• ${a.title.slice(0, 55)}${wc}`;
    }).join('\n');
    fields.push({
      name: `✅ Publicados hoy (${Math.min(todayArticlesList.length, 5)} de ${todayArticlesList.length})`,
      value: articleLines,
      inline: false,
    });
  } else if (lastArticle) {
    // Fallback: show last article if no today list
    fields.push({
      name: '⭐ Último artículo publicado',
      value: `[${lastArticle.title}](${lastArticle.url})`,
      inline: false,
    });
  }

  const payload = {
    username: 'AIPickd Daily 📅',
    content: `☀️ **Daily Digest — ${dateStr}**`,
    embeds: [{
      color: 0x5865F2,
      fields,
      footer: { text: 'aipickd.com • Reporte automático diario — 9am' },
      timestamp: now.toISOString(),
    }],
  };

  const result = await postWebhook(env.DISCORD_WEBHOOK_PIPELINE, payload);
  if (process.env.NOTIFY_DEBUG) console.log('[notify:daily]', result);
  return result;
}

// ─────────────────────────────────────────────
// 7. #reportes-semanales — Reporte semanal mejorado
// ─────────────────────────────────────────────

async function notifyReport(stats = {}) {
  const {
    totalArticles = 0,
    weekArticles = 0,
    lastWeekArticles = 0,
    monthCost = 0,
    monthlyCost = 0, // legacy compat
    budget = 50,
    activeAffiliates = 1,
    pendingAffiliates = 0,
    topKeywords = [],
    topArticles = [],
    siteStatus = 'unknown',
    estimatedMonthlyEarnings = null,
    keywordsInQueue = 0,
    publishRate = null,
    avgWordCount = null,
    prevAvgWordCount = null,
    byType = {},
    topNiche = null,
    qaFailedCount = null,
  } = stats;

  const actualCost  = monthCost || monthlyCost;
  const weekDiff    = weekArticles - lastWeekArticles;
  const weekTrend   = weekDiff > 0 ? `📈 +${weekDiff}` : weekDiff < 0 ? `📉 ${weekDiff}` : '➡️ igual';
  const budgetPct   = (actualCost / budget) * 100;
  const bar         = progressBar(budgetPct);
  const siteEmoji   = siteStatus === 'up' ? '🟢 Online' : siteStatus === 'down' ? '🔴 Caído' : '⚪ Desconocido';

  // Earnings estimate
  const earningsEstimate = estimatedMonthlyEarnings !== null
    ? `~$${estimatedMonthlyEarnings}/mes`
    : `~$${(totalArticles * 12).toFixed(0)}/mes (estimado)`;

  const fields = [
    { name: '📚 Total artículos', value: String(totalArticles), inline: true },
    { name: '✅ Esta semana', value: `**${weekArticles}** (${weekTrend})`, inline: true },
    {
      name: '💰 Presupuesto mensual',
      value: `${bar} **${budgetPct.toFixed(0)}%**\n$${Number(actualCost).toFixed(2)} / $${budget}`,
      inline: false,
    },
    { name: '💵 Ingresos estimados', value: earningsEstimate, inline: true },
    { name: '🤝 Con afiliados', value: String(activeAffiliates), inline: true },
    { name: '🔑 Keywords en cola', value: String(keywordsInQueue), inline: true },
  ];

  // Publish rate
  if (publishRate !== null) {
    const rateEmoji = publishRate >= 80 ? '✅' : publishRate >= 60 ? '⚠️' : '🚨';
    fields.push({ name: `${rateEmoji} Tasa publicación`, value: `**${publishRate}%**`, inline: true });
  }

  // Avg word count with trend
  if (avgWordCount !== null && avgWordCount > 0) {
    const wcEmoji = avgWordCount >= 2000 ? '✅' : avgWordCount >= 1500 ? '⚠️' : '🚨';
    const wcTrend = prevAvgWordCount && prevAvgWordCount > 0
      ? avgWordCount > prevAvgWordCount ? ' 📈' : avgWordCount < prevAvgWordCount ? ' 📉' : ''
      : '';
    fields.push({
      name: `${wcEmoji} Promedio palabras${wcTrend}`,
      value: `**${avgWordCount.toLocaleString()}**w`,
      inline: true,
    });
  }

  // QA failed
  if (qaFailedCount !== null && qaFailedCount > 0) {
    fields.push({ name: '🚫 QA Failed', value: `${qaFailedCount} artículos`, inline: true });
  }

  // Article type breakdown
  const typeEntries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  if (typeEntries.length > 0) {
    fields.push({
      name: '📋 Por tipo',
      value: typeEntries.map(([t, c]) => `${t}: **${c}**`).join(' · '),
      inline: false,
    });
  }

  // Top niche
  if (topNiche) {
    fields.push({ name: '🎯 Nicho más activo', value: topNiche, inline: true });
  }

  // Top articles this week
  if (topArticles.length > 0) {
    fields.push({
      name: '🏆 Top artículos (palabras)',
      value: topArticles.slice(0, 3).map((a, i) =>
        `${i + 1}. [${(a.title || '').slice(0, 45)}](${a.url || '#'}) — ${(a.words || 0).toLocaleString()}w`
      ).join('\n'),
      inline: false,
    });
  }

  if (topKeywords.length > 0) {
    fields.push({
      name: '🏷️ Keywords procesadas',
      value: topKeywords.slice(0, 5).map((k, i) => `${i + 1}. ${k}`).join('\n'),
      inline: false,
    });
  }

  const payload = {
    username: 'AIPickd Reports 📊',
    embeds: [{
      title: '📊 Reporte Semanal — AIPickd',
      color: 0xffd700,
      fields,
      footer: { text: 'aipickd.com • Reporte automático semanal' },
      timestamp: new Date().toISOString(),
    }],
  };

  const result = await postWebhook(env.DISCORD_WEBHOOK_REPORTES, payload);
  if (process.env.NOTIFY_DEBUG) console.log('[notify:report]', result);
  return result;
}

// ─────────────────────────────────────────────
// 8. Compat: notify genérico para código legacy
// ─────────────────────────────────────────────
async function notify(message, channel = 'pipeline') {
  switch (channel) {
    case 'article': return notifyPipeline(message);
    case 'alert':   return notifyAlert(message);
    case 'report':  return notifyReport({ notes: message });
    default:        return notifyPipeline(message);
  }
}

// Exports
module.exports = {
  notify,
  notifyArticle,
  notifyAlert,
  notifyPipeline,
  notifyReport,
  notifyDailyDigest,
  notifyBudgetAlert,
  notifyUptimeDown,
  notifyUptimeRestored,
  calcQualityScore,
  estimateEarnings,
};

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────
if (require.main === module) {
  const [,, type, ...args] = process.argv;

  const run = async () => {
    let result;
    switch (type) {
      case 'article':
        result = await notifyArticle(
          args[0] || '🧪 Artículo de prueba — Best AI Tools 2026',
          args[1] || 'https://aipickd.com/test',
          args[2] || 2500,
          args[3] || 'Jasper,Semrush',
          85,
          null
        );
        break;

      case 'alert':
        result = await notifyAlert(
          args.join(' ') || '⚠️ Test alert — todo está bien',
          args[0] === 'critical' ? 'critical' : args[0] === 'high' ? 'high' : 'warning'
        );
        break;

      case 'pipeline':
        result = await notifyPipeline(args.join(' ') || '✅ Pipeline test OK', {
          articlesGenerated: 1, articlesPublished: 1, cost: 0.045,
          duration: 87, totalArticles: 82, keywordsRemaining: 47,
        });
        break;

      case 'report':
        result = await notifyReport({
          totalArticles: 82,
          weekArticles: 12,
          lastWeekArticles: 8,
          monthlyCost: 3.80,
          activeAffiliates: 1,
          pendingAffiliates: 32,
          siteStatus: 'up',
          keywordsInQueue: 47,
        });
        break;

      case 'daily':
        result = await notifyDailyDigest({
          todayArticles: 3,
          yesterdayArticles: 2,
          todayCost: 0.12,
          monthCost: 3.80,
          keywordsInQueue: 47,
          siteStatus: 'up',
          totalArticles: 82,
          lastArticle: {
            title: 'Best AI Writing Tools 2026 — In-Depth Review',
            url: 'https://aipickd.com/best-ai-writing-tools-2026',
          },
        });
        break;

      case 'budget':
        result = await notifyBudgetAlert(
          parseFloat(args[0]) || 72,
          parseFloat(args[1]) || 36,
          parseFloat(args[2]) || 50
        );
        break;

      case 'uptime-down':
        result = await notifyUptimeDown(503, 15000);
        break;

      case 'uptime-up':
        result = await notifyUptimeRestored(320);
        break;

      default:
        result = await notifyPipeline(
          args.join(' ') || type || '🤖 AIPickd test notification',
          {}
        );
    }

    console.log('Result:', JSON.stringify(result));
    if (!result?.ok) console.log('\n💡 Verifica que los webhooks estén en .env');
  };

  run().catch(console.error);
}
