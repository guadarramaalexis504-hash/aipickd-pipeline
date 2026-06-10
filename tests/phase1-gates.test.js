const { test } = require("node:test");
const assert = require("node:assert/strict");

const { hasWriteFlag } = require("../scripts/lib/cli-safety");
const { appendUtm, buildLocalizedCta } = require("../scripts/lib/cta");
const {
  filterCandidatesByLanguage,
  buildRelatedBlock,
} = require("../scripts/lib/internal-linking");
const { filterPipelineKeywords, keywordStateForArticle } = require("../scripts/lib/spanish-gate");
const { buildRecoveryPublishPlan } = require("../scripts/lib/recovery-publisher");
const {
  cleanupAiTellPhrases,
  detectAiTellPhrases,
  qualityGate,
  repairToolPlaceholders,
} = require("../scripts/lib/quality");

test("cli safety: mutating scripts are dry/report-only unless an explicit write flag is present", () => {
  assert.equal(hasWriteFlag([]), false);
  assert.equal(hasWriteFlag(["--dry-run"]), false);
  assert.equal(hasWriteFlag(["--limit", "1"]), false);
  assert.equal(hasWriteFlag(["--go"]), true);
  assert.equal(hasWriteFlag(["--fix"]), true);
  assert.equal(hasWriteFlag(["--apply"]), true);
  assert.equal(hasWriteFlag(["--confirm"]), true);
});

test("spanish gate: cron excludes Spanish keywords unless flag or config gate is enabled", () => {
  const rows = [
    { id: "en-1", keyword: "best ai tools", language: "en" },
    { id: "es-1", keyword: "mejor ia para tareas", language: "es" },
  ];

  assert.deepEqual(
    filterPipelineKeywords(rows, { includeEs: false, spanishPipelineEnabled: false }).map(
      (r) => r.id
    ),
    ["en-1"]
  );
  assert.deepEqual(
    filterPipelineKeywords(rows, { includeEs: true, spanishPipelineEnabled: false }).map(
      (r) => r.id
    ),
    ["en-1", "es-1"]
  );
  assert.deepEqual(
    filterPipelineKeywords(rows, { includeEs: false, spanishPipelineEnabled: true }).map(
      (r) => r.id
    ),
    ["en-1", "es-1"]
  );
});

test("keyword state follows article publication truth", () => {
  assert.equal(
    keywordStateForArticle({ status: "draft", wp_post_id: null, wp_url: null }),
    "generated"
  );
  assert.equal(keywordStateForArticle({ status: "qa_failed" }), "qa_failed");
  assert.equal(
    keywordStateForArticle({
      status: "published",
      wp_post_id: 123,
      wp_url: "https://aipickd.com/es/foo/",
    }),
    "published"
  );
  assert.equal(
    keywordStateForArticle({ status: "published", wp_post_id: null, wp_url: null }),
    "generated"
  );
});

test("recovery publish plan preserves language and reports all non-writing actions", () => {
  const plan = buildRecoveryPublishPlan({
    id: "article-1",
    title: "Mejor IA para hacer tareas",
    slug: "mejor-ia-para-hacer-tareas",
    language: "es",
    status: "draft",
    content_markdown:
      "Intro con mejor ia para hacer tareas.\n\n## Seccion uno\nTexto.\n\n## Seccion dos\nTexto.\n\n## Seccion tres\nTexto.\n\n## Seccion cuatro\nTexto.\n\n## Seccion cinco\nTexto.\n\n## FAQ\n### Que es?\nRespuesta suficiente.",
    primary_keyword: "mejor ia para hacer tareas",
    word_count: 1250,
  });

  assert.equal(plan.willWrite, false);
  assert.equal(plan.language, "es");
  assert.deepEqual(plan.wpMeta, { _pipeline_lang: "es" });
  assert.match(plan.disclosure, /enlaces de afiliado/i);
  assert.match(plan.idempotencyKey, /^[a-f0-9]{32}$/);
  assert.equal(typeof plan.qa.pass, "boolean");
  assert.equal(plan.schema.action, "inject");
  assert.equal(plan.indexNow.action, "submit-after-publish");
});

test("appendUtm preserves existing query strings", () => {
  assert.equal(
    appendUtm("https://example.com/product?ref=abc", {
      utm_source: "aipickd",
      utm_medium: "cta",
    }),
    "https://example.com/product?ref=abc&utm_source=aipickd&utm_medium=cta"
  );
});

