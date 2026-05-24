#!/usr/bin/env node
/**
 * AIPickd — Dedup de keywords en cola
 *
 * Detecta y elimina keywords muy similares en la cola (status=queued).
 * "Muy similar" = mismo significado con distinto wording.
 * Ej: "best AI writing tools 2026" vs "top AI writing tools for 2026"
 *
 * Usa Jaccard similarity sobre palabras significativas (sin stop words).
 * Threshold configurable (default: 0.65 = 65% de palabras en común).
 *
 * Usage:
 *   node scripts/dedup-keywords.js              # dry-run (solo reporta)
 *   node scripts/dedup-keywords.js --fix        # elimina duplicados
 *   node scripts/dedup-keywords.js --threshold 0.8  # más estricto
 */

const { loadEnv } = require('./lib/env');
const env = loadEnv();

const args     = process.argv.slice(2);
const FIX_MODE = args.includes('--fix');
const THRESHOLD = parseFloat(args[args.indexOf('--threshold') + 1]) || 0.65;

const STOP_WORDS = new Set([
  'the','a','an','in','of','for','and','or','to','is','are','with',
  'how','best','top','vs','ai','tool','tools','your','you','use',
  'using','guide','review','2026','2025','what','why','when','which',
  'most','more','all','any','from','that','this','these','those',
  'good','great','free','new','old','get','has','have',
]);

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

// Extract meaningful words
function tokenize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// Jaccard similarity (0 = nothing in common, 1 = identical)
function jaccard(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  const intersection = new Set([...sa].filter(w => sb.has(w)));
  const union = new Set([...sa, ...sb]);
  return intersection.size / union.size;
}

(async () => {
  console.log('== AIPickd dedup-keywords ==');
  console.log(`   Similarity threshold: ${THRESHOLD}`);
  console.log(`   Mode: ${FIX_MODE ? 'FIX (will delete)' : 'DRY RUN'}\n`);

  // Load all queued keywords
  const queued = await supa('GET', 'keywords?status=eq.queued&select=id,keyword,niche_id,priority&order=priority.desc');
  if (!queued || queued.length === 0) {
    console.log('No queued keywords found.');
    return;
  }
  console.log(`Checking ${queued.length} queued keywords for similarity...\n`);

  const toDelete = new Set();
  const dupePairs = [];

  for (let i = 0; i < queued.length; i++) {
    if (toDelete.has(queued[i].id)) continue;
    for (let j = i + 1; j < queued.length; j++) {
      if (toDelete.has(queued[j].id)) continue;
      const score = jaccard(queued[i].keyword, queued[j].keyword);
      if (score >= THRESHOLD) {
        // Keep the one with higher priority, delete the other
        const keep = queued[i].priority >= queued[j].priority ? queued[i] : queued[j];
        const del  = keep.id === queued[i].id ? queued[j] : queued[i];
        toDelete.add(del.id);
        dupePairs.push({ keep: keep.keyword, del: del.keyword, score: score.toFixed(2) });
      }
    }
  }

  if (dupePairs.length === 0) {
    console.log('✅ No similar keywords found. Queue is clean.');
    return;
  }

  console.log(`Found ${dupePairs.length} similar pairs:\n`);
  dupePairs.forEach(({ keep, del, score }) => {
    console.log(`  [${score}] KEEP: "${keep}"`);
    console.log(`         DEL:  "${del}"`);
  });

  if (!FIX_MODE) {
    console.log(`\n⚠️  DRY RUN — ${toDelete.size} keywords would be deleted.`);
    console.log(`   Run with --fix to delete them.\n`);
    return;
  }

  // Delete similar keywords in batches
  const ids = [...toDelete];
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      await supa('DELETE', `keywords?id=in.(${batch.join(',')})&status=eq.queued`);
      deleted += batch.length;
    } catch (e) {
      console.log(`  ⚠️  Batch delete error: ${e.message.slice(0,80)}`);
    }
  }

  console.log(`\n✅ Deleted ${deleted} similar keywords from queue.`);
  console.log(`   Remaining queued: ${queued.length - deleted}`);

  // Discord notify
  if (deleted > 0 && env.DISCORD_WEBHOOK_ALERTAS) {
    await fetch(env.DISCORD_WEBHOOK_ALERTAS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🔑 **Keyword dedup:** ${deleted} keywords similares eliminados de la cola`
      }),
    }).catch(() => {});
  }
})().catch(e => {
  console.error('❌ ERROR:', e.message);
  process.exit(1);
});
