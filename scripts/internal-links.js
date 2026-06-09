#!/usr/bin/env node
/**
 * AIPickd — Auto Internal Linking
 *
 * Corre después de cada publicación.
 * Para cada artículo recién publicado (últimas 2 horas):
 *   1. Busca los 5 artículos más relacionados en Supabase por overlap de palabras
 *   2. Agrega sección "Related Articles" al final del post en WordPress
 *   3. Actualiza los artículos relacionados para que también linkeen de vuelta
 *
 * No usa IA — scoring por overlap de palabras clave (gratis, rápido).
 *
 * Usage:
 *   node scripts/internal-links.js              # artículos de las últimas 2h
 *   node scripts/internal-links.js --hours 24   # artículos de las últimas 24h
 *   node scripts/internal-links.js --all        # todos los artículos publicados
 *   node scripts/internal-links.js --dry-run    # reporta sin modificar WP
 */

const { loadEnv } = require('./lib/env');
const { hasWriteFlag } = require("./lib/cli-safety");
const { filterCandidatesByLanguage, buildRelatedBlock } = require("./lib/internal-linking");
const env = loadEnv();

const args     = process.argv.slice(2);
const DRY_RUN  = !hasWriteFlag(args, new Set(["--go"]));
const ALL_MODE = args.includes('--all');
const ALLOW_CROSS_LANG = args.includes("--allow-cross-lang");
const HOURS    = parseInt(args[args.indexOf('--hours') + 1]) || 2;
const MAX_RELATED = 5;   // links per article
const MIN_SCORE   = 1;   // minimum word overlap to be considered related

const STOP_WORDS = new Set([
  'the','a','an','in','of','for','and','or','to','is','are','with',
  'how','best','top','vs','ai','tool','tools','your','you','use',
  'using','guide','review','2026','2025','what','why','when','which',
]);

// --- helpers ---
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

async function wp(method, endpoint, body) {
  const auth = Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString('base64');
  const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WP ${method} ${endpoint}: ${res.status} ${text.slice(0,200)}`);
  return text ? JSON.parse(text) : null;
}

// Extract meaningful words from a string
function keywords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));
}

// Score how related two articles are (word overlap)
function relatednessScore(a, b) {
  const wa = new Set(keywords(`${a.title} ${a.meta_description || ''} ${a.slug}`));
  const wb = new Set(keywords(`${b.title} ${b.meta_description || ''} ${b.slug}`));
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap;
}

// Find top N related articles from a pool
function findRelated(article, pool, n = MAX_RELATED) {
  return filterCandidatesByLanguage(article, pool, { allowCrossLang: ALLOW_CROSS_LANG })
    .filter(p => p.id !== article.id)
    .map(p => ({ ...p, score: relatednessScore(article, p) }))
    .filter(p => p.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

// Check if WP post already has a related articles block
function hasRelatedBlock(html) {
  return (html || '').includes('aipickd-related');
}

// --- main ---
(async () => {
  console.log('== AIPickd internal-links ==');
  console.log(`   Mode: ${DRY_RUN ? 'REPORT ONLY (add --go to write)' : ALL_MODE ? 'WRITE all articles' : `WRITE last ${HOURS}h`}`);
  console.log(`   Cross-language links: ${ALLOW_CROSS_LANG ? "allowed" : "blocked"}\n`);

  // 1) Load all published articles with wp_url
  console.log('1) Loading published articles from Supabase...');
  const all = await supa('GET', 'articles?status=eq.published&wp_post_id=not.is.null&select=id,title,slug,language,meta_description,article_type,wp_post_id,wp_url,published_at');
  if (!all || all.length === 0) { console.log('   No published articles.'); return; }
  console.log(`   ${all.length} published articles loaded.\n`);

  // 2) Pick target articles (recently published OR all)
  let targets;
  if (ALL_MODE) {
    targets = all;
  } else {
    const cutoff = new Date(Date.now() - HOURS * 60 * 60 * 1000).toISOString();
    targets = all.filter(a => a.published_at >= cutoff);
  }
  console.log(`2) Targets to process: ${targets.length}\n`);

  if (targets.length === 0) {
    console.log('   No recent articles to process.');
    return;
  }

  let updated = 0;
  let skipped = 0;

  for (const article of targets) {
    if (!article.wp_post_id || !article.wp_url) { skipped++; continue; }

    const related = findRelated(article, all);
    if (related.length === 0) {
      console.log(`   ⏩ "${article.title.slice(0,50)}" — no related articles found`);
      skipped++;
      continue;
    }

    console.log(`   📎 "${article.title.slice(0,50)}"`);
    related.forEach(r => console.log(`      ↳ [${r.score}] ${r.title.slice(0,50)}`));

    if (DRY_RUN) { skipped++; continue; }

    // Fetch current WP post content
    try {
      const wpPost = await wp('GET', `posts/${article.wp_post_id}?_fields=id,content`);
      const currentHtml = wpPost.content?.rendered || '';

      if (hasRelatedBlock(currentHtml)) {
        console.log(`      ⏩ Already has related block, skipping.`);
        skipped++;
        continue;
      }

      // Append related articles block to raw content (not rendered)
      const rawPost = await wp('GET', `posts/${article.wp_post_id}?context=edit&_fields=id,content`);
      const rawContent = rawPost.content?.raw || rawPost.content?.rendered || '';
      const relatedBlock = buildRelatedBlock(related, { language: article.language });
      const newContent = rawContent + relatedBlock;

      await wp('POST', `posts/${article.wp_post_id}`, { content: newContent });
      updated++;
      console.log(`      ✅ Added ${related.length} related links`);
    } catch (e) {
      console.log(`      ❌ Error: ${e.message.slice(0,80)}`);
    }
  }

  console.log(`\n✅ Internal linking done.`);
  console.log(`   Updated: ${updated} | Skipped: ${skipped}`);

  // Notify Discord if ran on all articles (initial setup)
  if (ALL_MODE && updated > 0 && env.DISCORD_WEBHOOK_ALERTAS) {
    await fetch(env.DISCORD_WEBHOOK_ALERTAS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `🔗 **Internal links añadidos**\nActualizados: ${updated} artículos` }),
    }).catch(() => {});
  }
})().catch(e => {
  console.error('❌ ERROR:', e.message);
  process.exit(1);
});