test("CTA copy localizes to Spanish", () => {
  const html = buildLocalizedCta({
    brand: "Jasper",
    baseUrl: "https://example.com/?ref=abc",
    slug: "mejor-ia",
    language: "es",
  });
  assert.match(html, /Listo para probarlo/i);
  assert.match(html, /utm_source=aipickd/);
  assert.match(html, /ref=abc&utm_source/);
});

test("internal links are same-language by default and do not use nofollow", () => {
  const source = { id: "a", language: "es" };
  const related = filterCandidatesByLanguage(source, [
    { id: "b", title: "ES target", language: "es", wp_url: "https://aipickd.com/es/b/" },
    { id: "c", title: "EN target", language: "en", wp_url: "https://aipickd.com/c/" },
  ]);

  assert.deepEqual(
    related.map((r) => r.id),
    ["b"]
  );
  const block = buildRelatedBlock(related, { language: "es" });
  assert.match(block, /Articulos relacionados/);
  assert.doesNotMatch(block, /nofollow/i);
});

test("AI-tell cleanup removes common phrases and QA blocks any leftovers clearly", () => {
  const articleBody = [
    "# Top 10 AI-Powered Blog Writing Tools Ranked for 2026",
    "",
    "In today's digital landscape, teams want a game-changer that can unlock better drafts.",
    "This cutting-edge workflow can feel seamless, but a robust solution still needs editing.",
    "Let's dive in and delve into how to harness the power of each powerful tool.",
    "The goal is not to revolutionize your process or elevate every paragraph overnight.",
    "",
    "## FAQ",
    "### What should buyers check first?",
    "Start with output quality, pricing, and editorial controls.",
  ].join("\n");

  const detected = detectAiTellPhrases(articleBody);
  assert.ok(detected.length >= 7, `expected 7+ AI-tells, got ${detected.length}`);

  const cleaned = cleanupAiTellPhrases(articleBody);
  assert.equal(detectAiTellPhrases(cleaned.text).length, 0);

  const qa = qualityGate({
    content_markdown: articleBody,
    language: "en",
    word_count: 1200,
  });
  const aiTellIssue = qa.issues.find((issue) => issue.code === "ai_tells");
  assert.ok(aiTellIssue, "QA should block uncleaned AI-tell clusters");
  assert.match(aiTellIssue.message, /AI-tell phrases/);
  assert.equal(aiTellIssue.repairable, true);
});

test("QA blocks generic tool placeholders before publish", () => {
  const articleBody = [
    "# Best AI Homework Helpers",
    "",
    "Tool A is useful for math homework, while Tool B is better for essays.",
    "Tool C can help summarize long readings, but the draft must name real products.",
    "",
    "## FAQ",
    "### Which AI homework helper should students try first?",
    "Start with a real product name, then compare pricing, accuracy, and citation controls.",
  ].join("\n");

  const qa = qualityGate({
    content_markdown: articleBody,
    language: "en",
    word_count: 1200,
  });

  const placeholderIssue = qa.issues.find((issue) => issue.code === "tool_placeholders");
  assert.equal(qa.pass, false);
  assert.ok(placeholderIssue, "QA should block Tool A/B/C placeholders");
  assert.match(placeholderIssue.message, /Tool A/i);
  assert.equal(placeholderIssue.repairable, true);
});

test("QA blocks Spanish bracketed product placeholders before publish", () => {
  const articleBody = [
    "# 7 Mejores IAs para Hacer Tareas en 2026",
    "",
    "## [Herramienta 1]: Zapier",
    "Zapier ayuda a automatizar tareas administrativas.",
    "",
    "## FAQ",
    "### Cual IA conviene para empezar?",
    "Empieza comparando precio, idioma, limites y el tipo de tarea que necesitas resolver.",
  ].join("\n");

  const qa = qualityGate({
    title: "7 Mejores IAs para Hacer Tareas en 2026",
    content_markdown: articleBody,
    language: "es",
    primary_keyword: "mejor ia para hacer tareas",
    word_count: 1200,
  });

  const placeholderIssue = qa.issues.find((issue) => issue.code === "tool_placeholders");
  assert.equal(qa.pass, false);
  assert.ok(placeholderIssue, "QA should block bracketed Spanish placeholders");
  assert.match(placeholderIssue.message, /\[Herramienta 1\]/i);
});

