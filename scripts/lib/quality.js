"use strict";

const { normalizeLanguage } = require("./spanish-gate");

const AI_TELL_PHRASES = [
  "game-changer",
  "cutting-edge",
  "seamless",
  "unlock",
  "elevate",
  "revolutionize",
  "in today's digital landscape",
  "in today's fast-paced world",
  "harness the power",
  "delve into",
  "let's dive in",
  "robust solution",
  "powerful tool",
];

const AI_TELL_PATTERNS = [
  { phrase: "game-changer", re: /\bgame[- ]changer\b/gi, replacement: "meaningful advantage" },
  { phrase: "cutting-edge", re: /\bcutting[- ]edge\b/gi, replacement: "current" },
  { phrase: "seamless", re: /\bseamless(?:ly)?\b/gi, replacement: "smooth" },
  { phrase: "unlock", re: /\bunlock(?:s|ed|ing)?\b/gi, replacement: "get" },
  { phrase: "elevate", re: /\belevat(?:e|es|ed|ing)\b/gi, replacement: "improve" },
  { phrase: "revolutionize", re: /\brevolutioniz(?:e|es|ed|ing)\b/gi, replacement: "change" },
  {
    phrase: "in today's digital landscape",
    re: /\bin today's digital landscape\b/gi,
    replacement: "for current online work",
  },
  {
    phrase: "in today's fast-paced world",
    re: /\bin today's fast-paced world\b/gi,
    replacement: "for busy teams",
  },
  { phrase: "harness the power", re: /\bharness the power\b/gi, replacement: "use" },
  { phrase: "delve into", re: /\bdelve into\b/gi, replacement: "look at" },
  { phrase: "let's dive in", re: /\blet'?s dive in\b/gi, replacement: "here is the breakdown" },
  { phrase: "robust solution", re: /\brobust solution\b/gi, replacement: "solid option" },
  { phrase: "powerful tool", re: /\bpowerful tool\b/gi, replacement: "useful tool" },
  { phrase: "it's important to note", re: /\bit'?s important to note\b/gi, replacement: "" },
  { phrase: "it's worth noting", re: /\bit'?s worth noting\b/gi, replacement: "" },
  { phrase: "when it comes to", re: /\bwhen it comes to\b/gi, replacement: "for" },
  { phrase: "whether you're", re: /\bwhether you'?re\b/gi, replacement: "if you are" },
  { phrase: "in the realm of", re: /\bin the realm of\b/gi, replacement: "in" },
  { phrase: "in the world of", re: /\bin the world of\b/gi, replacement: "in" },
  { phrase: "let's explore", re: /\blet'?s explore\b/gi, replacement: "here is" },
  { phrase: "let's take a look", re: /\blet'?s take a look\b/gi, replacement: "here is" },
  { phrase: "supercharge", re: /\bsupercharge(?:s|d|ing)?\b/gi, replacement: "improve" },
];

const TOOL_PLACEHOLDER_PATTERNS = [
  { phrase: "Tool A", re: /\bTool\s+A\b/g, key: "toolA" },
  { phrase: "Tool B", re: /\bTool\s+B\b/g, key: "toolB" },
  { phrase: "Tool C", re: /\bTool\s+C\b/g, key: "toolC" },
  { phrase: "Herramienta A", re: /\bHerramienta\s+A\b/gi, key: "toolA" },
  { phrase: "Herramienta B", re: /\bHerramienta\s+B\b/gi, key: "toolB" },
  { phrase: "Herramienta C", re: /\bHerramienta\s+C\b/gi, key: "toolC" },
  { phrase: "Producto A", re: /\bProducto\s+A\b/gi, key: "toolA" },
  { phrase: "Producto B", re: /\bProducto\s+B\b/gi, key: "toolB" },
  { phrase: "Producto C", re: /\bProducto\s+C\b/gi, key: "toolC" },
  { phrase: "Producto A/B/C", re: /\bProducto\s+A\/B\/C\b/gi, key: "toolSet" },
  { phrase: "[Tool]", re: /\[Tool\]/g, key: "genericTool" },
  { phrase: "[Nombre de herramienta]", re: /\[Nombre de herramienta\]/gi, key: "genericTool" },
  { phrase: "[Nombre del producto]", re: /\[Nombre del producto\]/gi, key: "genericProduct" },
  { phrase: "[Nombre de la app]", re: /\[Nombre de la app\]/gi, key: null },
  { phrase: "[Nombre de IA]", re: /\[Nombre de IA\]/gi, key: null },
  { phrase: "[Nombre]", re: /\[Nombre\]/gi, key: null },
  {
    phrase: "bracketed Spanish placeholder",
    re: /\[(?:Herramienta|Producto|Nombre)[^\]]*\]/gi,
    key: null,
    phraseFromValue: true,
  },
];

const ES_VISIBLE_ENGLISH_PATTERNS = [
  { phrase: "Quick Picks", re: /\bQuick Picks\b/gi },
  { phrase: "Key fact", re: /\bKey fact\b/gi },
  { phrase: "Final Verdict", re: /\bFinal Verdict\b/gi },
  { phrase: "Pros and Cons", re: /\bPros and Cons\b/gi },
  { phrase: "Pricing", re: /\bPricing\b/gi },
  { phrase: "Features", re: /\bFeatures\b/gi },
  { phrase: "Overview", re: /\bOverview\b/gi },
  { phrase: "Best for", re: /\bBest for\b/gi },
  { phrase: "Use cases", re: /\bUse cases\b/gi },
];

const ES_ENGLISH_HEADING_PATTERNS = [
  { phrase: "FAQ", re: /^FAQ:?$/i },
  { phrase: "Pros", re: /^Pros:?$/i },
  { phrase: "Cons", re: /^Cons:?$/i },
];

const STALE_REFERENCE_PATTERNS = [
  { phrase: "as of October 2023", re: /\bas of\s+October\s+2023\b/gi },
  { phrase: "a octubre 2023", re: /\ba\s+octubre\s+2023\b/gi },
  { phrase: "octubre 2023", re: /\boctubre\s+2023\b/gi },
  { phrase: "2023", re: /\b2023\b/g },
  {
    phrase: "2024 as current/source reference",
    re: /\b(?:as of|a\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)|dato clave|segun|segun|actualmente|precio|desde)[^\n.]{0,80}\b2024\b/gi,
  },
];

const UNSUPPORTED_QUANTITATIVE_CLAIM_PATTERNS = [
  {
    phrase: "percentage claim",
    re: /\b\d{1,3}(?:[.,]\d+)?\s*%(?:\s*[-–]\s*\d{1,3}(?:[.,]\d+)?\s*%)?/gi,
  },
  { phrase: "x de cada y", re: /\b\d+\s+de\s+cada\s+\d+\b/gi },
  {
    phrase: "quantified improvement claim",
    re: /\b(?:aumenta|aumentan|aument[oó]|incrementa|incrementan|reduce|reducen|mejora|mejoran|sube|baja)[^\n.]{0,80}\d{1,3}(?:[.,]\d+)?\s*%/gi,
  },
  { phrase: "segun datos", re: /\bseg[uú]n\s+datos\b/gi },
];

const UNSUPPORTED_CLAIM_PATTERNS = [
  { phrase: "percentage claim", re: /\b\d{1,3}\s*%(?:\s*[-–]\s*\d{1,3}\s*%)?\b/g },
  { phrase: "mas usada", re: /\bm[aá]s\s+usad[ao]s?\b/gi },
  { phrase: "lider del mercado", re: /\bl[ií]der(?:es)?\s+del\s+mercado\b/gi },
  { phrase: "probamos en proyectos reales", re: /\bprobamos\s+en\s+proyectos\s+reales\b/gi },
  { phrase: "probamos", re: /\bprobamos\b/gi },
  { phrase: "probe", re: /\bprob[eé]\b/gi },
  { phrase: "probadas", re: /\bprobad[ao]s?\b/gi },
];

const DEFAULT_TOOL_PLACEHOLDER_REPLACEMENTS = {
  toolA: "ChatGPT",
  toolB: "Claude",
  toolC: "Gemini",
  toolSet: "ChatGPT/Claude/Gemini",
  genericTool: "ChatGPT",
  genericProduct: "ChatGPT",
};

function uniqueMatches(matches) {
  return Array.from(new Set(matches.map((match) => match.phrase))).map((phrase) => ({
    phrase,
    count: matches.filter((match) => match.phrase === phrase).length,
  }));
}

function detectAiTellPhrases(markdown = "") {
  const text = String(markdown || "");
  const matches = [];
  for (const pattern of AI_TELL_PATTERNS) {
    const found = text.match(pattern.re);
    if (!found) continue;
    for (const value of found) {
      matches.push({ phrase: pattern.phrase, value });
    }
  }
  return matches;
}

function detectToolPlaceholders(markdown = "") {
  const text = String(markdown || "");
  const matches = [];
  for (const pattern of TOOL_PLACEHOLDER_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      matches.push({
        phrase: pattern.phraseFromValue ? match[0] : pattern.phrase,
        value: match[0],
        key: pattern.key,
      });
    }
  }
  return matches;
}

function visibleMarkdownText(markdown = "") {
  return String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gi, "$1")
    .replace(/https?:\/\/[^\s)]+/gi, " ")
    .replace(/\[AFFILIATE:[^\]]+\]/gi, "")
    .replace(/\[\/AFFILIATE\]/gi, "")
    .replace(/<[^>]+>/g, " ");
}

