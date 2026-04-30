#!/usr/bin/env node
/**
 * AIPickd — Seasonal Boost Engine
 *
 * Adjusts keyword queue priority based on seasonal trends.
 * Boosts keywords related to seasonal intent in the pipeline.
 *
 * Seasonal windows:
 *   Jan-Feb: "for students", "new year", "productivity"
 *   Mar-Apr: "spring", "launch", "startup"
 *   May-Jun: "summer", "remote work", "freelance"
 *   Jul-Aug: "back to school", "learn", "tutorial"
 *   Sep-Oct: "Q4 planning", "business growth"
 *   Nov-Dec: "Black Friday", "gift", "year-end review"
 *
 * Usage:
 *   node scripts/seasonal-boost.js          # preview boosts
 *   node scripts/seasonal-boost.js --apply  # apply boosts to Supabase
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

const APPLY = process.argv.includes('--apply');

// Seasonal keyword patterns and their boost amounts
const SEASONAL_RULES = [
  // Q1: New Year / Productivity
  { months: [1, 2], patterns: [/new year/i, /resolution/i, /productivity/i, /fresh start/i, /organize/i], boost: 2, label: 'Q1 New Year' },
  // Q2: Spring Launch
  { months: [3, 4, 5], patterns: [/spring/i, /launch/i, /startup/i, /grow your/i, /scale/i], boost: 2, label: 'Q2 Spring' },
  // Q3: Back to School
  { months: [7, 8, 9], patterns: [/school/i, /learn/i, /student/i, /tutorial/i, /beginner/i, /course/i], boost: 2, label: 'Q3 Back to School' },
  // Q4: Black Friday / Holiday
  { months: [10, 11, 12], patterns: [/black friday/i, /deal/i, /discount/i, /gift/i, /holiday/i, /best of \d{4}/i, /year.end/i, /review.*202[67]/i], boost: 3, label: 'Q4 Holiday/BF' },
  // Always boost: high-intent buyer keywords
  { months: [1,2,3,4,5,6,7,8,9,10,11,12], patterns: [/pricing/i, /vs /i, /alternative/i, /review \d{4}/i, /best.*\d{4}/i], boost: 1, label: 'High-intent buyer' },
];

async function supa(method, endpoint, body) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

(async () => {
  const month = new Date().getMonth() + 1; // 1-12
  const monthName = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month];

  console.log(`📅 Seasonal Boost Engine — ${monthName} ${new Date().getFullYear()}\n`);

  // Find active rules for current month
  const activeRules = SEASONAL_RULES.filter(r => r.months.includes(month));
  console.log(`Active rules for ${monthName}: ${activeRules.map(r => r.label).join(', ')}\n`);

  // Fetch queued keywords
  const keywords = await supa('GET', 'keywords?status=eq.queued&select=id,keyword,priority&order=priority.asc');
  if (!Array.isArray(keywords) || keywords.length === 0) {
    console.log('No queued keywords to boost.');
    return;
  }

  // Apply boosts
  const toBoost = [];
  for (const kw of keywords) {
    let maxBoost = 0;
    let matchedRule = null;
    for (const rule of activeRules) {
      if (rule.patterns.some(p => p.test(kw.keyword))) {
        if (rule.boost > maxBoost) {
          maxBoost = rule.boost;
          matchedRule = rule;
        }
      }
    }
    if (maxBoost > 0) {
      toBoost.push({ ...kw, boost: maxBoost, rule: matchedRule.label });
    }
  }

  if (toBoost.length === 0) {
    console.log('No keywords match seasonal patterns this month.');
    return;
  }

  console.log(`Found ${toBoost.length} keywords to boost:\n`);
  toBoost.slice(0, 15).forEach(k => {
    const newPri = Math.min(10, (k.priority || 1) + k.boost);
    console.log(`  ${APPLY ? '✅' : '  '} [${k.rule}] "${k.keyword}" priority: ${k.priority || 1} → ${newPri}`);
  });
  if (toBoost.length > 15) console.log(`  ... and ${toBoost.length - 15} more`);

  if (!APPLY) {
    console.log('\n💡 Run with --apply to update priorities in Supabase.');
    return;
  }

  // Apply priority boosts
  let updated = 0;
  for (const kw of toBoost) {
    const newPriority = Math.min(10, (kw.priority || 1) + kw.boost);
    await supa('PATCH', `keywords?id=eq.${kw.id}`, { priority: newPriority }).catch(() => {});
    updated++;
  }

  console.log(`\n✅ Updated priority for ${updated} keywords.`);
  console.log('💡 High-season keywords will now be processed first by the pipeline.');
})().catch((e) => {
  console.error('❌ Seasonal boost failed:', e.message);
  process.exit(1);
});

/**
 * Export for use in run-pipeline.js (inline seasonal boost check)
 */
module.exports = {
  getSeasonalBoostPattern() {
    const month = new Date().getMonth() + 1;
    const active = SEASONAL_RULES.filter(r => r.months.includes(month));
    return active.flatMap(r => r.patterns);
  },
};
