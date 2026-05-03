#!/usr/bin/env node
/**
 * AIPickd — Cleanup de drafts atascados
 *
 * Un draft "atascado" es un artículo que lleva >5 días en status=draft
 * sin wp_post_id (nunca llegó a WordPress). Esto pasa cuando el pipeline
 * falla a la mitad de la generación.
 *
 * Lo que hace:
 *   1. Encuentra drafts viejos sin wp_post_id
 *   2. Los marca como qa_failed (limpia la cola)
 *   3. Re-encola el keyword para que vuelva a generarse
 *   4. Notifica a Discord
 *
 * Corre automáticamente en generate.yml después del pipeline.
 *
 * Usage:
 *   node scripts/cleanup-stuck-drafts.js             # default: >5 días
 *   node scripts/cleanup-stuck-drafts.js --days 3    # >3 días
 *   node scripts/cleanup-stuck-drafts.js --dry-run   # solo reporta
 */

const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const env = {};
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch {}

const args   = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DAYS    = parseInt(args[args.indexOf('--days') + 1]) || 5;

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
  if (!res.ok) throw new Error(`Supabase ${method} ${endpoint}: ${res.status} ${text.slice(0,200)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  console.log('== AIPickd cleanup-stuck-drafts ==');
  console.log(`   Threshold: >${DAYS} days in draft without wp_post_id`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'FIX'}\n`);

  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Find stuck drafts
  const stuck = await supa('GET', `articles?status=eq.draft&wp_post_id=is.null&created_at=lt.${encodeURIComponent(cutoff)}&select=id,title,keyword_id,created_at`);

  if (!stuck || stuck.length === 0) {
    console.log('✅ No stuck drafts found.');
    return;
  }

  console.log(`Found ${stuck.length} stuck drafts:\n`);
  stuck.forEach(a => {
    const age = Math.floor((Date.now() - new Date(a.created_at)) / 86400000);
    console.log(`  [${age}d] ${(a.title || 'untitled').slice(0, 60)}`);
  });

  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN — nothing changed.');
    return;
  }

  let cleaned = 0;
  let requeued = 0;

  for (const article of stuck) {
    // Mark article as qa_failed
    await supa('PATCH', `articles?id=eq.${article.id}`, {
      status: 'qa_failed',
      quality_score: 0,
    }).catch(() => {});
    cleaned++;

    // Re-queue the keyword so it gets regenerated
    if (article.keyword_id) {
      await supa('PATCH', `keywords?id=eq.${article.keyword_id}&status=in.(in_progress,published)`, {
        status: 'queued',
        assigned_article_id: null,
      }).catch(() => {});
      requeued++;
    }
  }

  console.log(`\n✅ Cleaned ${cleaned} stuck drafts. Re-queued ${requeued} keywords.`);

  // Discord alert
  if (cleaned > 0 && env.DISCORD_WEBHOOK_ALERTAS) {
    const msg = `🧹 **Stuck drafts limpiados**\n` +
      `Artículos reseteados: ${cleaned}\n` +
      `Keywords re-encolados: ${requeued}\n` +
      `(llevaban >${DAYS} días sin publicarse)`;
    await fetch(env.DISCORD_WEBHOOK_ALERTAS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg }),
    }).catch(() => {});
  }
})().catch(e => {
  console.error('❌ ERROR:', e.message);
  process.exit(1);
});