function detectVisibleEnglishResidual(markdown = "", language = "en") {
  if (normalizeLanguage(language) !== "es") return [];
  const visible = visibleMarkdownText(markdown);
  const matches = [];
  for (const pattern of ES_VISIBLE_ENGLISH_PATTERNS) {
    for (const match of visible.matchAll(pattern.re)) {
      matches.push({ phrase: pattern.phrase, value: match[0] });
    }
  }
  for (const heading of extractHeadings(markdown)) {
    const headingText = heading.text.replace(/\*\*/g, "").trim();
    for (const pattern of ES_ENGLISH_HEADING_PATTERNS) {
      if (pattern.re.test(headingText)) {
        matches.push({ phrase: pattern.phrase, value: headingText });
      }
    }
  }
  return matches;
}

function extractHeadings(markdown = "") {
  return Array.from(String(markdown || "").matchAll(/^(#{2,3})\s+(.+?)\s*$/gm)).map((match) => ({
    level: match[1].length,
    text: match[2].replace(/\*\*/g, "").trim(),
  }));
}

function stripAccents(text = "") {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function cleanToolHeadingName(heading = "") {
  return String(heading || "")
    .replace(/\[AFFILIATE:[^\]]+\]/gi, "")
    .replace(/\[\/AFFILIATE\]/gi, "")
    .replace(/^\[(?:Herramienta|Producto)\s+\d+\]\s*:\s*/i, "")
    .replace(/^(?:Herramienta|Producto)\s+\d+\s*:\s*/i, "")
    .replace(/^\d+\s*[.)-]\s*/, "")
    .replace(/^[#*\s]+|[*\s]+$/g, "")
    .trim();
}

function isGenericListicleHeading(heading = "") {
  const normalized = stripAccents(cleanToolHeadingName(heading)).toLowerCase();
  return /^(faq|preguntas|conclusion|comparativa|como elegimos|como elegir|como seleccionamos|mas herramientas|quick picks|veredicto|puntos clave|tabla|precio|precios|plan|planes|pros|contras|ventajas|desventajas|caracteristicas|aspectos|metodologia|resumen|para que sirve|ejemplo|mejor caso|caso de uso)\b/.test(
    normalized
  );
}

function expectedListCountFromTitle(title = "") {
  const normalized = stripAccents(title).toLowerCase();
  const patterns = [
    /\b(\d{1,2})\s+(?:mejores?|ias?|herramientas?|apps?|aplicaciones|opciones|alternativas|tools?|best|top)\b/i,
    /\btop\s+(\d{1,2})\b/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return Number(match[1]);
  }
  return 0;
}

function hasNumberedToolPrefix(heading = "") {
  return /^\s*(?:\d+\s*[.)-]|\[(?:Herramienta|Producto)\s+\d+\]\s*:)/i.test(String(heading || ""));
}

