#!/usr/bin/env node
/**
 * AIPickd — Unified notifications
 *
 * 4 canales de Discord (AIPickd HQ server):
 *   #articulos-publicados  → notify.article(title, url, words, affiliates)
 *   #alertas               → notify.alert(message)
 *   #pipeline-status       → notify.pipeline(message)
 *   #reportes-semanales    → notify.report(stats)
 *
 * CLI:
 *   node scripts/notify.js article "Título" "https://..." 2500 "Jasper,Semrush"
 *   node scripts/notify.js alert "El sitio está caído"
 *   node scripts/notify.js pipeline "Pipeline terminó: 3 artículos, $0.18"
 *   node scripts/notify.js report         # genera reporte desde Supabase
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

// ──────────────────────────────────────────────
// Core: POST to a Discord webhook with an embed
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// Channel helpers
// ──────────────────────────────────────────────

/** #articulos-publicados — nuevo artículo */
async function notifyArticle(title, url, wordCount = 0, affiliates = []) {
  const affiliateList = Array.isArray(affiliates) ? affiliates : String(affiliates).split(',').filter(Boolean);
  const payload = {
    username: 'AIPickd Bot 🤖',
    embeds: [{
      title: `📝 Nuevo artículo publicado`,
      description: `**[${title}](${url})**`,
      color: 0x00cc66, // green
      fields: [
        { name: '📊 Palabras', value: wordCount ? `${Number(wordCount).toLocaleString()}` : 'N/A', inline: true },
        { name: '🔗 Afiliados', value: affiliateList.length ? affiliateList.join(', ') : 'Solo Amazon', inline: true },
        { name: '🌐 URL', value: url, inline: false },
      ],
      footer: { text: 'aipickd.com • Pipeline automático' },
      timestamp: new Date().toISOString(),
    }],
  };
  const result = await postWebhook(env.DISCORD_WEBHOOK_ARTICULOS || env.DISCORD_WEBHOOK_URL, payload);
  if (process.env.NOTIFY_DEBUG) console.log('[notify:article]', result);
  return result;
}

/** #alertas — error o anomalía */
async function notifyAlert(message, severity = 'warning') {
  const colors = { critical: 0xff0000, warning: 0xff9900, info: 0x3399ff };
  const icons = { critical: '🚨', warning: '⚠️', info: 'ℹ️' };
  const payload = {
    username: 'AIPickd Alert 🚨',
    embeds: [{
      title: `${icons[severity] || '⚠️'} Alerta AIPickd`,
      description: message.slice(0, 4096),
      color: colors[severity] || colors.warning,
      footer: { text: 'aipickd.com • Sistema de monitoreo' },
      timestamp: new Date().toISOString(),
    }],
  };
  const result = await postWebhook(env.DISCORD_WEBHOOK_ALERTAS, payload);
  if (process.env.NOTIFY_DEBUG) console.log('[notify:alert]', result);
  return result;
}

/** #pipeline-status — inicio/fin de pipeline */
async function notifyPipeline(message, stats = {}) {
  const fields = [];
  if (stats.articlesGenerated !== undefined) fields.push({ name: '📝 Artículos', value: String(stats.articlesGenerated), inline: true });
  if (stats.cost !== undefined) fields.push({ name: '💰 Costo', value: `$${Number(stats.cost).toFixed(3)}`, inline: true });
  if (stats.duration !== undefined) fields.push({ name: '⏱️ Duración', value: `${stats.duration}s`, inline: true });
  if (stats.totalArticles !== undefined) fields.push({ name: '📚 Total artículos', value: String(stats.totalArticles), inline: true });
  if (stats.monthlyCost !== undefined) fields.push({ name: '📅 Gasto mes', value: `$${Number(stats.monthlyCost).toFixed(2)}`, inline: true });

  const payload = {
    username: 'AIPickd Pipeline ⚙️',
    embeds: [{
      title: '⚙️ Pipeline Status',
      description: message.slice(0, 4096),
      color: 0x5865F2, // Discord blurple
      fields,
      footer: { text: 'aipickd.com • GitHub Actions' },
      timestamp: new Date().toISOString(),
    }],
  };
  const result = await postWebhook(env.DISCORD_WEBHOOK_PIPELINE, payload);
  if (process.env.NOTIFY_DEBUG) console.log('[notify:pipeline]', result);
  return result;
}

/** #reportes-semanales — resumen semanal */
async function notifyReport(stats = {}) {
  const {
    totalArticles = 0,
    weekArticles = 0,
    monthlyCost = 0,
    activeAffiliates = 1,
    pendingAffiliates = 32,
    topKeywords = [],
    siteStatus = 'unknown',
  } = stats;

  const payload = {
    username: 'AIPickd Reports 📊',
    embeds: [{
      title: '📊 Reporte Semanal — AIPickd',
      color: 0xffd700, // gold
      fields: [
        { name: '📚 Total artículos', value: String(totalArticles), inline: true },
        { name: '✅ Esta semana', value: String(weekArticles), inline: true },
        { name: '🌐 Sitio', value: siteStatus === 'up' ? '🟢 Online' : '🔴 Offline', inline: true },
        { name: '💰 Gasto mensual', value: `$${Number(monthlyCost).toFixed(2)} / $50`, inline: true },
        { name: '🤝 Afiliados activos', value: String(activeAffiliates), inline: true },
        { name: '⏳ Afiliados pendientes', value: String(pendingAffiliates), inline: true },
      ],
      footer: { text: 'aipickd.com • Reporte automático semanal' },
      timestamp: new Date().toISOString(),
    }],
  };
  const result = await postWebhook(env.DISCORD_WEBHOOK_REPORTES, payload);
  if (process.env.NOTIFY_DEBUG) console.log('[notify:report]', result);
  return result;
}

/** Generic: para compatibilidad con código legacy */
async function notify(message, channel = 'pipeline') {
  switch (channel) {
    case 'article': return notifyPipeline(message);
    case 'alert': return notifyAlert(message);
    case 'report': return notifyReport({ notes: message });
    default: return notifyPipeline(message);
  }
}

// Export
module.exports = { notify, notifyArticle, notifyAlert, notifyPipeline, notifyReport };

// ──────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────
if (require.main === module) {
  const [,, type, ...args] = process.argv;

  const run = async () => {
    let result;
    switch (type) {
      case 'article':
        result = await notifyArticle(args[0] || 'Test Article', args[1] || 'https://aipickd.com', args[2] || 2500, args[3] || 'Amazon');
        break;
      case 'alert':
        result = await notifyAlert(args.join(' ') || '⚠️ Test alert', args[0] === 'critical' ? 'critical' : 'warning');
        break;
      case 'pipeline':
        result = await notifyPipeline(args.join(' ') || '✅ Pipeline test OK');
        break;
      case 'report':
        result = await notifyReport({
          totalArticles: 85,
          weekArticles: 12,
          monthlyCost: 3.80,
          activeAffiliates: 1,
          pendingAffiliates: 32,
          siteStatus: 'up',
        });
        break;
      default:
        // Legacy: just send the message to pipeline channel
        result = await notifyPipeline(args.join(' ') || type || '🤖 AIPickd test notification');
    }
    console.log('Result:', JSON.stringify(result));
    if (!result.ok) console.log('\n💡 Verifica que los webhooks estén en .env');
  };

  run().catch(console.error);
}
