"use strict";
/**
 * AIPickd — Shared Schema.org JSON-LD builder
 * ------------------------------------------------------------------
 * Single source of truth for structured data across the pipeline.
 * Used by:
 *   - run-pipeline.js      (new articles, at publish time)
 *   - add-schema-markup.js (backfill / upgrade existing articles)
 *
 * Rich-result families emitted (Google picks whichever fits the SERP):
 *   - Article / Review   (always — Review only for single-product reviews)
 *   - BreadcrumbList     (always when a URL is known → cleaner SERP path)
 *   - ItemList           (listicles, comparisons, "best/top N", alternatives)
 *   - HowTo              (how-to articles — ONLY when ≥2 real steps parsed)
 *   - FAQPage            (any article with ≥3 Q&A pairs in a FAQ section)
 *
 * Design notes:
 *   - Ratings are DERIVED from the internal quality_score (70–95 → 4.0–4.8)
 *     instead of a hardcoded 4.3, so honest variation reaches the SERP and
 *     Google doesn't see suspiciously uniform stars.
 *   - HowTo steps are parsed from real "Step N" / "N." headings. If we can't
 *     find ≥2, we emit NO HowTo (an empty step[] is invalid and wasteful).
 *   - Comparisons get Article + ItemList (NOT Review) — a single rating can't
 *     honestly represent two products being compared.
 */

const SITE = "https://aipickd.com";
const ORG_NAME = "AIPickd";
const LOGO = {
  "@type": "ImageObject",
  url: `${SITE}/wp-content/uploads/aipickd-logo.png`,
  width: 600,
  height: 60,
};
const DEFAULT_IMG = `${SITE}/wp-content/uploads/aipickd-og.png`;

// WP category slug → display name (mirrors the live taxonomy)
const CATEGORY_NAMES = {
  "ai-writing": "AI Writing",
  "ai-business": "AI Business & Productivity",
  "ai-coding": "AI Coding",
  "ai-image-video": "AI Image & Video",
  "ai-infrastructure": "AI Infrastructure & Hosting",
};

// niche slug (Supabase) → WP category slug (one differs: hosting→infrastructure)
const NICHE_TO_CATEGORY_SLUG = {
  "ai-writing": "ai-writing",
  "ai-business": "ai-business",
  "ai-image-video": "ai-image-video",
  "ai-coding": "ai-coding",
  "ai-hosting": "ai-infrastructure",
};

// ──────────────────────────────────────────────────────────────────
// Extractors
// ──────────────────────────────────────────────────────────────────