function developedToolHeadingKey(heading = {}) {
  const cleanName = cleanToolHeadingName(heading.text);
  const normalized = stripAccents(cleanName).toLowerCase();
  if (!cleanName || isGenericListicleHeading(heading.text)) return null;
  if (/^[¿?¡!\s]*(?:que|cual|cuando|donde|por que|como)\b/i.test(normalized)) return null;
  if (heading.level !== 2 && !(heading.level === 3 && hasNumberedToolPrefix(heading.text))) {
    return null;
  }
  return stripAccents(cleanName.split(":")[0])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function countDevelopedToolSections(headings = []) {
  const keys = new Set();
  for (const heading of headings) {
    const key = developedToolHeadingKey(heading);
    if (key) keys.add(key);
  }
  return keys.size;
}

function countTableListItems(markdown = "") {
  const lines = String(markdown || "").split(/\r?\n/);
  let inRelevantTable = false;
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      inRelevantTable = false;
      continue;
    }
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const joined = stripAccents(cells.join(" ")).toLowerCase();
    if (/herramienta|producto|tool|nombre|name/.test(joined)) {
      inRelevantTable = true;
      continue;
    }
    if (/^-+$/.test(cells.join("").replace(/\s/g, ""))) continue;
    if (inRelevantTable && !isGenericListicleHeading(cells[0]) && cleanToolHeadingName(cells[0])) {
      count++;
    }
  }
  return count;
}

