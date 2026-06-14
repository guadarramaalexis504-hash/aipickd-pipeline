"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { repairSpanishResidual } = require("../scripts/lib/quality");

test("translates an English FAQ heading to Spanish", () => {
  const md = "# Titulo\n\n## FAQ\n\n- pregunta\n";
  const out = repairSpanishResidual(md, "es");
  assert.ok(out.changed);
  assert.match(out.text, /^## Preguntas frecuentes$/m);
  assert.doesNotMatch(out.text, /^## FAQ$/m);
});

test("maps known English labels to Spanish", () => {
  const md = "Quick Verdict, Pricing, Key Takeaways, Overview, Use cases";
  const out = repairSpanishResidual(md, "es");
  assert.match(out.text, /Veredicto rápido/);
  assert.match(out.text, /Precios/);
  assert.match(out.text, /Puntos clave/);
  assert.match(out.text, /Resumen/);
  assert.match(out.text, /Casos de uso/);
});

test("is a no-op for English articles", () => {
  const md = "## FAQ\n\nQuick Verdict and Pricing";
  const out = repairSpanishResidual(md, "en");
  assert.equal(out.changed, false);
  assert.equal(out.text, md);
});

test("leaves fenced code blocks untouched", () => {
  const md = "```\n## FAQ\nPricing\n```\n\n## FAQ\n";
  const out = repairSpanishResidual(md, "es");
  assert.match(out.text, /```\n## FAQ\nPricing\n```/); // fenced copy preserved
  assert.match(out.text, /^## Preguntas frecuentes$/m); // real heading translated
});

test("reports what it replaced", () => {
  const out = repairSpanishResidual("## FAQ\n\nPricing", "es");
  const phrases = out.replaced.map((r) => r.phrase);
  assert.ok(phrases.includes("FAQ"));
  assert.ok(phrases.includes("Pricing"));
});
