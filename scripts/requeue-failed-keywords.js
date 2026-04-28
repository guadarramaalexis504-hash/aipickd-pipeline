#!/usr/bin/env node
/**
 * AIPickd — Requeue Failed Keywords
 *
 * Finds all qa_failed articles whose keywords can be retried (< 3 previous failures),
 * resets the keyword to "queued" and clears assigned_article_id so the pipeline
 * will regenerate them with improved prompts.
 *
 * Only requeues keywords with FEWER than MAX_ATTEMPTS prior failures.
 *
 * Usage:
 *   node scripts/requeue-failed-keywords.js          # dry-run (shows what would happen)
 *   node scripts/requeue-failed-keywords.js --go     # actually requeue
 */

const fs   = require('fs');
const path = require('path');
const MAX_ATTEMPTS = 3;

const env = {};
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').forEach(l => {
    const m = l.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch {}

const DRY_RUN = !process.argv.includes('--go');

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
  if (!res.ok) throw new Error(`Supabase ${method} ${endpoint}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  console.log(`\n🔄 Requeue Failed Keywords ${DRY_RUN ? '(DRY RUN — pass --go to execute)' : '(LIVE)'}\n`);

  // Get all qa_failed articles
  const qaFailed = await supa('GET', 'articles?status=eq.qa_failed&select=id,title,word_count,keyword_id,created_at');
  if (!qaFailed || qaFailed.length === 0) {
    console.log('   ✅ No qa_failed articles found. Nothing to do.');
    return;
  }

  console.log(`   Found ${qaFailed.length} qa_failed articles\n`);

  let requeued = 0;
  let skipped  = 0;

  for (const article of qaFailed) {
    if (!article.keyword_id) {
      console.log(`   ⏭️  Skip "${(article.title||'').slice(0,50)}" — no keyword_id`);
      skipped++;
      continue;
    }

    // Count how many times this keyword has failed
    const failCount = await supa('GET', `articles?keyword_id=eq.${article.keyword_id}&status=eq.qa_failed&select=id`)
      .then(rows => Array.isArray(rows) ? rows.length : 0)
      .catch(() => 0);

    if (failCount >= MAX_ATTEMPTS) {
      console.log(`   🚫 Skip "${(article.title||'').slice(0,50)}" — ${failCount} failures (max ${MAX_ATTEMPTS})`);
      skipped++;
      continue;
    }

    console.log(`   ✅ Requeue "${(article.title||'').slice(0,55)}" (${article.word_count}w, ${failCount} prior fails)`);

    if (!DRY_RUN) {
      // Reset keyword: status=queued, clear assigned_article_id
      await supa('PATCH', `keywords?id=eq.${article.keyword_id}`, {
        status: 'queued',
        assigned_article_id: null,
      }).catch(e => console.log(`      ⚠️  keyword reset failed: ${e.message.slice(0,60)}`));
    }
    requeued++;
  }

  console.log(`\n   Summary: ${requeued} keywords requeued, ${skipped} skipped`);
  if (DRY_RUN) {
    console.log('\n   Run with --go to apply changes.');
  } else {
    console.log('\n   Done! The pipeline will regenerate these articles on the next run.');
  }
})().catch(e => {
  console.error('❌ Failed:', e.message);
  process.exit(1);
});
