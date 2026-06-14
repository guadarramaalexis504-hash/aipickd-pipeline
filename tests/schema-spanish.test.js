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

test("buildSchemas emits HowTo for a Spanish how-to with 'Paso N' steps", () => {
  const md = `# Como usar Make.com en 2026

## Paso 1: Crea tu cuenta
Entra al sitio y registra una cuenta gratuita con tu correo para empezar de inmediato.

## Paso 2: Conecta tu primera app
Elige la aplicacion que quieres automatizar y autoriza el acceso desde el panel.

## Paso 3: Crea tu escenario
Arrastra los modulos, define el disparador y prueba el flujo antes de activarlo.

## Preguntas frecuentes
### ¿Make.com es gratis?
Tiene un plan gratuito con operaciones limitadas y planes de pago para mas volumen.`;
  const schemas = buildSchemas(
    { title: "Como usar Make.com en 2026", language: "es", article_type: "how-to", content_markdown: md, meta_description: "Guia paso a paso." },
    { url: "https://aipickd.com/es/como-usar-make-2026/" }
  );
  const types = schemas.map((s) => s["@type"]);
  assert.ok(types.includes("HowTo"), `expected HowTo, got ${types.join(",")}`);
  const howto = schemas.find((s) => s["@type"] === "HowTo");
  assert.equal(howto.step.length, 3);
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
