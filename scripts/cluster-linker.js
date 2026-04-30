#!/usr/bin/env node
/**
 * AIPickd — Topic Cluster Linker
 *
 * Detects when you have 5+ articles on the same topic (niche + article type)
 * and suggests a hub article (pillar page) + internal linking strategy.
 * Alerts Discord with the cluster analysis.
 *
 * Usage:
 *   node scripts/cluster-linker.js
 *   node scripts/cluster-linker.js --threshold 5    # min articles to form a cluster
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

const args = process.argv.slice(2);
const threshIdx = args.indexOf('--threshold');
const MIN_CLUSTER = threshIdx >= 0 ? parseInt(args[threshIdx + 1]) : 5;

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

(async () => {
  console.log(`🔗 AIPickd Topic Cluster Linker (min ${MIN_CLUSTER} articles/cluster)\n`);

  const [articles, niches] = await Promise.all([
    supa('articles?status=eq.published&select=id,title,slug,wp_url,niche_id,article_type,word_count,primary_keyword,published_at&order=published_at.desc&limit=200'),
    supa('niches?select=id,name,slug'),
  ]);

  // Group by niche
  const clusters = {};
  for (const a of (articles || [])) {
    const niche = niches.find(n => n.id === a.niche_id);
    const key = niche?.slug || 'unknown';
    if (!clusters[key]) clusters[key] = { niche, articles: [] };
    clusters[key].articles.push(a);
  }

  // Find clusters with enough articles
  const activeClusters = Object.entries(clusters)
    .filter(([, c]) => c.articles.length >= MIN_CLUSTER)
    .sort((a, b) => b[1].articles.length - a[1].articles.length);

  console.log(`Found ${activeClusters.length} clusters with ${MIN_CLUSTER}+ articles:\n`);

  const alerts = [];
  for (const [nicheSlug, cluster] of activeClusters) {
    const { niche, articles: clusterArts } = cluster;
    const name = niche?.name || nicheSlug;
    console.log(`\n📦 Cluster: ${name} (${clusterArts.length} articles)`);

    // Find potential hub article (highest word count or most general title)
    const hub = clusterArts.sort((a, b) => (b.word_count || 0) - (a.word_count || 0))[0];
    const spokes = clusterArts.filter(a => a.id !== hub.id).slice(0, 5);

    console.log(`   🏠 Hub (pillar): "${hub.title}" (${hub.word_count || 0}w)`);
    spokes.forEach(s => console.log(`   🔗 Spoke: "${s.title}" → should link to hub`));

    // Check for missing pillar page (broad "best X" or "what is X" covering the whole niche)
    const hasPillar = clusterArts.some(a =>
      /^(?:best|top \d+|what is|guide to|complete guide)/i.test(a.title || '') && a.word_count >= 2500
    );

    if (!hasPillar) {
      console.log(`   ⚠️ Missing pillar page! Consider writing "Best [${name}] Tools 2026"`);
      alerts.push({
        niche: name,
        count: clusterArts.length,
        hub: hub.title,
        hasPillar: false,
        hubUrl: hub.wp_url,
      });
    }
  }

  // Send Discord alert for clusters missing pillar pages
  if (alerts.length > 0) {
    const { notifyAlert } = require('./notify.js');
    const lines = alerts.slice(0, 5).map(a =>
      `• **${a.niche}** — ${a.count} artículos pero sin pillar page\n  Hub actual: [${a.hub.slice(0, 50)}](${a.hubUrl || '#'})`
    ).join('\n\n');

    await notifyAlert(
      `🔗 **Topic Clusters sin pillar page**\n\n${lines}\n\n💡 Una pillar page por cluster mejora el authority interno y el ranking.\nEjemplo: "Best AI Writing Tools 2026 — Ultimate Guide"`,
      'info'
    ).catch(() => {});
    console.log('\n📢 Cluster alert sent to Discord');
  }

  // Summary
  console.log(`\n\n=== Cluster Summary ===`);
  console.log(`Total clusters: ${activeClusters.length}`);
  console.log(`Missing pillar pages: ${alerts.length}`);
  if (activeClusters.length > 0) {
    const biggest = activeClusters[0];
    console.log(`Biggest cluster: ${biggest[0]} (${biggest[1].articles.length} articles)`);
  }

  console.log('\n✅ Done!');
})().catch((e) => {
  console.error('❌ Cluster linker failed:', e.message);
  process.exit(1);
});