test("QA blocks visible English residual headings in Spanish articles", () => {
  const articleBody = [
    "# 7 Mejores IAs para Hacer Tareas en 2026",
    "",
    "## Quick Picks: las mejores segun cada caso",
    "Zapier sirve para automatizar tareas administrativas.",
    "",
    "## FAQ",
    "### Cual IA conviene para empezar?",
    "Empieza comparando precio, idioma, limites y el tipo de tarea que necesitas resolver.",
  ].join("\n");

  const qa = qualityGate({
    title: "7 Mejores IAs para Hacer Tareas en 2026",
    content_markdown: articleBody,
    language: "es",
    primary_keyword: "mejor ia para hacer tareas",
    word_count: 1200,
  });

  const englishIssue = qa.issues.find((issue) => issue.code === "english_residual");
  assert.equal(qa.pass, false);
  assert.ok(englishIssue, "QA should block visible English headings in ES content");
  assert.match(englishIssue.message, /Quick Picks/i);
});

test("QA blocks Spanish listicles when title count exceeds developed tools", () => {
  const articleBody = [
    "# 7 Mejores IAs para Hacer Tareas en 2026",
    "",
    "## Zapier",
    "Automatiza tareas entre aplicaciones.",
    "## Jasper AI",
    "Ayuda a redactar borradores y contenido.",
    "## Monday.com",
    "Organiza tareas de equipo.",
    "## ClickUp",
    "Centraliza tareas y documentos.",
    "## Writesonic",
    "Genera textos cortos para marketing.",
    "",
    "## FAQ",
    "### Cual IA conviene para empezar?",
    "Empieza comparando precio, idioma, limites y el tipo de tarea que necesitas resolver.",
  ].join("\n");

  const qa = qualityGate({
    title: "7 Mejores IAs para Hacer Tareas en 2026",
    content_markdown: articleBody,
    language: "es",
    primary_keyword: "mejor ia para hacer tareas",
    word_count: 1200,
  });

  const mismatchIssue = qa.issues.find((issue) => issue.code === "list_count_mismatch");
  assert.equal(qa.pass, false);
  assert.ok(mismatchIssue, "QA should block list count mismatch");
  assert.equal(mismatchIssue.message, "title promises 7 tools but only 5 were developed");
});

test("QA counts only developed Spanish tool sections, not nested detail headings", () => {
  const articleBody = [
    "# 7 Mejores IAs para Hacer Tareas que Destacan en 2026",
    "",
    "Esta guia compara opciones para elegir la mejor ia para hacer tareas segun el caso.",
    "",
    "## Puntos clave:",
    "Compara idioma, precio y tipo de tarea.",
    "## Resumen rápido: Las 3 mejores según uso",
    "Una seleccion editorial breve.",
    "## ¿Cómo seleccionamos estas herramientas?",
    "Evaluamos criterios publicos y casos de uso tipicos.",
    "",
    "## 1. ChatGPT-4: Redaccion y solucion de problemas",
    "### Para que sirve?",
    "Ayuda a explicar conceptos, resumir textos y crear borradores.",
    "### Precio:",
    "Tiene plan gratuito y planes de pago.",
    "### Pros:",
    "Responde rapido y cubre muchos tipos de tareas.",
    "### Contras:",
    "Requiere revisar datos sensibles.",
    "### Mejor caso de uso:",
    "Borradores, explicaciones y organizacion de ideas.",
    "",
    "## 2. Notion AI: Organizacion de notas y proyectos",
    "### Para que sirve?",
    "Resume notas, transforma listas y ordena tareas.",
    "### Precio:",
    "Se ofrece como complemento dentro de Notion.",
    "### Pros:",
    "Funciona bien si ya usas Notion.",
    "### Contras:",
    "Depende de tener la informacion dentro del espacio de trabajo.",
    "### Mejor caso de uso:",
    "Convertir notas dispersas en tareas claras.",
    "",
    "## 3. Zapier: Automatizar tareas repetitivas",
    "### Para que sirve?",
    "Conecta apps para mover datos y activar flujos.",
    "### Precio:",
    "Incluye plan gratuito limitado y planes de pago.",
    "### Pros:",
    "Tiene muchas integraciones.",
    "### Contras:",
    "Los flujos avanzados requieren cuidado.",
    "### Mejor caso de uso:",
    "Automatizar recordatorios y traspaso de informacion.",
    "",
    "## 4. Jasper AI: Redaccion para marketing",
    "### Para que sirve?",
    "Genera borradores para campanas y piezas comerciales.",
    "### Precio:",
    "Sus planes suelen ser de pago.",
    "### Pros:",
    "Tiene plantillas orientadas a marketing.",
    "### Contras:",
    "No es la opcion mas barata.",
    "### Mejor caso de uso:",
    "Ideas y borradores para contenido comercial.",
    "",
    "## 5. Grammarly Premium: Revision y claridad",
    "### Para que sirve?",
    "Ayuda a corregir tono, claridad y errores de escritura.",
    "### Precio:",
    "Tiene version gratuita y planes premium.",
    "### Pros:",
    "Es util para revisar textos finales.",
    "### Contras:",
    "No reemplaza una revision humana completa.",
    "### Mejor caso de uso:",
    "Pulir entregas, correos y documentos.",
    "",
    "## FAQ",
    "### Cual IA conviene para empezar?",
    "Empieza por una herramienta general y despues suma automatizacion si la necesitas.",
  ].join("\n");

  const qa = qualityGate({
    title: "7 Mejores IAs para Hacer Tareas que Destacan en 2026",
    content_markdown: articleBody,
    language: "es",
    primary_keyword: "mejor ia para hacer tareas",
    word_count: 1741,
  });

  const mismatchIssue = qa.issues.find((issue) => issue.code === "list_count_mismatch");
  assert.equal(qa.pass, false);
  assert.ok(mismatchIssue, "QA should count only 5 developed tools");
  assert.equal(mismatchIssue.message, "title promises 7 tools but only 5 were developed");
});

