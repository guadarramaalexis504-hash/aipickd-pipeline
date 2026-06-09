"use strict";

const { normalizeLanguage } = require("./spanish-gate");

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
  qualityGate,
  issueMessages,
  hasFaqSection,
  detectLanguageMismatch,
};
