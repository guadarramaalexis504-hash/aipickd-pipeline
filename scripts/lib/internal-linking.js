"use strict";

const { normalizeLanguage } = require("./spanish-gate");

function filterCandidatesByLanguage(source, candidates, opts = {}) {
  const sourceLang = normalizeLanguage(source && source.language);
  if (opts.allowCrossLang) return candidates || [];
  return (candidates || []).filter(
    (candidate) => normalizeLanguage(candidate.language) === sourceLang
  );
}

function relatedHeading(language = "en") {
  return normalizeLanguage(language) === "es" ? "Articulos relacionados" : "Related Articles";
}

function buildRelatedBlock(articles, opts = {}) {
  const heading = relatedHeading(opts.language);
  const links = (articles || [])
    .map((article) => `<li><a href="${article.wp_url}">${article.title}</a></li>`)
    .join("\n");
  return `\n\n<div class="aipickd-related"><h3>${heading}</h3><ul>\n${links}\n</ul></div>`;
}

module.exports = { filterCandidatesByLanguage, relatedHeading, buildRelatedBlock };
