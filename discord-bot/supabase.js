#!/usr/bin/env node
/**
 * AIPickd Discord Bot — Supabase queries
 * Provides data tools for the Claude-powered Discord bot
 */

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supa(endpoint) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${endpoint}`, {
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

async function getStats() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  const [total, monthly, todayArts, pending] = await Promise.all([
    supa('articles?status=eq.published&select=id'),
    supa(`articles?status=eq.published&published_at=gte.${monthStart}&select=id,generation_cost_usd`),
    supa(`articles?status=eq.published&published_at=gte.${today}&select=id,title`),
    supa('keywords?status=eq.queued&select=id'),
  ]);

  const monthCost = monthly.reduce((s, a) => s + parseFloat(a.generation_cost_usd || 0), 0);
  const daysIn = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projected = daysIn > 0 ? (monthCost / daysIn) * daysInMonth : monthCost;

  return {
    total_articles_published: total.length,
    articles_this_month: monthly.length,
    articles_today: todayArts.length,
    today_titles: todayArts.map((a) => a.title).slice(0, 5),
    cost_this_month_usd: monthCost.toFixed(3),
    projected_month_usd: projected.toFixed(2),
    budget_usd: '50.00',
    budget_pct_used: ((monthCost / 50) * 100).toFixed(1) + '%',
    keywords_in_queue: pending.length,
  };
}

async function getRecentArticles(count = 5) {
  const articles = await supa(
    `articles?status=eq.published&order=published_at.desc&limit=${count}&select=title,wp_url,article_type,primary_keyword,published_at,word_count,quality_score`
  );
  return articles.map((a) => ({
    title: a.title,
    type: a.article_type,
    keyword: a.primary_keyword,
    url: a.wp_url,
    words: a.word_count,
    quality: a.quality_score,
    published: a.published_at?.slice(0, 10),
  }));
}

async function getMonthlyCost() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const articles = await supa(
    `articles?published_at=gte.${monthStart}&select=generation_cost_usd,title,published_at`
  );
  const total = articles.reduce((s, a) => s + parseFloat(a.generation_cost_usd || 0), 0);
  const withCost = articles.filter((a) => parseFloat(a.generation_cost_usd) > 0);
  const avgCost = withCost.length > 0 ? total / withCost.length : 0;
  const daysIn = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projected = daysIn > 0 ? (total / daysIn) * daysInMonth : total;
  return {
    spent_usd: total.toFixed(3),
    avg_cost_per_article_usd: avgCost.toFixed(3),
    projected_month_usd: projected.toFixed(2),
    budget_usd: '50.00',
    pct_used: ((total / 50) * 100).toFixed(1) + '%',
    articles_counted: withCost.length,
  };
}

async function getKeywordsQueue(count = 10) {
  const kws = await supa(
    `keywords?status=eq.pending&order=priority.desc,search_volume.desc&limit=${count}&select=keyword,article_type,search_volume,priority,niche_id`
  );
  return kws.map((k) => ({
    keyword: k.keyword,
    type: k.article_type,
    volume: k.search_volume,
    priority: k.priority,
  }));
}

async function getAffiliates() {
  const affiliates = await supa(
    'affiliates?select=brand,status,commission_type,commission_amount,commission_percentage,created_at&order=created_at.desc'
  );
  const byStatus = {};
  for (const a of affiliates) {
    if (!byStatus[a.status]) byStatus[a.status] = [];
    const commission = a.commission_type === 'percentage'
      ? `${a.commission_percentage}%`
      : `$${a.commission_amount}`;
    byStatus[a.status].push(`${a.brand} (${commission})`);
  }
  return { total: affiliates.length, by_status: byStatus };
}

module.exports = { getStats, getRecentArticles, getMonthlyCost, getKeywordsQueue, getAffiliates };