function detectListCountMismatch(article = {}) {
  const expected = expectedListCountFromTitle(article.title || "");
  if (!expected) return null;

  const headings = extractHeadings(article.content_markdown || "");
  const tableCount = countTableListItems(article.content_markdown || "");
  let found;

  if (normalizeLanguage(article.language) === "es") {
    const developedHeadingCount = countDevelopedToolSections(headings);
    found = developedHeadingCount > 0 ? developedHeadingCount : tableCount;
  } else {
    const toolHeadings = [];
    for (const heading of headings) {
      const cleanName = cleanToolHeadingName(heading.text);
      if (!cleanName || isGenericListicleHeading(heading.text)) continue;
      if (/^(?:que|cual|cuando|donde|por que|como)\b/i.test(stripAccents(cleanName))) continue;
      toolHeadings.push(cleanName.toLowerCase());
    }
    const headingCount = new Set(toolHeadings).size;
    found = Math.max(headingCount, tableCount);
  }

  if (found >= expected) return null;
  return { expected, found };
}

function detectStaleReferences(article = {}) {
  const title = article.title || "";
  const markdown = article.content_markdown || "";
  const isCurrentYearArticle = /\b2026\b/.test(`${title}\n${markdown}`);
  if (!isCurrentYearArticle) return [];
  const visible = visibleMarkdownText(markdown);
  const matches = [];
  for (const pattern of STALE_REFERENCE_PATTERNS) {
    for (const match of visible.matchAll(pattern.re)) {
      matches.push({ phrase: pattern.phrase, value: match[0] });
    }
  }
  return matches;
}