/** Extract Q&A pairs from a "## FAQ" section. Returns [{q, a}], capped at 8. */
function extractFAQs(md) {
  if (!md) return [];
  const faqMatch = md.match(/^##\s+(?:FAQ|Frequently Asked Questions|Common Questions|FAQs).*$/im);
  if (!faqMatch) return [];
  const start = md.indexOf(faqMatch[0]) + faqMatch[0].length;
  const rest = md.slice(start);
  const endMatch = rest.match(/^##\s+/m);
  const faqBlock = endMatch ? rest.slice(0, rest.indexOf(endMatch[0])) : rest;

  const qas = [];
  const headingPattern = /^###\s+(.+?)\n([\s\S]*?)(?=^###\s+|$)/gm;
  let m;
  while ((m = headingPattern.exec(faqBlock)) !== null) {
    const q = m[1].trim().replace(/^\*\*|\*\*$/g, "").replace(/^Q:\s*/i, "");
    const a = m[2].trim().replace(/^\*\*A:\*\*\s*/i, "").replace(/^A:\s*/i, "");
    if (q && a && q.length < 200 && a.length > 20) {
      qas.push({ q, a: a.slice(0, 600) });
    }
  }
  return qas.slice(0, 8);
}

/**
 * Extract ordered HowTo steps from markdown.
 * Only matches headings that are explicitly numbered ("## Step 1: X",
 * "### 2. X", "## 3) X") so we never fabricate a procedure that isn't there.
 * Returns [{name, text}], capped at 12. Caller should require >= 2.
 */
function extractHowToSteps(md) {
  if (!md) return [];

  // Collect every H2–H4 heading with its position
  const headingRe = /^#{2,4}\s+(.+?)\s*$/gm;
  const heads = [];
  let h;
  while ((h = headingRe.exec(md)) !== null) {
    heads.push({ text: h[1].replace(/\*\*/g, "").trim(), bodyStart: headingRe.lastIndex, index: h.index });
  }

  // Require the explicit word "Step N" — bare "1." headings are ambiguous
  // (often ranked tool lists, e.g. "1. Synthesia") and would pollute the
  // procedure. Strictness is correct here: emit HowTo only when certain.
  const stepLabelRe = /^step\s*\d+\s*[:.)\-–—]?\s+(.+)$/i;
  const steps = [];
  for (let i = 0; i < heads.length; i++) {
    const labelMatch = heads[i].text.match(stepLabelRe);
    if (!labelMatch) continue;
    const name = labelMatch[1].trim();
    if (!name) continue;

    const bodyEnd = i + 1 < heads.length ? heads[i + 1].index : md.length;
    const text = md
      .slice(heads[i].bodyStart, bodyEnd)
      .replace(/```[\s\S]*?```/g, " ")        // strip code fences
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")   // strip images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → link text
      .replace(/[#*_`>]/g, "")                  // strip md punctuation
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 320);

    steps.push({ name: name.slice(0, 110), text: text || name });
  }
  return steps.slice(0, 12);
}

// ──────────────────────────────────────────────────────────────────
// Builders
// ──────────────────────────────────────────────────────────────────

/** quality_score (70–95) → believable editorial rating (4.0–4.8). */
function deriveRating(qualityScore) {
  // Number(null) === 0 (not NaN), so guard nullish/empty explicitly.
  if (qualityScore === null || qualityScore === undefined || qualityScore === "") return 4.4;
  const q = Number(qualityScore);
  if (!Number.isFinite(q)) return 4.4; // sensible default when score is null
  const clamped = Math.max(70, Math.min(95, q));
  const rating = 4.0 + ((clamped - 70) / 25) * 0.8;
  return Math.round(rating * 10) / 10;
}

/** Home > [Category] > Title breadcrumb. Category level skipped if unknown. */
function buildBreadcrumb({ categorySlug, title, url }) {
  const items = [{ "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` }];
  let pos = 2;
  if (categorySlug && CATEGORY_NAMES[categorySlug]) {
    items.push({
      "@type": "ListItem",
      position: pos++,
      name: CATEGORY_NAMES[categorySlug],
      item: `${SITE}/category/${categorySlug}/`,
    });
  }
  items.push({ "@type": "ListItem", position: pos, name: (title || "").slice(0, 110), item: url });
  return { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items };
}

/** Classify an article into a single primary schema "kind". */
function classify(article) {
  const type = (article.article_type || "article").toLowerCase();
  const title = article.title || "";
  if (type === "review") return "review";
  if (type === "comparison") return "comparison";
  if (type === "how-to" || /^how to\b/i.test(title)) return "howto";
  if (
    ["listicle", "list", "top", "best", "alternatives"].includes(type) ||
    /^(?:\d+\s+|best\s|top\s)/i.test(title)
  ) {
    return "listicle";
  }
  return "article";
}

/**
 * Build the full array of JSON-LD schema objects for an article.
 * @param {object} article  Supabase article row (title, meta_description,
 *                          article_type, content_markdown, quality_score,
 *                          word_count, ...)
 * @param {object} opts     { url, imageUrl, datePublished, dateModified,
 *                            wordCount, categorySlug }
 * @returns {object[]} array of schema.org objects
 */
function buildSchemas(article, opts = {}) {
  const {
    url,
    imageUrl = DEFAULT_IMG,
    datePublished = new Date().toISOString(),
    dateModified = new Date().toISOString(),
    wordCount = article.word_count || 0,
    categorySlug = null,
  } = opts;

  const kind = classify(article);
  const isReview = kind === "review";

  // ── Base Article / Review ───────────────────────────────────────
  const base = {
    "@context": "https://schema.org",
    "@type": isReview ? "Review" : "Article",
    headline: (article.title || "").slice(0, 110),
    description: article.meta_description || "",
    image: { "@type": "ImageObject", url: imageUrl || DEFAULT_IMG, width: 1200, height: 630 },
    datePublished,
    dateModified,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    isAccessibleForFree: true,
    inLanguage: "en-US",
    wordCount,
    author: { "@type": "Organization", name: ORG_NAME, url: SITE, logo: LOGO },
    publisher: { "@type": "Organization", name: ORG_NAME, url: SITE, logo: LOGO },
  };

  if (isReview) {
    // "Make.com Review: ..." → "Make.com"; "Notion AI Review" → "Notion AI";
    // "Jasper vs Copy.ai" → "Jasper". Cut at the first delimiter word/char.
    const reviewedName = (article.title || "")
      .split(/\s*(?:\bvs\b|:|\breview\b|\balternatives?\b|\[)/i)[0]
      .trim();
    base.itemReviewed = {
      "@type": "SoftwareApplication",
      name: reviewedName || article.title,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
    };
    base.reviewRating = {
      "@type": "Rating",
      ratingValue: String(deriveRating(article.quality_score)),
      bestRating: "5",
      worstRating: "1",
    };
  }

  const schemas = [base];

  // ── Breadcrumb (whenever we know the URL) ───────────────────────
  if (url) schemas.push(buildBreadcrumb({ categorySlug, title: article.title, url }));

  // ── ItemList for listicles & comparisons ────────────────────────
  if (kind === "listicle" || kind === "comparison") {
    schemas.push({
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: article.title,
      itemListOrder: "https://schema.org/ItemListOrderDescending",
      url,
    });
  }

  // ── HowTo (only with ≥2 real parsed steps) ──────────────────────
  if (kind === "howto") {
    const steps = extractHowToSteps(article.content_markdown);
    if (steps.length >= 2) {
      schemas.push({
        "@context": "https://schema.org",
        "@type": "HowTo",
        name: article.title,
        description: article.meta_description || "",
        image: imageUrl || DEFAULT_IMG,
        step: steps.map((s, i) => ({
          "@type": "HowToStep",
          position: i + 1,
          name: s.name,
          text: s.text,
        })),
      });
    }
  }

  // ── FAQPage (any article with ≥3 Q&A) ───────────────────────────
  const faqs = extractFAQs(article.content_markdown);
  if (faqs.length >= 3) {
    schemas.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }

  return schemas;
}

/** Wrap schema object(s) in WordPress wp:html <script> blocks. */
function renderSchemaBlock(schemas) {
  const arr = Array.isArray(schemas) ? schemas : [schemas];
  return (
    "\n\n" +
    arr
      .map(
        (s) =>
          `<!-- wp:html -->\n<script type="application/ld+json">\n${JSON.stringify(s, null, 2)}\n</script>\n<!-- /wp:html -->`
      )
      .join("\n\n")
  );
}

// Matches our wp:html-wrapped ld+json blocks (with or without the wrapper)
const WRAPPED_SCHEMA_RE =
  /\n*<!-- wp:html -->\s*<script type="application\/ld\+json">[\s\S]*?<\/script>\s*<!-- \/wp:html -->/g;
const BARE_SCHEMA_RE = /\n*<script type="application\/ld\+json">[\s\S]*?<\/script>/g;

/** Remove previously-injected JSON-LD blocks so we can re-inject fresh ones. */
function stripSchemaBlocks(html) {
  if (!html) return html;
  return html.replace(WRAPPED_SCHEMA_RE, "").replace(BARE_SCHEMA_RE, "").trimEnd();
}

/** True if the HTML already contains any JSON-LD block. */
function hasSchema(html) {
  return !!html && /application\/ld\+json/.test(html);
}

module.exports = {
  SITE,
  CATEGORY_NAMES,
  NICHE_TO_CATEGORY_SLUG,
  extractFAQs,
  extractHowToSteps,
  deriveRating,
  buildBreadcrumb,
  classify,
  buildSchemas,
  renderSchemaBlock,
  stripSchemaBlocks,
  hasSchema,
};
