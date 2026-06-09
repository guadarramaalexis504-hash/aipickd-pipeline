"use strict";

const { normalizeLanguage } = require("./spanish-gate");

function appendUtm(url, params = {}) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
}

function ctaCopy(language = "en") {
  if (normalizeLanguage(language) === "es") {
    return {
      heading: "Listo para probarlo?",
      body: (brand) => `Prueba ${brand} y compara si encaja con tu flujo de trabajo.`,
      button: (brand) => `Probar ${brand} gratis`,
    };
  }
  return {
    heading: "Ready to try it?",
    body: (brand) => `Try ${brand} and see if it fits your workflow.`,
    button: (brand) => `Try ${brand} Free`,
  };
}

function buildLocalizedCta({ brand, baseUrl, slug, language = "en" }) {
  const copy = ctaCopy(language);
  const utmUrl = appendUtm(baseUrl, {
    utm_source: "aipickd",
    utm_medium: "cta",
    utm_campaign: slug,
  });
  return `<div class="aipickd-cta">
  <p><strong>${copy.heading}</strong> ${copy.body(brand)}</p>
  <a href="${utmUrl}" rel="nofollow sponsored" target="_blank" class="aipickd-btn">${copy.button(brand)} -></a>
</div>`;
}

module.exports = { appendUtm, ctaCopy, buildLocalizedCta };
