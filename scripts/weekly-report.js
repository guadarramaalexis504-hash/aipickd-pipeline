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
let notifyReport, calcQualityScore;
try {
  const n = require("./notify.js");
  notifyReport = n.notifyReport;
  calcQualityScore = n.calcQualityScore;
} catch {}
if (!calcQualityScore) calcQualityScore = (w) => Math.min(100, Math.max(0, w >= 2000 ? 90 : w >= 1500 ? 75 : 60));

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
const LAST_WEEK_START = new Date(SINCE.getTime() - 7 * 86400_000); // 2 weeks ago

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
  const sinceISO2 = LAST_WEEK_START.toISOString();
  const [niches, keywords, allArticles, affiliates, wpPosts, lastWeekArticles] = await Promise.all([
    supa("niches"),
    supa("keywords?select=id,status,priority"),
    supa("articles?select=id,title,slug,status,word_count,generation_cost_usd,created_at,wp_post_id,featured_image_url,niche_id,article_type,quality_score,wp_url"),
    supa("affiliates?select=brand,status"),
    wp("posts?per_page=50&status=any&_fields=id,title,status,date,link"),
    // Last week's articles for quality comparison
    supa(`articles?status=eq.published&created_at=gte.${sinceISO2}&created_at=lt.${sinceISO}&select=id,word_count,quality_score,article_type,niche_id`),
  ]);

  const articlesThisWeek = allArticles.filter((a) => new Date(a.created_at) >= SINCE);
  const costThisWeek = articlesThisWeek.reduce((s, a) => s + Number(a.generation_cost_usd || 0), 0);
  const costAllTime = allArticles.reduce((s, a) => s + Number(a.generation_cost_usd || 0), 0);

  // Quality trend: this week vs last week
  const thisWeekPublished = articlesThisWeek.filter(a => a.status === 'published');
  const lastWeekPubl = Array.isArray(lastWeekArticles) ? lastWeekArticles : [];
  const avgQuality = (arr) => {
    const scored = arr.filter(a => a.quality_score > 0);
    return scored.length > 0 ? Math.round(scored.reduce((s, a) => s + a.quality_score, 0) / scored.length) : null;
  };
  const avgWords = (arr) => {
    const withWords = arr.filter(a => a.word_count > 0);
    return withWords.length > 0 ? Math.round(withWords.reduce((s, a) => s + a.word_count, 0) / withWords.length) : 0;
  };
  const thisWeekAvgQuality = avgQuality(thisWeekPublished);
  const lastWeekAvgQuality = avgQuality(lastWeekPubl);
  const thisWeekAvgWords   = avgWords(thisWeekPublished);
  const lastWeekAvgWords   = avgWords(lastWeekPubl);

  // Article type breakdown this week
  const byTypeThisWeek = {};
  for (const a of thisWeekPublished) {
    byTypeThisWeek[a.article_type || 'unknown'] = (byTypeThisWeek[a.article_type || 'unknown'] || 0) + 1;
  }

  // Top articles by word count this week
  const topArticlesThisWeek = thisWeekPublished
    .filter(a => a.word_count > 0 && a.wp_url)
    .sort((a, b) => b.word_count - a.word_count)
    .slice(0, 5)
    .map(a => ({ title: a.title, url: a.wp_url, words: a.word_count }));

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
  const overallAvgWords = Math.round(totalWords / Math.max(1, allArticles.length));

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
| Average word count | ${overallAvgWords} words |
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

## 📈 Quality trend (week over week)

| Metric | This week | Last week | Trend |
|--------|-----------|-----------|-------|
| Articles published | ${thisWeekPublished.length} | ${lastWeekPubl.length} | ${thisWeekPublished.length >= lastWeekPubl.length ? '📈' : '📉'} |
| Avg word count | ${thisWeekAvgWords.toLocaleString()} | ${lastWeekAvgWords.toLocaleString()} | ${thisWeekAvgWords >= lastWeekAvgWords ? '📈' : '📉'} |
| Avg quality score | ${thisWeekAvgQuality ?? 'N/A'} | ${lastWeekAvgQuality ?? 'N/A'} | ${thisWeekAvgQuality && lastWeekAvgQuality ? (thisWeekAvgQuality >= lastWeekAvgQuality ? '📈' : '📉') : '—'} |

## 📋 Article types this week

${Object.entries(byTypeThisWeek).sort((a, b) => b[1] - a[1]).map(([t, c]) => `- **${t}:** ${c}`).join('\n') || '_No articles this week._'}

## 💵 Cost tracking

- **This week:** $${costThisWeek.toFixed(2)} USD on OpenAI API
- **All-time:** $${costAllTime.toFixed(2)} USD
- **Average per article:** $${(costAllTime / Math.max(1, allArticles.length)).toFixed(3)} USD
- **Cost per article this week:** $${thisWeekPublished.length > 0 ? (costThisWeek / thisWeekPublished.length).toFixed(3) : 'N/A'} USD
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

  // Send Discord notification
  if (notifyReport) {
    const siteCheck = await (async () => {
      try {
        const r = await fetch('https://aipickd.com/', { signal: AbortSignal.timeout(8000) });
        return r.ok ? 'up' : 'down';
      } catch { return 'unknown'; }
    })();

    await notifyReport({
      totalArticles: allArticles.length,
      weekArticles: thisWeekPublished.length,
      lastWeekArticles: lastWeekPubl.length,
      monthCost: costAllTime, // approximate
      budget: 50,
      activeAffiliates: affByStatus.active || 0,
      pendingAffiliates: affByStatus.pending || 0,
      siteStatus: siteCheck,
      keywordsInQueue: keywords.filter((k) => k.status === "queued").length,
      publishRate: null,
      avgWordCount: thisWeekAvgWords,
      prevAvgWordCount: lastWeekAvgWords,
      byType: byTypeThisWeek,
      topNiche: Object.entries(byNiche).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      topArticles: topArticlesThisWeek,
    }).catch(e => console.error('Discord notify failed:', e.message));
    console.log('📢 Weekly report sent to Discord #reportes-semanales');
  }
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
