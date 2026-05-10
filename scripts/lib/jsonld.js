/**
 * JSON-LD (Schema.org) validators for the structured data we ship.
 *
 * Why: Google rich results are gated on strict required-field rules, and
 * a missing field silently disables the result without a warning. Each
 * validator returns `{ ok, errors[] }` so callers can flag articles
 * missing rich-result eligibility before publishing.
 *
 * Coverage matches what AIPickd articles actually emit:
 *   - Article          (every published article)
 *   - Review           (review-type articles)
 *   - Product          (vs/comparison articles)
 *   - FAQPage          (any article with a FAQ section)
 *   - BreadcrumbList   (footer/header trail)
 *
 * Reference: https://developers.google.com/search/docs/appearance/structured-data
 */

const VALIDATORS = {
  Article: validateArticle,
  Review: validateReview,
  Product: validateProduct,
  FAQPage: validateFAQPage,
  BreadcrumbList: validateBreadcrumbList,
};

/**
 * Validate any JSON-LD object. Dispatches by `@type`.
 *
 * @param {unknown} jsonld
 * @returns {{ ok: boolean, type: string | null, errors: string[] }}
 */
function validate(jsonld) {
  if (!jsonld || typeof jsonld !== "object") {
    return { ok: false, type: null, errors: ["not an object"] };
  }
  const type = jsonld["@type"];
  if (!type || typeof type !== "string") {
    return { ok: false, type: null, errors: ["missing @type"] };
  }
  const fn = VALIDATORS[type];
  if (!fn) {
    return { ok: true, type, errors: [], skipped: `no validator for ${type}` };
  }
  const errors = [];
  fn(jsonld, errors);
  return { ok: errors.length === 0, type, errors };
}

/**
 * Extract every JSON-LD block from an HTML string and validate them all.
 *
 * @param {string} html
 * @returns {{ ok: boolean, blocks: Array<ReturnType<validate>> }}
 */
function validateHtml(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch (e) {
      blocks.push({ ok: false, type: null, errors: [`JSON parse: ${e.message}`] });
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      blocks.push(validate(item));
    }
  }
  return { ok: blocks.every((b) => b.ok), blocks };
}

// ── Per-type validators ──────────────────────

function validateArticle(j, errors) {
  if (j["@context"] !== "https://schema.org" && j["@context"] !== "http://schema.org") {
    errors.push("@context must be schema.org");
  }
  if (!j.headline || typeof j.headline !== "string" || j.headline.length === 0) {
    errors.push("headline required");
  } else if (j.headline.length > 110) {
    errors.push(`headline too long: ${j.headline.length} (max 110 for Google rich results)`);
  }
  if (!j.image) errors.push("image required");
  if (!j.datePublished) errors.push("datePublished required");
  if (j.datePublished && !isIsoDate(j.datePublished)) errors.push("datePublished must be ISO 8601");
  if (j.dateModified && !isIsoDate(j.dateModified)) errors.push("dateModified must be ISO 8601");
  if (!j.author) errors.push("author required");
  else if (typeof j.author === "object" && !j.author.name) errors.push("author.name required");
  if (!j.publisher) errors.push("publisher required");
  else if (typeof j.publisher === "object" && !j.publisher.name)
    errors.push("publisher.name required");
}

function validateReview(j, errors) {
  if (!j.itemReviewed) errors.push("itemReviewed required");
  if (!j.reviewRating) errors.push("reviewRating required");
  else {
    const rr = j.reviewRating;
    if (typeof rr !== "object") errors.push("reviewRating must be an object");
    else {
      if (rr.ratingValue === undefined || rr.ratingValue === null)
        errors.push("reviewRating.ratingValue required");
      else if (Number.isNaN(Number(rr.ratingValue)))
        errors.push("reviewRating.ratingValue must be numeric");
      if (rr.bestRating !== undefined && Number.isNaN(Number(rr.bestRating)))
        errors.push("reviewRating.bestRating must be numeric");
    }
  }
  if (!j.author) errors.push("author required");
}

function validateProduct(j, errors) {
  if (!j.name) errors.push("name required");
  // Either offers OR aggregateRating OR review must be present for rich results.
  if (!j.offers && !j.aggregateRating && !j.review) {
    errors.push("at least one of offers/aggregateRating/review required for rich result");
  }
  if (j.offers) {
    const offers = Array.isArray(j.offers) ? j.offers : [j.offers];
    for (const [i, o] of offers.entries()) {
      if (!o.price && o.price !== 0) errors.push(`offers[${i}].price required`);
      if (!o.priceCurrency) errors.push(`offers[${i}].priceCurrency required`);
    }
  }
  if (j.aggregateRating) {
    const ar = j.aggregateRating;
    if (ar.ratingValue === undefined) errors.push("aggregateRating.ratingValue required");
    if (ar.reviewCount === undefined && ar.ratingCount === undefined) {
      errors.push("aggregateRating.reviewCount or .ratingCount required");
    }
  }
}

function validateFAQPage(j, errors) {
  if (!Array.isArray(j.mainEntity) || j.mainEntity.length === 0) {
    errors.push("mainEntity must be a non-empty array");
    return;
  }
  for (const [i, q] of j.mainEntity.entries()) {
    if (q["@type"] !== "Question") errors.push(`mainEntity[${i}]: @type must be Question`);
    if (!q.name) errors.push(`mainEntity[${i}]: name (question) required`);
    if (!q.acceptedAnswer) errors.push(`mainEntity[${i}]: acceptedAnswer required`);
    else if (q.acceptedAnswer["@type"] !== "Answer")
      errors.push(`mainEntity[${i}].acceptedAnswer: @type must be Answer`);
    else if (!q.acceptedAnswer.text) errors.push(`mainEntity[${i}].acceptedAnswer: text required`);
  }
}

function validateBreadcrumbList(j, errors) {
  if (!Array.isArray(j.itemListElement) || j.itemListElement.length === 0) {
    errors.push("itemListElement must be a non-empty array");
    return;
  }
  for (const [i, item] of j.itemListElement.entries()) {
    if (item["@type"] !== "ListItem") errors.push(`itemListElement[${i}]: @type must be ListItem`);
    if (item.position === undefined) errors.push(`itemListElement[${i}]: position required`);
    if (!item.name) errors.push(`itemListElement[${i}]: name required`);
    // item.item is required for all but the last entry (the current page).
    if (i < j.itemListElement.length - 1 && !item.item) {
      errors.push(`itemListElement[${i}]: item (URL) required for non-final entries`);
    }
  }
}

function isIsoDate(s) {
  if (typeof s !== "string") return false;
  // 2026-05-09 OR 2026-05-09T12:34:56Z OR 2026-05-09T12:34:56+00:00
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s);
}

module.exports = { validate, validateHtml, VALIDATORS };