test("QA listicle count passes when Spanish title promises 7 tools and 7 are developed", () => {
  const toolSections = [
    "ChatGPT-4",
    "Claude",
    "Gemini",
    "Microsoft Copilot",
    "Perplexity",
    "Notion AI",
    "Zapier",
  ].flatMap((tool, index) => [
    `## ${index + 1}. ${tool}: ayuda concreta para tareas`,
    "### Para que sirve?",
    `${tool} ayuda a resolver una tarea especifica dentro de un flujo de estudio o trabajo.`,
    "### Precio:",
    "Incluye plan gratuito, prueba o plan de pago segun la plataforma.",
    "### Pros:",
    "Tiene un caso de uso claro y facil de explicar.",
    "### Contras:",
    "Conviene revisar sus respuestas antes de entregar trabajo final.",
    "### Mejor caso de uso:",
    "Usarla cuando necesitas avanzar una tarea concreta sin perder control editorial.",
  ]);

  const articleBody = [
    "# 7 Mejores IAs para Hacer Tareas en 2026",
    "",
    "Esta guia ayuda a comparar la mejor ia para hacer tareas segun necesidad, presupuesto y contexto.",
    "",
    ...toolSections,
    "",
    "## FAQ",
    "### Cual IA conviene para empezar?",
    "Empieza con una opcion general y compara resultados con una segunda herramienta.",
  ].join("\n");

  const qa = qualityGate({
    title: "7 Mejores IAs para Hacer Tareas en 2026",
    content_markdown: articleBody,
    language: "es",
    primary_keyword: "mejor ia para hacer tareas",
    word_count: 1800,
  });

  const mismatchIssue = qa.issues.find((issue) => issue.code === "list_count_mismatch");
  assert.equal(mismatchIssue, undefined);
});

test("QA blocks stale 2023 references in Spanish 2026 articles", () => {
  const articleBody = [
    "# 7 Mejores IAs para Hacer Tareas en 2026",
    "",
    "## Zapier",
    "A octubre 2023, Zapier era una opcion frecuente para automatizar tareas.",
    "",
    "## FAQ",
    "### Cual IA conviene para empezar?",
    "Empieza comparando precio, idioma, limites y el tipo de tarea que necesitas resolver.",
  ].join("\n");

  const qa = qualityGate({
    title: "7 Mejores IAs para Hacer Tareas en 2026",
    content_markdown: articleBody,
    language: "es",
    primary_keyword: "mejor ia para hacer tareas",
    word_count: 1200,
  });

  const staleIssue = qa.issues.find((issue) => issue.code === "stale_reference");
  assert.equal(qa.pass, false);
  assert.ok(staleIssue, "QA should block stale references");
  assert.match(staleIssue.message, /a octubre 2023/i);
});

test("QA blocks unsupported strong claims in Spanish articles", () => {
  const articleBody = [
    "# 7 Mejores IAs para Hacer Tareas en 2026",
    "",
    "## Zapier",
    "Probamos en proyectos reales y vimos que reduce el trabajo manual en 30%-40%.",
    "",
    "## FAQ",
    "### Cual IA conviene para empezar?",
    "Empieza comparando precio, idioma, limites y el tipo de tarea que necesitas resolver.",
  ].join("\n");

  const qa = qualityGate({
    title: "7 Mejores IAs para Hacer Tareas en 2026",
    content_markdown: articleBody,
    language: "es",
    primary_keyword: "mejor ia para hacer tareas",
    word_count: 1200,
  });

  const claimIssue = qa.issues.find((issue) => issue.code === "unsupported_claim");
  assert.equal(qa.pass, false);
  assert.ok(claimIssue, "QA should block unsupported strong claims");
  assert.match(claimIssue.message, /30%-40%|probamos en proyectos reales/i);
});

