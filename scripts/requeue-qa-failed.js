#!/usr/bin/env node
/**
 * AIPickd — Re-queue articles that failed QA recently
 *
 * Strategy: for every article with `status=qa_failed` newer than --hours hours,
 *   - look up its keyword
 *   - delete (or archive) the failed article
 *   - reset the keyword to `queued`
 *
 * The next pipeline run will pick it up and try again with the latest prompt
 * + model. This is useful after a prompt fix: instead of waiting for the
 * next discovery batch, you can recycle 1-2 days of failures in one shot.
 *
 * Usage:
 *   node scripts/requeue-qa-failed.js                # dry-run, last 48h
 *   node scripts/requeue-qa-failed.js --hours 72     # last 72h
 *   node scripts/requeue-qa-failed.js --go           # actually do it
 *   node scripts/requeue-qa-failed.js --hours 24 --go
 */

const { loadEnv } = require("./lib/env");

const env = loadEnv();
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const args = process.argv.slice(2);
const HOURS = parseInt(args[args.indexOf("--hours") + 1]) || 48;
const GO = args.includes("--go");

const HEADERS = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function supa(method, endpoint, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Supabase ${method} ${endpoint}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

(async () => {
  const cutoff = new Date(Date.now() - HOURS * 3600000).toISOString();
  const failed = await supa(
    "GET",
    `articles?status=eq.qa_failed&created_at=gte.${cutoff}&select=id,title,keyword_id,created_at&order=created_at.desc`
  );

  console.log(`Found ${failed.length} qa_failed article(s) in the last ${HOURS}h`);
  if (failed.length === 0) {
    console.log("Nothing to re-queue.");
    return;
  }

  for (const a of failed) {
    console.log(`  - ${a.created_at?.slice(0, 16)} | ${a.title?.slice(0, 70)}`);
  }

  if (!GO) {
    console.log(`\nDry-run. Pass --go to actually re-queue these ${failed.length} article(s).`);
    return;
  }

  let requeued = 0;
  for (const a of failed) {
    try {
      // Reset the keyword to queued (so the next run picks it up)
      if (a.keyword_id) {
        await supa("PATCH", `keywords?id=eq.${a.keyword_id}`, {
          status: "queued",
          assigned_article_id: null,
        });
      }
      // Archive the qa_failed article so we keep history but it's out of the queue
      await supa("PATCH", `articles?id=eq.${a.id}`, { status: "archived" });
      requeued++;
      console.log(`  ✅ re-queued: ${a.title?.slice(0, 60)}`);
    } catch (e) {
      console.error(`  ❌ failed for ${a.id}: ${e.message?.slice(0, 150)}`);
    }
  }

  console.log(`\nDone. Re-queued ${requeued} of ${failed.length} qa_failed article(s).`);
})().catch((e) => {
  console.error("\n❌ FATAL:", e.message);
  process.exit(1);
});
