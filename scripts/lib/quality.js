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

function formatAiTellIssue(markdown = "") {
  const matches = detectAiTellPhrases(markdown);
  if (matches.length === 0) return null;
  return `${matches.length} AI-tell phrases (polish step didn't scrub)`;
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
  cleanupAiTellPhrases,
  detectAiTellPhrases,
  formatAiTellIssue,
  qualityGate,
  issueMessages,
  hasFaqSection,
  detectLanguageMismatch,
};
