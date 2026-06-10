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
  return /^(faq|preguntas|conclusion|comparativa|como elegimos|como elegir|mas herramientas|quick picks|veredicto|puntos clave|tabla|precio|pros|contras|ventajas|desventajas|caracteristicas|aspectos|metodologia|resumen)\b/.test(
    normalized
  );
}

function expectedListCountFromTitle(title = "") {
  const match = String(title || "").match(/\b(\d{1,2})\s+(?:mejores|mejor|best|top)\b/i);
  return match ? Number(match[1]) : 0;
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
  const toolHeadings = [];
  for (const heading of headings) {
    const cleanName = cleanToolHeadingName(heading.text);
    if (!cleanName || isGenericListicleHeading(heading.text)) continue;
    if (/^(?:que|cual|cuando|donde|por que|como)\b/i.test(stripAccents(cleanName))) continue;
    toolHeadings.push(cleanName.toLowerCase());
  }

  const headingCount = new Set(toolHeadings).size;
  const tableCount = countTableListItems(article.content_markdown || "");
  const found = Math.max(headingCount, tableCount);
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

function hasSourceLink(markdown = "") {
  return /\[[^\]]+\]\(https?:\/\/[^)]+\)/i.test(markdown) || /https?:\/\/\S+/i.test(markdown);
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
        `listicle count mismatch: expected ${listMismatch.expected} developed tools/items, found ${listMismatch.found}`,
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
    return /^##\s+(?:FAQ|Preguntas frecuentes|Preguntas comunes)/im.test(markdown || "");
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
  detectUnsupportedClaims,
  detectVisibleEnglishResidual,
  formatAiTellIssue,
  formatToolPlaceholderIssue,
  qualityGate,
  repairToolPlaceholders,
  issueMessages,
  hasFaqSection,
  detectLanguageMismatch,
};
