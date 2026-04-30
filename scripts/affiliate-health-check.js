#!/usr/bin/env node
/**
 * AIPickd — Affiliate Link Health Check
 *
 * Verifies every active affiliate link in Supabase is reachable.
 * Alerts on 404s, redirects to unexpected domains, or timeouts.
 *
 * Usage:
 *   node scripts/affiliate-health-check.js
 *   node scripts/affiliate-health-check.js --dry-run
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
const DRY_RUN = process.argv.includes('--dry-run');

async function supa(method, endpoint, body) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function checkLink(url, brand) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AIPickd-healthcheck/1.0)',
      },
      redirect: 'follow',
    });
    const finalUrl = res.url;
    const originalDomain = new URL(url).hostname.replace(/^www\./, '');
    const finalDomain = new URL(finalUrl).hostname.replace(/^www\./, '');
    const domainChanged = !finalDomain.includes(originalDomain) && !originalDomain.includes(finalDomain);
    return {
      brand,
      url,
      status: res.status,
      ok: res.ok,
      finalUrl,
      domainChanged,
      redirected: finalUrl !== url,
    };
  } catch (e) {
    return { brand, url, status: 0, ok: false, error: e.message };
  }
}

(async () => {
  console.log('🔗 AIPickd Affiliate Health Check\n');

  // Fetch all affiliates
  const affiliates = await supa('GET', 'affiliates?select=id,brand,base_url,status&order=brand.asc');
  if (!Array.isArray(affiliates) || affiliates.length === 0) {
    console.log('⚠️ No affiliates in database.');
    return;
  }

  console.log(`Checking ${affiliates.length} affiliate links...\n`);

  const results = await Promise.all(
    affiliates.map(a => checkLink(a.base_url, a.brand).then(r => ({ ...r, id: a.id, dbStatus: a.status })))
  );

  const dead         = results.filter(r => !r.ok && r.status === 404);
  const errors       = results.filter(r => !r.ok && r.status !== 404);
  const badRedirects = results.filter(r => r.ok && r.domainChanged);
  const alive        = results.filter(r => r.ok && !r.domainChanged);

  // Console output
  console.log(`✅ Healthy: ${alive.length}`);
  if (badRedirects.length > 0) {
    console.log(`\n⚠️ Suspicious redirects (${badRedirects.length}):`);
    badRedirects.forEach(r => console.log(`   ${r.brand}: ${r.url} → ${r.finalUrl}`));
  }
  if (dead.length > 0) {
    console.log(`\n🔴 Dead links (404) — ${dead.length}:`);
    dead.forEach(r => console.log(`   ${r.brand}: ${r.url}`));
  }
  if (errors.length > 0) {
    console.log(`\n🟠 Errors — ${errors.length}:`);
    errors.forEach(r => console.log(`   ${r.brand}: ${r.status || r.error} — ${r.url}`));
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] No Discord alerts or DB updates.');
    return;
  }

  // Mark dead affiliates as paused in DB so pipeline doesn't use them
  for (const r of dead) {
    await supa('PATCH', `affiliates?id=eq.${r.id}`, { status: 'paused' }).catch(() => {});
    console.log(`   ⏸️  Paused affiliate: ${r.brand}`);
  }

  // Send Discord alert
  const problems = [...dead, ...errors, ...badRedirects];
  if (problems.length > 0) {
    const lines = problems.slice(0, 10).map(r => {
      if (r.status === 404) return `• 🔴 **${r.brand}** — 404 Not Found (marcado como pausado)`;
      if (r.domainChanged) return `• ⚠️ **${r.brand}** — redirige a dominio diferente: \`${new URL(r.finalUrl).hostname}\``;
      return `• 🟠 **${r.brand}** — Error ${r.status || 'timeout'}`;
    }).join('\n');

    await notifyAlert(
      `🔗 **Affiliate Health Check — ${problems.length} problemas encontrados**\n\n${lines}\n\n` +
      `✅ Saludables: ${alive.length}/${results.length}\n\n` +
      `💡 Los afiliados con 404 fueron pausados en la base de datos automáticamente.`,
      problems.some(r => r.status === 404) ? 'high' : 'warning'
    ).catch(() => {});
    console.log('\n🔔 Discord alert sent');
  } else {
    console.log('\n✅ All affiliate links are healthy!');
    // Optionally send a "all clear" message (optional, only on explicit run)
  }

  // Check for affiliates that have been "pending" > 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const stalePending = await supa('GET',
    `affiliates?status=eq.pending&created_at=lt.${thirtyDaysAgo}&select=brand,created_at`
  ).catch(() => []);
  if (Array.isArray(stalePending) && stalePending.length > 0) {
    const brands = stalePending.map(a => `• ${a.brand}`).join('\n');
    await notifyAlert(
      `⏳ **${stalePending.length} afiliados llevan +30 días en "pending"**\n\n${brands}\n\n💡 ¿Ya terminaste de aplicar? Actualiza su status en Supabase.`,
      'info'
    ).catch(() => {});
    console.log(`⏳ Stale pending alert sent (${stalePending.length} affiliates)`);
  }

  console.log('\nDone!');
})().catch((e) => {
  console.error('❌ Health check failed:', e.message);
  process.exit(1);
});
