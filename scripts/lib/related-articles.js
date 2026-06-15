"use strict";

// "Related articles" block — appends a curated list of topically-related posts
// to the end of each article. Boosts internal links (more pages crawled →
// impressions), topical authority, and dwell time (lower bounce). Idempotent via
// HTML markers so it can be re-run safely (refreshes the block instead of
// appending a duplicate). Localized: ES → "Artículos relacionados".

const { normalizeLanguage } = require("./spanish-gate");

const MARK_START = "<!-- aipickd-related:start -->";
const MARK_END = "<!-- aipickd-related:end -->";

const STOP = new Set([
  "best", "review", "guide", "tools", "tool", "comparison", "compared", "tested",
  "explained", "alternatives", "alternative", "free", "cheaper", "premium",
  "writing", "video", "image", "coding", "business", "productivity", "small",
  "team", "teams", "creators", "agencies", "2024", "2025", "2026", "para",
  "mejor", "mejores", "herramientas", "herramienta", "gratis", "como", "cual",
  "vs", "the", "for", "and", "with", "without", "your",
]);

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Pick the N most topically-related published articles in the same language.
// Score = token overlap (slug/keyword/title) * 2 + same-niche bonus, tie-broken
// by recency. Excludes the article itself and anything without a public URL.
function pickRelatedArticles(article = {}, all = [], n = 4) {
  const lang = normalizeLanguage(article.language);
  const selfId = article.id;
  const aTokens = new Set([
    ...tokenize(article.slug),
    ...tokenize(article.primary_keyword),
    ...tokenize(article.title),
  ]);
  return (all || [])
    .filter(
      (x) =>
        x &&
        x.id !== selfId &&
        (x.wp_url || x.slug) &&
        normalizeLanguage(x.language) === lang
    )
    .map((x) => {
      const xTokens = new Set([
        ...tokenize(x.slug),
        ...tokenize(x.primary_keyword),
        ...tokenize(x.title),
      ]);
      let overlap = 0;
      for (const t of aTokens) if (xTokens.has(t)) overlap += 1;
      const sameNiche = article.niche_id && x.niche_id === article.niche_id ? 1 : 0;
      return { x, score: overlap * 2 + sameNiche, ts: x.published_at || "" };
    })
    .sort((a, b) => b.score - a.score || (b.ts > a.ts ? 1 : -1))
    .slice(0, n)
    .map((s) => s.x);
}

function buildRelatedBlock(related = [], language = "en") {
  if (!Array.isArray(related) || related.length === 0) return "";
  const heading = normalizeLanguage(language) === "es" ? "Artículos relacionados" : "Related articles";
  const items = related
    .map((r) => {
      const url = r.wp_url || `https://aipickd.com/${r.slug}/`;
      return `<li><a href="${url}">${escapeHtml(r.title)}</a></li>`;
    })
    .join("");
  return `${MARK_START}\n<h2>${heading}</h2>\n<ul>${items}</ul>\n${MARK_END}`;
}

// Idempotent insert: replace an existing related block (refresh) or append a new
// one. Returns { html, changed }.
function injectRelatedBlock(html = "", block = "") {
  const current = String(html || "");
  if (!block) return { html: current, changed: false };
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
  if (re.test(current)) {
    const next = current.replace(re, block);
    return { html: next, changed: next !== current };
  }
  // Another "Related articles" block already exists in a DIFFERENT format (e.g.
  // internal-links.js writes <div class="aipickd-related">…). Don't append a
  // second one — both crons (this + internal-links) touch the same posts.
  if (/aipickd-related/i.test(current)) return { html: current, changed: false };
  return { html: `${current}\n\n${block}`, changed: true };
}

module.exports = {
  MARK_START,
  MARK_END,
  tokenize,
  pickRelatedArticles,
  buildRelatedBlock,
  injectRelatedBlock,
};