test("QA blocks Spanish quantitative claims when the article has no source links", () => {
  const articleBody = [
    "# ChatGPT vs Claude vs Gemini para estudiar",
    "",
    "## Comparacion principal",
    "ChatGPT mejora la productividad en 65% y Claude reduce errores en 42%.",
    "",
    "## Preguntas frecuentes",
    "### Cual conviene para estudiar?",
    "Depende del tipo de tarea, presupuesto y necesidad de explicar el razonamiento.",
  ].join("\n");

  const qa = qualityGate({
    title: "ChatGPT vs Claude vs Gemini para estudiar (2026)",
    content_markdown: articleBody,
    language: "es",
    word_count: 1200,
  });

  const quantitativeIssue = qa.issues.find(
    (issue) => issue.code === "unsupported_quantitative_claim"
  );
  assert.equal(qa.pass, false);
  assert.ok(quantitativeIssue, "QA should block unsourced Spanish percentage claims");
  assert.match(quantitativeIssue.message, /65%|42%/);
});

test("QA allows Spanish quantitative claims when source links are present", () => {
  const articleBody = [
    "# ChatGPT vs Claude vs Gemini para estudiar",
    "",
    "## Comparacion principal",
    "Un informe publico reporta una mejora de 40% en ciertos flujos documentados.",
    "Fuente: [estudio publicado](https://example.com/estudio-ia-estudiantes).",
    "",
    "## Preguntas frecuentes",
    "### Cual conviene para estudiar?",
    "Depende del tipo de tarea, presupuesto y necesidad de explicar el razonamiento.",
  ].join("\n");

  const qa = qualityGate({
    title: "ChatGPT vs Claude vs Gemini para estudiar (2026)",
    content_markdown: articleBody,
    language: "es",
    word_count: 1200,
  });

  const quantitativeIssue = qa.issues.find(
    (issue) => issue.code === "unsupported_quantitative_claim"
  );
  assert.equal(quantitativeIssue, undefined);
});

test('QA blocks "FAQ" heading in Spanish articles', () => {
  const articleBody = [
    "# ChatGPT vs Claude vs Gemini para estudiar",
    "",
    "## Comparacion principal",
    "ChatGPT, Claude y Gemini tienen fortalezas distintas para estudiar.",
    "",
    "## FAQ",
    "### Cual conviene para estudiar?",
    "Depende del tipo de tarea, presupuesto y necesidad de explicar el razonamiento.",
  ].join("\n");

  const qa = qualityGate({
    title: "ChatGPT vs Claude vs Gemini para estudiar (2026)",
    content_markdown: articleBody,
    language: "es",
    word_count: 1200,
  });

  const englishIssue = qa.issues.find((issue) => issue.code === "english_residual");
  assert.equal(qa.pass, false);
  assert.ok(englishIssue, "QA should block FAQ as residual English in ES content");
  assert.match(englishIssue.message, /FAQ/);
});

test('QA accepts "Preguntas frecuentes" heading in Spanish articles', () => {
  const articleBody = [
    "# ChatGPT vs Claude vs Gemini para estudiar",
    "",
    "## Comparacion principal",
    "ChatGPT, Claude y Gemini tienen fortalezas distintas para estudiar.",
    "",
    "## Preguntas frecuentes",
    "### Cual conviene para estudiar?",
    "Depende del tipo de tarea, presupuesto y necesidad de explicar el razonamiento.",
  ].join("\n");

  const qa = qualityGate({
    title: "ChatGPT vs Claude vs Gemini para estudiar (2026)",
    content_markdown: articleBody,
    language: "es",
    word_count: 1200,
  });

  const englishIssue = qa.issues.find((issue) => issue.code === "english_residual");
  assert.equal(englishIssue, undefined);
});

test("placeholder repair replaces generic tools with real homework AI products", () => {
  const repaired = repairToolPlaceholders(
    "Tool A handles math. Tool B explains essays. Tool C summarizes readings.",
    {
      toolA: "ChatGPT",
      toolB: "Claude",
      toolC: "Gemini",
    }
  );

  assert.equal(repaired.changed, true);
  assert.match(repaired.text, /ChatGPT handles math/);
  assert.match(repaired.text, /Claude explains essays/);
  assert.match(repaired.text, /Gemini summarizes readings/);
  assert.equal(repaired.remaining.length, 0);
});
