#!/usr/bin/env node
/**
 * AIPickd — Weekly report generator
 *
 * Generates a human-readable weekly summary of the business state.
 * Writes to `reports/YYYY-MM-DD-weekly.md` AND prints to console.
 * Can be wired to Windows Task Scheduler every Monday to run automatically.
 *
 * Usage:
 *   node scripts/weekly-report.js
 *   node scripts/weekly-report.js --since "2026-04-14"    # custom start date
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WP_USERNAME, WP_ADMIN_PASSWORD } = env;
const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");

const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const SINCE = sinceIdx >= 0 ? new Date(args[sinceIdx + 1]) : new Date(Date.now() - 7 * 86400_000);

async function supa(endpoint) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supa: ${res.status}`);
  return await res.json();
}

async function wp(endpoint) {
  try {
    const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    return await res.json();
  } catch {
    return null;
  }
}

(async () => {
  console.log("Generating weekly report...\n");

  const now = new Date();
  const sinceISO = SINCE.toISOString();

  // Gather data
  const [niches, keywords, allArticles, affiliates, wpPosts] = await Promise.all([
    supa("niches"),
    supa("keywords?select=id,status,priority"),
    supa("articles?select=id,title,slug,status,word_count,generation_cost_usd,created_at,wp_post_id,featured_image_url,niche_id"),
    supa("affiliates?select=brand,status"),
    wp("posts?per_page=50&status=any&_fields=id,title,status,date,link"),
  ]);

  const articlesThisWeek = allArticles.filter((a) => new Date(a.created_at) >= SINCE);
  const costThisWeek = articlesThisWeek.reduce((s, a) => s + Number(a.generation_cost_usd || 0), 0);
  const costAllTime = allArticles.reduce((s, a) => s + Number(a.generation_cost_usd || 0), 0);

  const livePosts = wpPosts?.filter((p) => p.status === "publish") || [];
  const draftPosts = wpPosts?.filter((p) => p.status === "draft") || [];
  const publishedThisWeek = livePosts.filter((p) => new Date(p.date) >= SINCE);

  const byNiche = {};
  for (const a of allArticles) {
    const slug = niches.find((n) => n.id === a.niche_id)?.slug || "unknown";
    byNiche[slug] = (byNiche[slug] || 0) + 1;
  }

  const withImages = allArticles.filter((a) => a.featured_image_url).length;

  const affByStatus = {};
  for (const a of affiliates) affByStatus[a.status] = (affByStatus[a.status] || 0) + 1;

  const totalWords = allArticles.reduce((s, a) => s + (a.word_count || 0), 0);
  const avgWords = Math.round(totalWords / Math.max(1, allArticles.length));

  // Build report
  const dateStr = now.toISOString().slice(0, 10);
  const fmtDate = (d) => new Date(d).toISOString().slice(0, 10);

  const md = `# 📊 AIPickd Weekly Report — ${dateStr}

**Period:** ${fmtDate(SINCE)} → ${fmtDate(now)}
**Site:** https://aipickd.com

---

## 🎯 Executive summary

- **Live articles:** ${livePosts.length} (${publishedThisWeek.length} new this week)
- **Draft articles:** ${draftPosts.length} awaiting your review
- **Articles generated this week:** ${articlesThisWeek.length}
- **AI spend this week:** $${costThisWeek.toFixed(2)} USD (all-time: $${costAllTime.toFixed(2)})
- **Active affiliates:** ${affByStatus.active || 0} / ${affiliates.length}

## 📈 Content growth

| Metric | Value |
|--------|-------|
| Total articles | ${allArticles.length} |
| Average word count | ${avgWords} words |
| Total words written | ${totalWords.toLocaleString()} |
| Articles with featured images | ${withImages}/${allArticles.length} |
| Keywords remaining in queue | ${keywords.filter((k) => k.status === "queued").length} |
| Keywords already used | ${keywords.filter((k) => k.status === "published").length} |

## 📊 Content by niche

${niches.map((n) => `- **${n.name}:** ${byNiche[n.slug] || 0} articles`).join("\n")}

## 💰 Affiliate status

| Status | Count |
|--------|-------|
| Active | ${affByStatus.active || 0} |
| Pending | ${affByStatus.pending || 0} |
| Total in DB | ${affiliates.length} |

${(affByStatus.active || 0) === 0
  ? "> ⚠️ **No active affiliates yet.** Apply to Amazon Associates, Impact.com, and PartnerStack to start earning. See `docs/afiliados-guia-completa.md`."
  : `> ✅ ${affByStatus.active} affiliates active. New articles will include their links automatically.`}

## 🚀 Published this week

${publishedThisWeek.length === 0
  ? "_No articles published this week._"
  : publishedThisWeek.slice(0, 10).map((p) => `- [${p.title.rendered.replace(/&#\d+;/g, (c) => String.fromCharCode(parseInt(c.slice(2, -1))))}](${p.link})`).join("\n")}

## 📝 Drafts awaiting review (top 10)

${draftPosts.slice(0, 10).map((p) => `- #${p.id} — ${p.title.rendered.replace(/&#\d+;/g, (c) => String.fromCharCode(parseInt(c.slice(2, -1))))}`).join("\n") || "_No drafts._"}

## 💵 Cost tracking

- **This week:** $${costThisWeek.toFixed(2)} USD on OpenAI API
- **All-time:** $${costAllTime.toFixed(2)} USD
- **Average per article:** $${(costAllTime / Math.max(1, allArticles.length)).toFixed(3)} USD
- **Daily budget limit:** $10.00 USD (from .env)

## ✅ Recommended actions for next week

${(affByStatus.active || 0) === 0 ? "- 🔴 **URGENT:** Apply to at least 1 affiliate program. Without this, no revenue.\n" : ""}${draftPosts.length > 10 ? `- 📋 Review and publish the ${draftPosts.length} drafts (or flip to auto-publish in .env)\n` : ""}${withImages < allArticles.length ? `- 🎨 ${allArticles.length - withImages} articles still need featured images — run \`node scripts/add-featured-images.js\`\n` : ""}${keywords.filter((k) => k.status === "queued").length < 30 ? "- 🔑 Only <30 keywords queued. Add more to the pool.\n" : ""}

---

_Auto-generated by \`scripts/weekly-report.js\` on ${now.toISOString()}_
`;

  // Write to file
  const reportsDir = path.join(__dirname, "..", "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);
  const outPath = path.join(reportsDir, `${dateStr}-weekly.md`);
  fs.writeFileSync(outPath, md);

  console.log(md);
  console.log(`\n📄 Saved to: ${outPath}`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
