#!/usr/bin/env node
/**
 * AIPickd — Content Gap Report
 *
 * Identifies keywords in the queue that have no article yet,
 * and topics that are high-volume but unwritten.
 * Also compares article coverage per niche to spot blind spots.
 *
 * Usage:
 *   node scripts/content-gap.js
 *   node scripts/content-gap.js --notify     # also send Discord summary
 *   node scripts/content-gap.js --add-keywords "ai writing tools 2027,ai image generators" # add new keywords
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
const NOTIFY = args.includes('--notify');

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
  console.log('📊 AIPickd Content Gap Report\n');

  const [niches, keywords, articles] = await Promise.all([
    supa('niches?select=id,name,slug'),
    supa('keywords?select=id,keyword,status,priority,search_volume,article_type,niche_id&order=search_volume.desc'),
    supa('articles?status=eq.published&select=id,title,slug,niche_id,article_type,word_count,primary_keyword'),
  ]);

  // Coverage by niche
  const nicheArticles = {};
  const nicheKeywords = {};
  for (const n of niches) {
    nicheArticles[n.id] = articles.filter(a => a.niche_id === n.id);
    nicheKeywords[n.id] = keywords.filter(k => k.niche_id === n.id);
  }

  // High-volume keywords NOT yet processed
  const queued = keywords.filter(k => k.status === 'queued' && k.search_volume > 0);
  const topUnwritten = queued
    .sort((a, b) => (b.search_volume || 0) - (a.search_volume || 0))
    .slice(0, 20);

  // Article types gap
  const publishedTypes = {};
  for (const a of articles) {
    publishedTypes[a.article_type || 'unknown'] = (publishedTypes[a.article_type || 'unknown'] || 0) + 1;
  }
  const queuedTypes = {};
  for (const k of queued) {
    queuedTypes[k.article_type || 'unknown'] = (queuedTypes[k.article_type || 'unknown'] || 0) + 1;
  }

  // Report
  console.log('=== Niche Coverage ===\n');
  for (const n of niches) {
    const arts = nicheArticles[n.id] || [];
    const kws  = nicheKeywords[n.id] || [];
    const queued_kws = kws.filter(k => k.status === 'queued').length;
    const total_kws  = kws.length;
    const coverage = total_kws > 0 ? Math.round((arts.length / total_kws) * 100) : 0;
    const bar = '█'.repeat(Math.min(10, Math.round(coverage / 10))) + '░'.repeat(10 - Math.min(10, Math.round(coverage / 10)));
    console.log(`${n.name.padEnd(25)} ${bar} ${coverage}% (${arts.length} articles / ${total_kws} keywords, ${queued_kws} queued)`);
  }

  console.log('\n=== Top 20 Highest-Volume Unwritten Keywords ===\n');
  topUnwritten.forEach((k, i) => {
    const niche = niches.find(n => n.id === k.niche_id);
    const vol = k.search_volume ? k.search_volume.toLocaleString() : 'N/A';
    console.log(`${(i + 1).toString().padStart(2)}. [${vol.padStart(8)} vol] ${k.keyword.padEnd(55)} [${k.article_type}] ${niche ? `(${niche.name})` : ''}`);
  });

  console.log('\n=== Article Type Coverage ===\n');
  console.log('Published by type:');
  Object.entries(publishedTypes).sort((a, b) => b[1] - a[1]).forEach(([t, c]) => {
    console.log(`  ${t.padEnd(20)} ${c}`);
  });
  console.log('\nQueued by type:');
  Object.entries(queuedTypes).sort((a, b) => b[1] - a[1]).forEach(([t, c]) => {
    console.log(`  ${t.padEnd(20)} ${c}`);
  });

  // Detect niches with no published articles
  const emptyNiches = niches.filter(n => (nicheArticles[n.id] || []).length === 0);
  if (emptyNiches.length > 0) {
    console.log(`\n⚠️ Niches with NO articles: ${emptyNiches.map(n => n.name).join(', ')}`);
  }

  // Save report
  const reportsDir = path.join(__dirname, '..', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);
  const dateStr = new Date().toISOString().slice(0, 10);
  const outPath = path.join(reportsDir, `${dateStr}-content-gap.md`);

  const md = `# Content Gap Report — ${dateStr}

## Niche Coverage

| Niche | Articles | Keywords | Queued | Coverage |
|-------|----------|----------|--------|----------|
${niches.map(n => {
  const arts = (nicheArticles[n.id] || []).length;
  const kws  = (nicheKeywords[n.id] || []).length;
  const q    = (nicheKeywords[n.id] || []).filter(k => k.status === 'queued').length;
  const cov  = kws > 0 ? Math.round((arts / kws) * 100) : 0;
  return `| ${n.name} | ${arts} | ${kws} | ${q} | ${cov}% |`;
}).join('\n')}

## Top 20 Unwritten High-Volume Keywords

| # | Keyword | Search Volume | Type | Niche |
|---|---------|---------------|------|-------|
${topUnwritten.map((k, i) => {
  const n = niches.find(n => n.id === k.niche_id);
  return `| ${i+1} | ${k.keyword} | ${(k.search_volume || 0).toLocaleString()} | ${k.article_type} | ${n ? n.name : '-'} |`;
}).join('\n')}

## Article Type Distribution

| Type | Published | Queued |
|------|-----------|--------|
${Array.from(new Set([...Object.keys(publishedTypes), ...Object.keys(queuedTypes)])).map(t =>
  `| ${t} | ${publishedTypes[t] || 0} | ${queuedTypes[t] || 0} |`
).join('\n')}

---
_Generated ${new Date().toISOString()}_
`;

  fs.writeFileSync(outPath, md);
  console.log(`\n📄 Report saved to: ${outPath}`);

  // Discord notification
  if (NOTIFY) {
    const { notifyAlert } = require('./notify.js');
    const totalQueued = keywords.filter(k => k.status === 'queued').length;
    const topKw = topUnwritten.slice(0, 5).map(k =>
      `• **${k.keyword}** (${(k.search_volume || 0).toLocaleString()} vol)`
    ).join('\n');

    await notifyAlert(
      `📊 **Content Gap Report — ${dateStr}**\n\n` +
      `📚 ${articles.length} artículos publicados\n` +
      `🔑 ${totalQueued} keywords en cola\n\n` +
      `**Top 5 sin escribir (mayor volumen):**\n${topKw}\n\n` +
      `${emptyNiches.length > 0 ? `⚠️ Nichos sin artículos: ${emptyNiches.map(n => n.name).join(', ')}\n\n` : ''}` +
      `📄 [Ver reporte completo en reports/${dateStr}-content-gap.md]`,
      'info'
    ).catch(() => {});
    console.log('📢 Discord notification sent');
  }

  console.log('\nDone!');
})().catch((e) => {
  console.error('❌ Content gap report failed:', e.message);
  process.exit(1);
});
