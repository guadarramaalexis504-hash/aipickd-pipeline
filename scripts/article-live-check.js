#!/usr/bin/env node
/**
 * AIPickd — Article Live Check
 *
 * Fetches the last N published articles from Supabase and pings each URL.
 * Alerts Discord for any article returning non-200.
 *
 * Usage:
 *   node scripts/article-live-check.js              # check last 20 articles
 *   node scripts/article-live-check.js --count 50   # check last 50
 *   node scripts/article-live-check.js --dry-run    # print results, no Discord
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
const countIdx = args.indexOf('--count');
const CHECK_COUNT = countIdx >= 0 ? parseInt(args[countIdx + 1]) : 20;
const DRY_RUN = args.includes('--dry-run');

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

async function checkUrl(url) {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 AIPickd-livecheck/1.0' },
      redirect: 'follow',
    });
    return { url, status: res.status, ok: res.ok, ms: Date.now() - start };
  } catch (e) {
    return { url, status: 0, ok: false, ms: Date.now() - start, error: e.message };
  }
}

(async () => {
  console.log(`🔍 AIPickd Article Live Check (last ${CHECK_COUNT} articles)\n`);

  // Fetch recent published articles with URLs
  const articles = await supa(
    `articles?status=eq.published&wp_url=not.is.null&order=published_at.desc&limit=${CHECK_COUNT}&select=id,title,wp_url,published_at`
  );

  if (!Array.isArray(articles) || articles.length === 0) {
    console.log('⚠️ No published articles with URLs found in Supabase.');
    return;
  }

  console.log(`Checking ${articles.length} article URLs...\n`);

  // Check all URLs concurrently (with slight stagger to avoid overwhelming server)
  const results = [];
  const batchSize = 5;
  for (let i = 0; i < articles.length; i += batchSize) {
    const batch = articles.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(a => checkUrl(a.wp_url).then(r => ({ ...r, title: a.title, id: a.id })))
    );
    results.push(...batchResults);
    // Small delay between batches
    if (i + batchSize < articles.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Separate results
  const alive   = results.filter(r => r.ok);
  const dead    = results.filter(r => !r.ok && r.status === 404);
  const errors  = results.filter(r => !r.ok && r.status !== 404);
  const slow    = alive.filter(r => r.ms > 5000);

  // Console output
  console.log(`✅ Alive: ${alive.length}/${results.length}`);
  if (dead.length > 0) {
    console.log(`\n🔴 DEAD (404) — ${dead.length} articles:`);
    dead.forEach(r => console.log(`   404 — ${r.url}`));
  }
  if (errors.length > 0) {
    console.log(`\n🟠 ERRORS — ${errors.length} articles:`);
    errors.forEach(r => console.log(`   ${r.status || 'timeout'} — ${r.url} (${r.error || ''})`));
  }
  if (slow.length > 0) {
    console.log(`\n🐢 SLOW (>5s) — ${slow.length} articles:`);
    slow.forEach(r => console.log(`   ${r.ms}ms — ${r.url}`));
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] No Discord alerts sent.');
    return;
  }

  // Send Discord alerts
  if (dead.length > 0) {
    const lines = dead.slice(0, 8).map(r =>
      `• **404** — [${(r.title || r.url).slice(0, 55)}](${r.url})`
    ).join('\n');
    await notifyAlert(
      `🔴 **${dead.length} artículos retornan 404**\n\nEstos artículos no están accesibles (posible 404 en WordPress):\n\n${lines}${dead.length > 8 ? `\n... y ${dead.length - 8} más.` : ''}\n\n💡 Verificar en WordPress si los posts están publicados o si el slug cambió.`,
      'high'
    ).catch(() => {});
    console.log('\n🔴 Dead articles alert sent to Discord');
  }

  if (errors.length > 0) {
    const lines = errors.slice(0, 5).map(r =>
      `• **${r.status || 'timeout'}** — ${(r.url || '').slice(-60)}`
    ).join('\n');
    await notifyAlert(
      `🟠 **${errors.length} artículos con errores HTTP**\n\n${lines}${errors.length > 5 ? `\n... y ${errors.length - 5} más.` : ''}\n\n💡 Puede ser timeout de servidor, error 500, o caché rota.`,
      'warning'
    ).catch(() => {});
    console.log('🟠 Error articles alert sent to Discord');
  }

  if (slow.length >= 3) {
    await notifyAlert(
      `🐢 **${slow.length} artículos cargan en >5s**\n\nEl sitio puede tener problemas de velocidad o caché rota.\nPromedio: ${Math.round(slow.reduce((s, r) => s + r.ms, 0) / slow.length)}ms\n\n💡 Revisar LiteSpeed cache y Cloudflare.`,
      'info'
    ).catch(() => {});
    console.log('🐢 Slow articles alert sent');
  }

  if (dead.length === 0 && errors.length === 0) {
    console.log('\n✅ All articles are live and responding correctly!');
  }
})().catch((e) => {
  console.error('❌ Live check failed:', e.message);
  process.exit(1);
});
