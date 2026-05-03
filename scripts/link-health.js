#!/usr/bin/env node
/**
 * AIPickd — Link Health Check
 *
 * Checks all external links in published articles for broken links
 * (404s, 5xx, timeouts). Sends a Discord report grouped by article.
 *
 * Usage:
 *   node scripts/link-health.js              # live run
 *   node scripts/link-health.js --dry-run    # report only, no Discord
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const env = {};
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch (e) {
  console.error('❌ .env not found:', envPath);
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_ARTICLES        = 50;
const CONCURRENCY         = 5;
const LINK_TIMEOUT_MS     = 10_000;
const OWN_DOMAIN          = 'aipickd.com';
const SKIP_DOMAINS        = new Set([
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'linkedin.com',
]);

const UA = 'Mozilla/5.0 (compatible; AIPickd-linkcheck/1.0; +https://aipickd.com)';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function supa(endpoint) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`);
  return res.json();
}

/** POST to a Discord webhook. Silently ignores missing webhook. */
async function discord(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (_) {}
}

/** Run async tasks with a fixed concurrency limit. */
async function pLimit(tasks, limit) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** Extract all external href values from raw HTML. */
function extractExternalLinks(html) {
  const links = new Set();
  const re = /href="(https?:\/\/[^"#?\s]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const url  = new URL(m[1]);
      const host = url.hostname.replace(/^www\./, '');
      if (host === OWN_DOMAIN)               continue;
      if (SKIP_DOMAINS.has(host))            continue;
      // Also skip sub-domains of own domain
      if (host.endsWith('.' + OWN_DOMAIN))   continue;
      links.add(m[1]);
    } catch (_) {
      // malformed URL — skip
    }
  }
  return [...links];
}

/**
 * HEAD-check a URL. Returns { url, status, ok, error }.
 * Falls back to GET if HEAD returns 405.
 */
