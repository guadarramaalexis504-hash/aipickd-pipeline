"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { extractFAQs, buildSchemas, buildBreadcrumb } = require("../scripts/lib/schema");

// Real article format: the answer sits on the line directly after the "### Q"
// heading (no blank line between them); blank line separates Q&A pairs.
const ES_FAQ_MD = `# ChatGPT vs Claude vs Gemini (2026)

## Comparativa

Texto de comparación con suficiente contenido para el artículo.

## Preguntas frecuentes

### ¿Cuál IA es mejor para estudiar?
ChatGPT destaca por sus explicaciones detalladas y su versatilidad para muchos temas académicos.

### ¿Claude o ChatGPT para idiomas?
Claude tiene ventaja en conversación natural, pero ChatGPT ofrece buenos ejemplos y contexto.

### ¿Gemini sirve para matemáticas?
Gemini es fuerte en áreas técnicas como cálculo y problemas STEM gracias a su enfoque multimodal.
`;

test("extractFAQs reads a Spanish 'Preguntas frecuentes' section", () => {
  const faqs = extractFAQs(ES_FAQ_MD);
  assert.equal(faqs.length, 3);
  assert.match(faqs[0].q, /¿Cuál IA es mejor para estudiar\?/);
  assert.ok(faqs[0].a.length > 20);
});

test("buildSchemas emits FAQPage for a Spanish article", () => {
  const schemas = buildSchemas(
    { title: "ChatGPT vs Claude vs Gemini (2026)", language: "es", article_type: "comparison", content_markdown: ES_FAQ_MD, meta_description: "Comparamos las IAs." },
    { url: "https://aipickd.com/es/chatgpt-vs-claude-vs-gemini-2026/" }
  );
  const types = schemas.map((s) => s["@type"]);
  assert.ok(types.includes("FAQPage"), `expected FAQPage, got ${types.join(",")}`);
  const faq = schemas.find((s) => s["@type"] === "FAQPage");
  assert.equal(faq.mainEntity.length, 3);
  assert.equal(faq.mainEntity[0]["@type"], "Question");
});

test("buildBreadcrumb localizes Home -> Inicio for Spanish", () => {
  const es = buildBreadcrumb({ title: "X", url: "https://aipickd.com/es/x/", language: "es" });
  const en = buildBreadcrumb({ title: "X", url: "https://aipickd.com/x/", language: "en" });
  assert.equal(es.itemListElement[0].name, "Inicio");
  assert.equal(en.itemListElement[0].name, "Home");
});

test("English FAQ extraction still works (no regression)", () => {
  const md = `## FAQ

### What is X?
X is a tool that does many useful things for you every single day.

### Is X free?
X has a free plan plus paid tiers with more features and higher limits.

### Who is X for?
X is for creators and small teams that want to move faster every day.
`;
  assert.equal(extractFAQs(md).length, 3);
});
