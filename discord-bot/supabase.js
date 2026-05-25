#!/usr/bin/env node
/**
 * AIPickd Discord Bot — Supabase queries + writes
 * Provides read AND write tools for the Claude-powered Discord bot
 */

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

async function supaWrite(method, endpoint, body) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase ${method} ${r.status}: ${await r.text()}`);
  if (r.status === 204) return null;
  return r.json();
}

// ── READ functions ────────────────────────────────────────────────────────────

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
    `keywords?status=eq.queued&order=priority.desc,search_volume.desc&limit=${count}&select=keyword,article_type,search_volume,priority`
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

async function getPipelineHealth() {
  const now = new Date();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const [lastPublished, qaFailed, drafts, recentCost] = await Promise.all([
    supa('articles?status=eq.published&order=published_at.desc&limit=1&select=title,published_at'),
    supa('articles?status=eq.qa_failed&select=id,title,word_count'),
    supa('articles?status=eq.draft&select=id'),
    supa(`articles?status=eq.published&published_at=gte.${oneDayAgo}&select=generation_cost_usd`),
  ]);

  const lastPub = lastPublished[0];
  const lastPubTime = lastPub?.published_at ? new Date(lastPub.published_at) : null;
  const hoursSinceLast = lastPubTime
    ? ((now - lastPubTime) / (1000 * 60 * 60)).toFixed(1)
    : 'N/A';
  const isStuck = !lastPubTime || now - lastPubTime > 8 * 60 * 60 * 1000;
  const cost24h = recentCost.reduce((s, a) => s + parseFloat(a.generation_cost_usd || 0), 0);

  return {
    status: isStuck ? '⚠️ POSIBLEMENTE ATASCADO' : '✅ OK',
    last_published_title: lastPub?.title || 'N/A',
    last_published_at: lastPub?.published_at?.slice(0, 16).replace('T', ' ') + ' UTC' || 'N/A',
    hours_since_last_pub: hoursSinceLast,
    qa_failed_count: qaFailed.length,
    qa_failed_articles: qaFailed.slice(0, 5).map((a) => `${a.title} (${a.word_count}w)`),
    drafts_ready_to_publish: drafts.length,
    cost_last_24h_usd: cost24h.toFixed(3),
  };
}

// ── WRITE functions ───────────────────────────────────────────────────────────

/**
 * Pasa todos los artículos qa_failed de vuelta a draft para re-intentar publicarlos.
 */
async function requeueFailedArticles() {
  const failed = await supa('articles?status=eq.qa_failed&select=id,title,word_count');
  if (failed.length === 0) return { requeued: 0, message: 'No hay artículos qa_failed.' };

  // PATCH sin return=representation para evitar body grande
  const r = await fetch(`${SUPA_URL}/rest/v1/articles?status=eq.qa_failed`, {
    method: 'PATCH',
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ status: 'draft' }),
  });
  if (!r.ok) throw new Error(`Supabase PATCH ${r.status}: ${await r.text()}`);

  return {
    requeued: failed.length,
    message: `${failed.length} artículo(s) re-encolados. El próximo cron los publicará.`,
    articles: failed.map((a) => `${a.title} (${a.word_count}w)`),
  };
}

/**
 * Agrega una keyword nueva a la cola de generación.
 */
async function addKeyword(keyword, articleType = 'comparison', searchVolume = 0, priority = 5) {
  const result = await supaWrite('POST', 'keywords', {
    keyword,
    article_type: articleType,
    search_volume: searchVolume,
    priority,
    status: 'queued',
  });
  return {
    added: true,
    keyword,
    type: articleType,
    id: Array.isArray(result) ? result[0]?.id : result?.id,
    message: `Keyword "${keyword}" agregada a la cola con prioridad ${priority}.`,
  };
}

// ── Conversation memory (persistent across reboots) ──────────────────────────

/**
 * Load conversation history for a channel.
 * Returns empty array if no history exists yet (not an error).
 * The shape matches what the Anthropic SDK expects: [{role, content}].
 */
async function loadConversation(channelId) {
  try {
    const rows = await supa(
      `bot_conversations?channel_id=eq.${encodeURIComponent(channelId)}&select=messages`
    );
    return Array.isArray(rows) && rows.length > 0 ? rows[0].messages || [] : [];
  } catch (e) {
    // Table missing or other read error → fall back to empty (don't break the bot)
    console.error('[supabase:loadConversation]', e.message);
    return [];
  }
}

/**
 * Save (upsert) conversation history for a channel.
 * Fire-and-forget — failures are logged but don't block the bot reply.
 */
async function saveConversation(channelId, messages) {
  try {
    const r = await fetch(
      `${SUPA_URL}/rest/v1/bot_conversations?on_conflict=channel_id`,
      {
        method: 'POST',
        headers: {
          apikey: SUPA_KEY,
          Authorization: `Bearer ${SUPA_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ channel_id: channelId, messages }),
      }
    );
    if (!r.ok) {
      console.error('[supabase:saveConversation]', r.status, (await r.text()).slice(0, 200));
    }
  } catch (e) {
    console.error('[supabase:saveConversation]', e.message);
  }
}

/**
 * Drop conversation history for a channel (e.g. /reset slash command).
 */
async function clearConversation(channelId) {
  try {
    const r = await fetch(
      `${SUPA_URL}/rest/v1/bot_conversations?channel_id=eq.${encodeURIComponent(channelId)}`,
      {
        method: 'DELETE',
        headers: {
          apikey: SUPA_KEY,
          Authorization: `Bearer ${SUPA_KEY}`,
          Prefer: 'return=minimal',
        },
      }
    );
    return r.ok;
  } catch (e) {
    console.error('[supabase:clearConversation]', e.message);
    return false;
  }
}

module.exports = {
  // read
  getStats,
  getRecentArticles,
  getMonthlyCost,
  getKeywordsQueue,
  getAffiliates,
  getPipelineHealth,
  // write
  requeueFailedArticles,
  addKeyword,
  // conversation memory
  loadConversation,
  saveConversation,
  clearConversation,
};