async function checkUrl(url) {
  const attempt = async (method) => {
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
      headers: { 'User-Agent': UA },
      redirect: 'follow',
    });
    return res.status;
  };

  try {
    let status = await attempt('HEAD');
    if (status === 405) {
      // Some servers reject HEAD — try GET
      status = await attempt('GET');
    }
    const ok = status >= 200 && status < 400;
    return { url, status, ok };
  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || e.message.includes('timeout');
    return { url, status: 0, ok: false, error: isTimeout ? 'timeout' : e.message.slice(0, 80) };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('🔗 AIPickd Link Health Check');
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'live'}\n`);

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }
  if (!env.WP_USERNAME || !env.WP_ADMIN_PASSWORD) {
    console.error('❌ Missing WP_USERNAME or WP_ADMIN_PASSWORD in .env');
    process.exit(1);
  }

  // 1. Fetch published articles from Supabase
  console.log(`Fetching up to ${MAX_ARTICLES} published articles from Supabase…`);
  const articles = await supa(
    `articles?status=eq.published&select=id,title,wp_post_id,wp_url&order=published_at.desc&limit=${MAX_ARTICLES}`
  );

  if (!Array.isArray(articles) || articles.length === 0) {
    console.log('⚠️  No published articles found.');
    return;
  }
  console.log(`Found ${articles.length} articles.\n`);

  const wpAuth  = Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString('base64');
  const wpBase  = 'https://aipickd.com/wp-json/wp/v2/posts';

  // 2. Fetch HTML from WordPress and extract links
  // Collect: { articleTitle, articleUrl, links: string[] }
  const articleLinks = [];
  const allUniqueLinks = new Map(); // url → Set of article titles

  for (const article of articles) {
    if (!article.wp_post_id) continue;
    try {
      const res = await fetch(`${wpBase}/${article.wp_post_id}?context=edit`, {
        headers: {
          Authorization: `Basic ${wpAuth}`,
          'User-Agent': UA,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.log(`  ⚠️  WP API ${res.status} for post ${article.wp_post_id} — skipping`);
        continue;
      }
      const post    = await res.json();
      const rawHtml = (post?.content?.raw || post?.content?.rendered || '');
      const links   = extractExternalLinks(rawHtml);

      if (links.length > 0) {
        articleLinks.push({ title: article.title, url: article.wp_url, links });
        links.forEach((l) => {
          if (!allUniqueLinks.has(l)) allUniqueLinks.set(l, new Set());
          allUniqueLinks.get(l).add(article.title);
        });
      }
    } catch (e) {
      console.log(`  ⚠️  Error fetching WP post ${article.wp_post_id}: ${e.message.slice(0, 80)}`);
    }
  }

  const uniqueUrls = [...allUniqueLinks.keys()];
  console.log(`Found ${uniqueUrls.length} unique external links across ${articleLinks.length} articles.`);
  console.log(`Checking links with concurrency=${CONCURRENCY}, timeout=${LINK_TIMEOUT_MS / 1000}s…\n`);

  if (uniqueUrls.length === 0) {
    console.log('No external links to check.');
    return;
  }

  // 3. Check all unique URLs with concurrency limit
  const tasks = uniqueUrls.map((url) => () => checkUrl(url));
  const results = await pLimit(tasks, CONCURRENCY);

  // Build a map: url → result
  const resultMap = new Map(results.map((r) => [r.url, r]));

  // 4. Collect broken links grouped by article
  const broken404    = [];
  const broken5xx    = [];
  const brokenErrors = [];

  for (const { title, url: articleUrl, links } of articleLinks) {
    for (const link of links) {
      const r = resultMap.get(link);
      if (!r || r.ok) continue;

      const entry = { articleTitle: title, articleUrl, link, status: r.status, error: r.error };

      if (r.status === 404) {
        broken404.push(entry);
      } else if (r.status >= 500) {
        broken5xx.push(entry);
      } else {
        brokenErrors.push(entry);
      }
    }
  }

  const totalBroken = broken404.length + broken5xx.length + brokenErrors.length;
  const totalChecked = uniqueUrls.length;

  // Console summary
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Total links checked : ${totalChecked}`);
  console.log(`  Healthy             : ${totalChecked - totalBroken}`);
  console.log(`  404 Not Found       : ${broken404.length}`);
  console.log(`  5xx Server errors   : ${broken5xx.length}`);
  console.log(`  Timeouts / errors   : ${brokenErrors.length}`);
  console.log('═══════════════════════════════════════════════════════\n');

  if (broken404.length > 0) {
    console.log('🔴 404s:');
    broken404.forEach((e) => console.log(`   [${e.articleTitle.slice(0, 40)}] ${e.link}`));
  }
  if (broken5xx.length > 0) {
    console.log('\n🟠 5xx errors:');
    broken5xx.forEach((e) => console.log(`   [${e.articleTitle.slice(0, 40)}] HTTP ${e.status} — ${e.link}`));
  }
  if (brokenErrors.length > 0) {
    console.log('\n⚡ Timeouts / connection errors:');
    brokenErrors.forEach((e) => console.log(`   [${e.articleTitle.slice(0, 40)}] ${e.error} — ${e.link}`));
  }

  if (totalBroken === 0) {
    console.log('✅ All external links are healthy!');
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] Discord report skipped.');
    return;
  }

  if (!env.DISCORD_WEBHOOK_ALERTAS) {
    console.log('\n⚠️  DISCORD_WEBHOOK_ALERTAS not set — skipping Discord report.');
    return;
  }

  // 5. Build Discord report
  if (totalBroken === 0) {
    await discord(env.DISCORD_WEBHOOK_ALERTAS, {
      username: 'AIPickd Alert 🚨',
      embeds: [{
        title: '🔗 Link Health — ✅ All Clear',
        description: `Checked **${totalChecked}** external links across **${articleLinks.length}** articles.\nNo broken links found.`,
        color: 0x00cc66,
        footer: { text: 'aipickd.com • link-health.js' },
        timestamp: new Date().toISOString(),
      }],
    });
    console.log('\n✅ Discord all-clear sent.');
    return;
  }

  // Group broken links by article title for the report
  const byArticle = new Map();
  const addToGroup = (entry, label) => {
    const key = entry.articleTitle;
    if (!byArticle.has(key)) byArticle.set(key, { articleUrl: entry.articleUrl, issues: [] });
    byArticle.get(key).issues.push({ label, link: entry.link });
  };

  broken404.forEach((e)    => addToGroup(e, `🔴 404`));
  broken5xx.forEach((e)    => addToGroup(e, `🟠 ${e.status}`));
  brokenErrors.forEach((e) => addToGroup(e, `⚡ ${e.error || 'error'}`));

  // Discord has a 4096-char description limit; build fields per article
  const fields = [];
  let articleCount = 0;
  for (const [title, data] of byArticle) {
    if (articleCount >= 20) break; // Discord max 25 fields
    const issueLines = data.issues.slice(0, 5).map((i) => `${i.label}: \`${i.link.slice(0, 80)}\``).join('\n');
    const extra = data.issues.length > 5 ? `\n…+${data.issues.length - 5} more` : '';
    fields.push({
      name: title.slice(0, 256),
      value: (issueLines + extra).slice(0, 1024),
      inline: false,
    });
    articleCount++;
  }

  const remaining = byArticle.size - articleCount;

  await discord(env.DISCORD_WEBHOOK_ALERTAS, {
    username: 'AIPickd Alert 🚨',
    embeds: [{
      title: `🔗 Link Health — ${totalBroken} broken link${totalBroken !== 1 ? 's' : ''} found`,
      description:
        `Checked **${totalChecked}** links across **${articleLinks.length}** articles.\n\n` +
        `🔴 404s: **${broken404.length}** | 🟠 5xx: **${broken5xx.length}** | ⚡ Errors: **${brokenErrors.length}**` +
        (remaining > 0 ? `\n\n_+${remaining} more articles not shown_` : ''),
      color: broken404.length > 0 ? 0xff0000 : broken5xx.length > 0 ? 0xff6600 : 0xff9900,
      fields,
      footer: { text: 'aipickd.com • link-health.js' },
      timestamp: new Date().toISOString(),
    }],
  });

  console.log(`\n🔔 Discord report sent (${totalBroken} broken links in ${byArticle.size} articles).`);
})().catch((e) => {
  console.error('❌ link-health.js failed:', e.message);
  process.exit(1);
});
