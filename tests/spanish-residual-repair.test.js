"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { repairSpanishResidual, repairListCountTitle } = require("../scripts/lib/quality");

function toolSection(name) {
  return `## ${name}\nEs una herramienta real con descripción suficiente para contar como desarrollada. Precio aproximado y casos de uso.\n`;
}

test("repairListCountTitle lowers the title number to match developed tools", () => {
  const md = [
    "# 7 Mejores IAs para Crear Videos en 2026",
    toolSection("Runway"),
    toolSection("Pika"),
    toolSection("Synthesia"),
    toolSection("HeyGen"),
    toolSection("Descript"),
    "## Preguntas frecuentes\n**¿Pregunta?** Respuesta.",
  ].join("\n\n");
  const out = repairListCountTitle({ title: "7 Mejores IAs para Crear Videos en 2026", language: "es", content_markdown: md });
  assert.ok(out.changed);
  assert.equal(out.to, 5);
  assert.match(out.title, /^5 Mejores IAs/);
});

test("repairListCountTitle is a no-op when count already matches", () => {
  const md = ["# 2 Mejores IAs", toolSection("Runway"), toolSection("Pika"), "## Preguntas frecuentes\n**¿Q?** A."].join("\n\n");
  const out = repairListCountTitle({ title: "2 Mejores IAs", language: "es", content_markdown: md });
  assert.equal(out.changed, false);
});

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
