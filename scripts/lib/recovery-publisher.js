"use strict";

const { publishKey } = require("./idempotency");
const { qualityGate } = require("./quality");
const { buildSchemas } = require("./schema");
const { normalizeLanguage } = require("./spanish-gate");

function affiliateDisclosure(language = "en") {
  if (normalizeLanguage(language) === "es") {
    return "<p><em>Transparencia: este articulo puede contener enlaces de afiliado. Si compras desde ellos, AIPickd puede recibir una comision sin costo extra para ti.</em></p>\n\n";
  }
  return "<p><em>Disclosure: this article may contain affiliate links. If you buy through them, AIPickd may earn a commission at no extra cost to you.</em></p>\n\n";
}

function buildRecoveryPublishPlan(article = {}, opts = {}) {
  const language = normalizeLanguage(article.language);
  const html = `${affiliateDisclosure(language)}${article.content_html || article.content_markdown || ""}`;
  const qa = qualityGate({ ...article, language });
  const idempotencyKey = publishKey({
    slug: article.slug || String(article.id || "draft"),
    body: html,
    day: opts.day,
  });
  const schemas = buildSchemas({ ...article, language }, { url: article.wp_url || null });

  return {
    willWrite: false,
    articleId: article.id || null,
    slug: article.slug || null,
    language,
    wpMeta: { _pipeline_lang: language },
    disclosure: affiliateDisclosure(language),
    idempotencyKey,
    qa,
    schema: {
      action: schemas.length > 0 ? "inject" : "skip",
      blocks: schemas.map((schema) => schema["@type"]),
    },
    indexNow: {
      action: "submit-after-publish",
      url: article.wp_url || null,
    },
  };
}

module.exports = { affiliateDisclosure, buildRecoveryPublishPlan };