function countSourceLinks(markdown = "") {
  const text = String(markdown || "");
  const markdownLinks = text.match(/\[[^\]]+\]\(https?:\/\/[^)]+\)/gi) || [];
  const withoutMarkdownLinks = text.replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/gi, " ");
  const rawUrls = withoutMarkdownLinks.match(/https?:\/\/\S+/gi) || [];
  return markdownLinks.length + rawUrls.length;
}

function hasSourceLink(markdown = "") {
  return countSourceLinks(markdown) > 0;
}

function detectUnsupportedQuantitativeClaims(article = {}) {
  if (normalizeLanguage(article.language) !== "es") return [];
  const markdown = article.content_markdown || "";
  const visible = visibleMarkdownText(markdown);
  const matches = [];
  for (const pattern of UNSUPPORTED_QUANTITATIVE_CLAIM_PATTERNS) {
    for (const match of visible.matchAll(pattern.re)) {
      matches.push({ phrase: pattern.phrase, value: match[0] });
    }
  }
  if (matches.length === 0 || countSourceLinks(markdown) > 0) return [];
  return matches;
}

function detectUnsupportedClaims(article = {}) {
  const markdown = article.content_markdown || "";
  if (hasSourceLink(markdown)) return [];
  const visible = visibleMarkdownText(markdown);
  const matches = [];
  for (const pattern of UNSUPPORTED_CLAIM_PATTERNS) {
    for (const match of visible.matchAll(pattern.re)) {
      matches.push({ phrase: pattern.phrase, value: match[0] });
    }
  }
  return matches;
}

function issueObject(code, message, recommendation, repairable = true) {
  return {
    code,
    message,
    severity: "blocking",
    repairable,
    recommendation,
  };
}

function detectSpanishQualityIssues(article = {}) {
  const issues = [];
  const language = normalizeLanguage(article.language);
  if (language !== "es") return issues;

  const englishResidual = detectVisibleEnglishResidual(article.content_markdown || "", language);
  if (englishResidual.length > 0) {
    const found = uniqueMatches(englishResidual)
      .map((match) => `${match.phrase} (${match.count})`)
      .join(", ");
    issues.push(
      issueObject(
        "english_residual",
        `visible English residual in Spanish article: ${found}`,
        "rewrite visible headings and labels in Spanish before publishing"
      )
    );
  }

  const listMismatch = detectListCountMismatch(article);
  if (listMismatch) {
    issues.push(
      issueObject(
        "list_count_mismatch",
        `title promises ${listMismatch.expected} tools but only ${listMismatch.found} were developed`,
        "regenerate or expand the draft so the title count matches fully developed tools"
      )
    );
  }

  const staleReferences = detectStaleReferences(article);
  if (staleReferences.length > 0) {
    const found = uniqueMatches(staleReferences)
      .map((match) => `${match.phrase} (${match.count})`)
      .join(", ");
    issues.push(
      issueObject(
        "stale_reference",
        `stale reference in 2026 Spanish article: ${found}`,
        "replace outdated source/current-date references with 2026-safe wording or a current source"
      )
    );
  }

  const unsupportedQuantitativeClaims = detectUnsupportedQuantitativeClaims(article);
  if (unsupportedQuantitativeClaims.length > 0) {
    const found = Array.from(new Set(unsupportedQuantitativeClaims.map((match) => match.value)))
      .map((value) => {
        const count = unsupportedQuantitativeClaims.filter((match) => match.value === value).length;
        return `${value} (${count})`;
      })
      .join(", ");
    issues.push(
      issueObject(
        "unsupported_quantitative_claim",
        `unsupported quantitative claim(s) without source link: ${found}`,
        "remove unsourced percentages/data claims or add a verifiable source link before publishing"
      )
    );
  }

  const unsupportedClaims = detectUnsupportedClaims(article);
  if (unsupportedClaims.length > 0) {
    const found = Array.from(new Set(unsupportedClaims.map((match) => match.value)))
      .map((value) => {
        const count = unsupportedClaims.filter((match) => match.value === value).length;
        return `${value} (${count})`;
      })
      .join(", ");
    issues.push(
      issueObject(
        "unsupported_claim",
        `unsupported strong claim(s) without source link: ${found}`,
        "remove first-party testing/market-share claims or add a verifiable source before publishing"
      )
    );
  }

  return issues;
}

