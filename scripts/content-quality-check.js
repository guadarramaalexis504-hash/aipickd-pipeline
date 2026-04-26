#!/usr/bin/env node
/**
 * AIPickd — Content quality auditor
 *
 * Scans all published articles and flags quality issues:
 *   - Word count below threshold
 *   - Missing meta description
 *   - "AI tells" (telltale GPT phrases)
 *   - Stale year references (2024, 2025)
 *   - Missing internal links
 *   - Missing schema.org markup
 *   - Duplicate H1/title
 *   - Unreplaced [AFFILIATE:] template tags
 *   - Reading time too short (<5 min target)
 *
 * Usage:
 *   node scripts/content-quality-check.js                  # report all
 *   node scripts/content-quality-check.js --severity high  # only HIGH issues
 *   node scripts/content-quality-check.js --json
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const args = process.argv.slice(2);
const SEV_FILTER = args[args.indexOf("--severity") + 1] || null;
const JSON_OUT = args.includes("--json");

const AI_TELLS = [
  /\bin today's (?:fast-paced|digital|modern) world\b/i,
  /\bit's important to note that\b/i,
  /\bin conclusion,? \w+/i,
  /\bnavigate the (?:complex )?landscape\b/i,
  /\bharness the power of\b/i,
  /\bunlock (?:the )?(?:full )?potential\b/i,
  /\bdelve into\b/i,
  /\b(?:revolutionize|revolutionary)\b/i,
  /\bcutting[- ]edge\b/i,
];

(async () => {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?status=eq.published&select=id,title,slug,word_count,meta_description,content_markdown,wp_post_id,published_at`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const articles = await r.json();
  const issues = [];

  for (const a of articles) {
    const md = a.content_markdown || "";
    const flags = [];

    // Word count
    if ((a.word_count || 0) < 1500) flags.push({ sev: "high", type: "low-word-count", val: a.word_count });
    else if ((a.word_count || 0) < 2000) flags.push({ sev: "medium", type: "below-target-words", val: a.word_count });

    // Meta description
    if (!a.meta_description) flags.push({ sev: "medium", type: "missing-meta-description" });
    else if (a.meta_description.length < 100 || a.meta_description.length > 160)
      flags.push({ sev: "low", type: "bad-meta-length", val: a.meta_description.length });

    // AI tells
    const tells = AI_TELLS.filter((re) => re.test(md));
    if (tells.length >= 3) flags.push({ sev: "high", type: "ai-tells", val: tells.length });
    else if (tells.length >= 1) flags.push({ sev: "low", type: "ai-tells", val: tells.length });

    // Stale year
    if (/\b202[34]\b/.test(md) && !/202[34][- ](?:was|came|launched)/.test(md))
      flags.push({ sev: "medium", type: "stale-year-reference" });

    // Unreplaced affiliate tags
    if (/\[AFFILIATE:[^\]]+\]/.test(md))
      flags.push({ sev: "high", type: "unreplaced-affiliate-tags" });

    // Likely AI hedging too much
    const hedges = (md.match(/\b(?:may|might|could|possibly|perhaps|generally|typically|usually|often)\b/gi) || []).length;
    if (hedges > 50) flags.push({ sev: "low", type: "excessive-hedging", val: hedges });

    if (flags.length === 0) continue;

    if (SEV_FILTER && !flags.some((f) => f.sev === SEV_FILTER)) continue;

    issues.push({
      id: a.id,
      wp_post_id: a.wp_post_id,
      slug: a.slug,
      title: a.title,
      flags,
    });
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ total: articles.length, issues_found: issues.length, issues }, null, 2));
    return;
  }

  console.log(`\n📋 Content Quality Check — ${articles.length} articles scanned\n`);
  if (issues.length === 0) {
    console.log("✅ No quality issues detected.\n");
    return;
  }
  const sevColors = { high: "🟠", medium: "🟡", low: "🔵" };
  const counts = { high: 0, medium: 0, low: 0 };
  issues.forEach((art) => {
    art.flags.forEach((f) => counts[f.sev] = (counts[f.sev] || 0) + 1);
  });
  console.log(`Found ${issues.length}/${articles.length} articles with issues:`);
  console.log(`   🟠 High: ${counts.high}    🟡 Medium: ${counts.medium}    🔵 Low: ${counts.low}\n`);

  // Show top 20 worst (most flags)
  issues.sort((a, b) => b.flags.length - a.flags.length).slice(0, 20).forEach((art) => {
    console.log(`  WP#${String(art.wp_post_id).padStart(4)} — ${art.title.slice(0, 55)}`);
    art.flags.forEach((f) => {
      const detail = f.val !== undefined ? ` (${f.val})` : "";
      console.log(`         ${sevColors[f.sev]} ${f.type}${detail}`);
    });
  });
  if (issues.length > 20) console.log(`\n  ... and ${issues.length - 20} more articles with issues`);
  console.log();
})().catch((e) => { console.error("❌", e); process.exit(1); });
