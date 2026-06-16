"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const {
  repairSpanishResidual,
  repairListCountTitle,
  repairStaleReferences,
  repairUnsupportedQuantitativeClaims,
  detectStaleReferences,
  detectUnsupportedQuantitativeClaims,
  qualityGate,
} = require("../scripts/lib/quality");

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
  const out = repairListCountTitle({
    title: "7 Mejores IAs para Crear Videos en 2026",
    language: "es",
    content_markdown: md,
  });
  assert.ok(out.changed);
  assert.equal(out.to, 5);
  assert.match(out.title, /^5 Mejores IAs/);
});

test("repairListCountTitle bails when the promised number appears twice (avoids contradiction)", () => {
  const md = [
    "# 7 Mejores IAs para Escribir en 2026: solo 7 valen",
    toolSection("ChatGPT"),
    toolSection("Claude"),
    toolSection("Jasper"),
    toolSection("Copy.ai"),
    "## Preguntas frecuentes\n**¿Q?** A.",
  ].join("\n\n");
  // developed 4, title promises 7 (twice) — must NOT produce "4 Mejores… solo 7 valen"
  const out = repairListCountTitle({
    title: "7 Mejores IAs para Escribir en 2026: solo 7 valen",
    language: "es",
    content_markdown: md,
  });
  assert.equal(out.changed, false);
});

test("repairListCountTitle is a no-op when count already matches", () => {
  const md = [
    "# 2 Mejores IAs",
    toolSection("Runway"),
    toolSection("Pika"),
    "## Preguntas frecuentes\n**¿Q?** A.",
  ].join("\n\n");
  const out = repairListCountTitle({
    title: "2 Mejores IAs",
    language: "es",
    content_markdown: md,
  });
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

// ── repairStaleReferences ────────────────────────────────────────────────
test("repairStaleReferences rewrites 'a octubre 2023' to 2026-safe wording in ES", () => {
  const md = "# 7 IAs en 2026\n\n## Runway\nA octubre 2023, era una opcion frecuente.";
  const out = repairStaleReferences(md, "es");
  assert.ok(out.changed);
  assert.doesNotMatch(out.text, /\boctubre 2023\b/i);
  assert.doesNotMatch(out.text, /\b2023\b/);
  // the detector must now find nothing on the repaired text
  const stale = detectStaleReferences({
    title: "7 IAs en 2026",
    content_markdown: out.text,
    language: "es",
  });
  assert.equal(stale.length, 0);
});

test("repairStaleReferences does NOT touch a year inside a markdown link URL", () => {
  const md = "En 2026 ver [el informe](https://example.com/report-2023).";
  const out = repairStaleReferences(md, "es");
  assert.match(out.text, /https:\/\/example\.com\/report-2023/);
});

test("repairStaleReferences leaves fenced code blocks untouched", () => {
  const md = "```\nconst y = 2023;\n```\n\nEn 2026, a octubre 2023 fue clave.";
  const out = repairStaleReferences(md, "es");
  assert.match(out.text, /```\nconst y = 2023;\n```/); // fenced 2023 survives
  assert.doesNotMatch(out.text, /a octubre 2023/i); // prose hedge rewritten
  assert.ok(out.changed);
});

test("repairStaleReferences is a no-op for English articles", () => {
  const md = "Numbers like 2023 stay as of 2023.";
  const out = repairStaleReferences(md, "en");
  assert.equal(out.changed, false);
  assert.equal(out.text, md);
});

// ── repairUnsupportedQuantitativeClaims ───────────────────────────────────
test("repairUnsupportedQuantitativeClaims softens bare % and verb+% with no source link", () => {
  const md = "# 7 IAs en 2026\n\nReduce hasta un 50% el tiempo y mejora 70% la calidad.";
  const out = repairUnsupportedQuantitativeClaims(md, "es");
  assert.ok(out.changed);
  assert.doesNotMatch(out.text, /\d{1,3}\s*%/); // no digit-percent token remains
  const claims = detectUnsupportedQuantitativeClaims({
    content_markdown: out.text,
    language: "es",
  });
  assert.equal(claims.length, 0);
});

test("repairUnsupportedQuantitativeClaims leaves a % that has a source link in the same paragraph", () => {
  const md = "Segun [el estudio](https://src.example/x), mejora 70% la velocidad.";
  const out = repairUnsupportedQuantitativeClaims(md, "es");
  assert.match(out.text, /70%/); // sourced claim preserved
  assert.equal(out.changed, false);
});

test("repairUnsupportedQuantitativeClaims is a no-op for English", () => {
  const md = "Improves speed by 70% and 50%.";
  const out = repairUnsupportedQuantitativeClaims(md, "en");
  assert.equal(out.changed, false);
  assert.equal(out.text, md);
});

// ── end-to-end: the exact draft that failed ───────────────────────────────
test("full ES listicle (7 promised / 5 developed, octubre 2023, %s) passes QA after the repair sequence", () => {
  function toolH2(name) {
    return `## ${name}\nHerramienta real con descripcion suficiente, para que sirve, ejemplo de tarea, precio aproximado, ventajas y desventajas, y mejor caso de uso para cubrir el conteo.\n`;
  }
  const md = [
    "Runway, Pika y otras opciones para crear videos con IA en 2026.",
    toolH2("Runway"),
    toolH2("Pika"),
    toolH2("Synthesia"),
    toolH2("HeyGen"),
    toolH2("Descript"),
    "A octubre 2023 estas apps eran nuevas; reduce hasta un 50% el tiempo de edicion y mejora 70% la calidad percibida.",
    "## Preguntas frecuentes\n**¿Cual conviene?** Depende de tu presupuesto, idioma y tipo de video que quieras producir.",
  ].join("\n\n");

  const article = {
    title: "7 IAs para crear videos: cuales convienen en 2026",
    content_markdown: md,
    language: "es",
    word_count: 1800,
  };

  // apply the deterministic repair sequence (title count, then stale, then quant)
  const countFix = repairListCountTitle(article);
  assert.ok(countFix.changed);
  assert.equal(countFix.to, 5);
  assert.match(countFix.title, /^5 IAs/);

  let body = repairStaleReferences(article.content_markdown, "es").text;
  body = repairUnsupportedQuantitativeClaims(body, "es").text;

  const qa = qualityGate({
    ...article,
    title: countFix.title,
    content_markdown: body,
  });

  const codes = qa.issues.map((i) => i.code);
  assert.ok(!codes.includes("list_count_mismatch"), `unexpected: ${JSON.stringify(qa.issues)}`);
  assert.ok(!codes.includes("stale_reference"), `unexpected: ${JSON.stringify(qa.issues)}`);
  assert.ok(
    !codes.includes("unsupported_quantitative_claim"),
    `unexpected: ${JSON.stringify(qa.issues)}`
  );
  assert.equal(qa.pass, true, `qa.issues: ${JSON.stringify(qa.issues)}`);
});