function cleanupAiTellPhrases(markdown = "") {
  let text = String(markdown || "");
  const before = detectAiTellPhrases(text);
  for (const pattern of AI_TELL_PATTERNS) {
    text = text.replace(pattern.re, pattern.replacement);
  }
  const after = detectAiTellPhrases(text);
  return {
    text,
    before,
    removed: uniqueMatches(before),
    remaining: uniqueMatches(after),
    changed: text !== String(markdown || ""),
  };
}

function repairToolPlaceholders(markdown = "", replacements = {}) {
  let text = String(markdown || "");
  const merged = { ...DEFAULT_TOOL_PLACEHOLDER_REPLACEMENTS, ...replacements };
  const before = detectToolPlaceholders(text);
  const applied = [];

  for (const pattern of TOOL_PLACEHOLDER_PATTERNS) {
    const replacement = merged[pattern.key];
    if (!replacement) continue;
    let count = 0;
    text = text.replace(pattern.re, () => {
      count += 1;
      return replacement;
    });
    if (count > 0) {
      applied.push({
        phrase: pattern.phrase,
        replacement,
        count,
      });
    }
  }

  const after = detectToolPlaceholders(text);
  return {
    text,
    before: uniqueMatches(before),
    replacements: applied,
    remaining: uniqueMatches(after),
    changed: text !== String(markdown || ""),
  };
}

