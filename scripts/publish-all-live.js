#!/usr/bin/env node
/**
 * Flip all WP draft posts to PUBLISHED (live).
 * Run this when you're ready to go live with the content.
 *
 * Usage:
 *   node scripts/publish-all-live.js              # preview (dry run)
 *   node scripts/publish-all-live.js --go         # actually publish
 *   node scripts/publish-all-live.js --go --drip  # schedule them to publish every 6h (drip mode)
 */

const { supa, wp } = require("./lib/clients");

const args = process.argv.slice(2);
const DRY = !args.includes("--go");
const DRIP = args.includes("--drip");

(async () => {
  console.log(`== publish-all-live ${DRY ? "(DRY RUN)" : "(LIVE)"} ${DRIP ? "[DRIP MODE]" : ""} ==\n`);

  const drafts = await wp("GET", "posts?status=draft&per_page=100&_fields=id,title,slug");
  console.log(`Found ${drafts.length} draft posts.\n`);

  if (drafts.length === 0) {
    console.log("Nothing to publish.");
    return;
  }

  // Drip mode: schedule each post 6 hours apart starting now
  const intervalMs = DRIP ? 6 * 60 * 60 * 1000 : 0;
  let scheduled = 0;

  for (const [i, post] of drafts.entries()) {
    const targetDate = DRIP
      ? new Date(Date.now() + i * intervalMs).toISOString()
      : null;

    const action = DRIP
      ? `schedule for ${targetDate?.slice(0, 16)}`
      : "publish NOW";

    console.log(`  ${DRY ? "[dry]" : "✓"} ${action}: #${post.id} ${post.title.rendered.slice(0, 60)}`);

    if (!DRY) {
      const body = DRIP
        ? { status: "future", date: targetDate }
        : { status: "publish" };
      await wp("POST", `posts/${post.id}`, body);
      // Update Supabase too
      await supa("PATCH", `articles?wp_post_id=eq.${post.id}`, {
        status: "published",
        published_at: DRIP ? targetDate : new Date().toISOString(),
      });
      scheduled++;
    }
  }

  if (DRY) {
    console.log(`\n✅ DRY RUN complete. ${drafts.length} posts would be ${DRIP ? "scheduled" : "published"}.`);
    console.log(`   Run with --go to actually ${DRIP ? "schedule" : "publish"}.`);
  } else {
    console.log(`\n✅ ${DRIP ? "Scheduled" : "Published"} ${scheduled} posts.`);
    if (DRIP) {
      console.log(`   Each 6h apart. First: NOW, Last: ${new Date(Date.now() + (drafts.length - 1) * intervalMs).toLocaleString()}`);
    }
  }
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