// Deterministic Spanish-residual repair. The generation prompt instructs Spanish
// headings/labels, but the model occasionally leaks an English one the QA gate
// then (correctly) blocks (e.g. "## FAQ", "Quick Verdict", "Pricing"). Rather
// than fail/regenerate a whole article over a cosmetic slip, map the known
// English labels/headings to Spanish BEFORE QA. Mirrors repairToolPlaceholders.
// Only the exact patterns the QA gate flags are mapped, and fenced code blocks
// are left untouched.
const SPANISH_RESIDUAL_HEADING_MAP = [
  { phrase: "FAQ", re: /^(\s*#{2,6}\s*)FAQ\s*:?\s*$/gim, to: "$1Preguntas frecuentes" },
  { phrase: "Pros (heading)", re: /^(\s*#{2,6}\s*)Pros\s*:?\s*$/gim, to: "$1Ventajas" },
  { phrase: "Cons (heading)", re: /^(\s*#{2,6}\s*)Cons\s*:?\s*$/gim, to: "$1Desventajas" },
];
const SPANISH_RESIDUAL_LABEL_MAP = [
  { phrase: "Pros and Cons", re: /\bPros and Cons\b/g, to: "Ventajas y desventajas" },
  { phrase: "Quick Picks", re: /\bQuick Picks\b/g, to: "Selección rápida" },
  { phrase: "Final Verdict", re: /\bFinal Verdict\b/g, to: "Veredicto final" },
  { phrase: "Quick Verdict", re: /\bQuick Verdict\b/g, to: "Veredicto rápido" },
  { phrase: "Key Takeaways", re: /\bKey Takeaways\b/g, to: "Puntos clave" },
  { phrase: "Key fact", re: /\bKey fact\b/g, to: "Dato clave" },
  { phrase: "Pricing", re: /\bPricing\b/g, to: "Precios" },
  { phrase: "Features", re: /\bFeatures\b/g, to: "Características" },
  { phrase: "Overview", re: /\bOverview\b/g, to: "Resumen" },
  { phrase: "Best for", re: /\bBest for\b/g, to: "Mejor para" },
  { phrase: "Use cases", re: /\bUse cases\b/g, to: "Casos de uso" },
];

// Deterministic list-count repair. The #1 listicle QA failure is "title promises
// N tools but only M were developed" (the model under-delivers). Rather than fail
// or regenerate a whole article, lower the title's promised count to the number
// actually developed — honest and accurate ("7 Mejores IAs" → "5 Mejores IAs").
// Only fires when at least 3 real tools were developed (fewer = genuinely thin,
// let it fail). Returns { title, changed, from, to }.
function repairListCountTitle(article = {}) {
  const mismatch = detectListCountMismatch(article);
  if (!mismatch) return { title: article.title, changed: false };
  const { expected, found } = mismatch;
  if (found < 3 || found >= expected) return { title: article.title, changed: false };
  const title = String(article.title || "");
  const re = new RegExp(`\\b${expected}\\b`, "g");
  const matches = title.match(re);
  // Only rewrite when the promised number appears EXACTLY once — otherwise a
  // single replacement would contradict the other occurrence ("4 Mejores… solo
  // 7 valen"). Absent or ambiguous → leave the title alone.
  if (!matches || matches.length !== 1) return { title, changed: false };
  const next = title.replace(re, String(found));
  return { title: next, changed: next !== title, from: expected, to: found };
}

function repairSpanishResidual(markdown = "", language = "es") {
  if (normalizeLanguage(language) !== "es") {
    return { text: String(markdown || ""), changed: false, replaced: [] };
  }
  // Split out fenced code blocks so we never rewrite code samples.
  const segments = String(markdown || "").split(/(```[\s\S]*?```)/g);
  const replaced = [];
  const out = segments.map((segment) => {
    if (segment.startsWith("```")) return segment; // code fence — leave untouched
    let text = segment;
    for (const h of SPANISH_RESIDUAL_HEADING_MAP) {
      let count = 0;
      text = text.replace(h.re, (...m) => {
        count += 1;
        return `${m[1]}${h.to.replace("$1", "")}`;
      });
      if (count > 0) replaced.push({ phrase: h.phrase, count, to: h.to.replace("$1", "") });
    }
    for (const l of SPANISH_RESIDUAL_LABEL_MAP) {
      let count = 0;
      text = text.replace(l.re, () => {
        count += 1;
        return l.to;
      });
      if (count > 0) replaced.push({ phrase: l.phrase, count, to: l.to });
    }
    return text;
  });
  const text = out.join("");
  return { text, changed: text !== String(markdown || ""), replaced };
}

function formatAiTellIssue(markdown = "") {
  const matches = detectAiTellPhrases(markdown);
  if (matches.length === 0) return null;
  return `${matches.length} AI-tell phrases (polish step didn't scrub)`;
}

function formatToolPlaceholderIssue(markdown = "") {
  const matches = detectToolPlaceholders(markdown);
  if (matches.length === 0) return null;
  const found = uniqueMatches(matches)
    .map((match) => `${match.phrase} (${match.count})`)
    .join(", ");
  return `${matches.length} unresolved tool/product placeholder(s): ${found}`;
}

function hasFaqSection(markdown, language = "en") {
  if (normalizeLanguage(language) === "es") {
    return /^##\s+(?:Preguntas frecuentes|Preguntas comunes)/im.test(markdown || "");
  }
  return /^##\s+(?:FAQ|Frequently Asked Questions|Common Questions)/im.test(markdown || "");
}

function detectLanguageMismatch(markdown, expectedLanguage = "en") {
  const md = markdown || "";
  const lang = normalizeLanguage(expectedLanguage);
  const spanishSignals = [
    /\b(?:que|para|como|cu[aá]l|herramientas|gratis|negocio|precio|preguntas)\b/i,
    /[¿¡áéíóúñ]/i,
  ];
  const englishSignals = [/\b(?:the|for|with|pricing|best|tools|business|review|comparison)\b/i];
  const hasSpanish = spanishSignals.some((re) => re.test(md));
  const hasEnglish = englishSignals.some((re) => re.test(md));
  if (lang === "es" && hasEnglish && !hasSpanish) return "expected Spanish content";
  if (lang === "en" && hasSpanish && !hasEnglish) return "expected English content";
  return null;
}

function qualityGate(article = {}) {
  const issues = [];
  const markdown = article.content_markdown || "";
  const language = normalizeLanguage(article.language);
  const wordCount = Number(article.word_count || markdown.split(/\s+/).filter(Boolean).length || 0);

  if (wordCount < 1100) {
    issues.push({
      code: "too_short",
      message: `too short: ${wordCount}w (min 1100)`,
      severity: "blocking",
      repairable: true,
      recommendation: "regenerate or expand draft before publishing",
    });
  }

  if (!hasFaqSection(markdown, language)) {
    issues.push({
      code: "missing_faq",
      message: "missing FAQ section (needed for schema)",
      severity: "blocking",
      repairable: true,
      recommendation: "add localized FAQ section",
    });
  }

  if (article.primary_keyword) {
    const body = markdown.toLowerCase();
    const keyword = String(article.primary_keyword).toLowerCase().trim();
    const words = keyword.split(/\s+/).filter((w) => w.length >= 4);
    const coverage =
      words.length === 0 ? 1 : words.filter((word) => body.includes(word)).length / words.length;
    if (!body.includes(keyword) && coverage < 0.7) {
      issues.push({
        code: "missing_keyword",
        message: `keyword "${keyword}" never appears verbatim and only ${Math.round(
          coverage * 100
        )}% of words present (min 70%)`,
        severity: "blocking",
        repairable: true,
        recommendation: "regenerate with primary keyword coverage",
      });
    }
  }

  const mismatch = detectLanguageMismatch(markdown, language);
  if (mismatch) {
    issues.push({
      code: "language_mismatch",
      message: mismatch,
      severity: "blocking",
      repairable: true,
      recommendation: "regenerate in the expected language",
    });
  }

  const aiTellMessage = formatAiTellIssue(markdown);
  if (aiTellMessage) {
    issues.push({
      code: "ai_tells",
      message: aiTellMessage,
      severity: "blocking",
      repairable: true,
      recommendation: "run AI-tell cleanup and targeted repair before publishing",
    });
  }

  const placeholderMessage = formatToolPlaceholderIssue(markdown);
  if (placeholderMessage) {
    issues.push({
      code: "tool_placeholders",
      message: placeholderMessage,
      severity: "blocking",
      repairable: true,
      recommendation: "replace placeholders with real product names before publishing",
    });
  }

  issues.push(...detectSpanishQualityIssues(article));

  return {
    pass: issues.length === 0,
    issues,
    severity: issues.some((issue) => issue.severity === "blocking") ? "blocking" : "none",
    repairable: issues.every((issue) => issue.repairable),
    recommendation:
      issues.length === 0
        ? "publishable"
        : Array.from(new Set(issues.map((issue) => issue.recommendation))).join("; "),
  };
}

function issueMessages(qa) {
  return (qa.issues || []).map((issue) =>
    typeof issue === "string" ? issue : issue.message || issue.code
  );
}

module.exports = {
  AI_TELL_PHRASES,
  DEFAULT_TOOL_PLACEHOLDER_REPLACEMENTS,
  TOOL_PLACEHOLDER_PATTERNS,
  cleanupAiTellPhrases,
  detectAiTellPhrases,
  detectListCountMismatch,
  detectSpanishQualityIssues,
  detectStaleReferences,
  detectToolPlaceholders,
  detectUnsupportedQuantitativeClaims,
  detectUnsupportedClaims,
  detectVisibleEnglishResidual,
  formatAiTellIssue,
  formatToolPlaceholderIssue,
  qualityGate,
  repairToolPlaceholders,
  repairSpanishResidual,
  repairListCountTitle,
  issueMessages,
  hasFaqSection,
  detectLanguageMismatch,
};
