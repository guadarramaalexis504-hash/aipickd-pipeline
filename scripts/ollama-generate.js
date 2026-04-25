#!/usr/bin/env node
/**
 * AIPickd — Generate articles using LOCAL Ollama (FREE, no OpenAI)
 *
 * Uses Llama 3.1 8B running locally on your laptop.
 * Cost per article: $0.00 (vs ~$0.06 with OpenAI)
 *
 * Setup: just run scripts/install-power-user.ps1 first to install Ollama.
 *
 * Usage:
 *   node scripts/ollama-generate.js                  # 1 article
 *   node scripts/ollama-generate.js --gen 5          # 5 articles
 *   node scripts/ollama-generate.js --no-pub         # generate only, no publish
 *
 * Model: llama3.1:8b (adjustable via OLLAMA_MODEL env)
 * Ollama API: http://localhost:11434
 */

const fs = require("fs");
const path = require("path");
const { notify } = require("./notify.js");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  WP_USERNAME,
  WP_ADMIN_PASSWORD,
  AUTO_PUBLISH,
  OLLAMA_URL = "http://localhost:11434",
  OLLAMA_MODEL = "llama3.1:8b",
} = env;

const WP_STATUS = (AUTO_PUBLISH || "false").toLowerCase() === "true" ? "publish" : "draft";
const args = process.argv.slice(2);
const GEN_COUNT = parseInt(args[args.indexOf("--gen") + 1]) || 1;
const DO_PUBLISH = !args.includes("--no-pub");

async function supa(method, endpoint, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supa: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function wp(method, endpoint, body) {
  const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
  const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WP: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function ollama(prompt, options = {}) {
  // Use streaming to avoid idle timeouts on slow CPU generation
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: true,
      keep_alive: "30m", // keep model loaded for 30 min
      options: {
        temperature: 0.7,
        num_predict: options.maxTokens || 2000,
        ...options,
      },
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

  // Parse streaming JSON lines
  let fullText = "";
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  let tokensReceived = 0;
  const startTime = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line);
        if (chunk.response) {
          fullText += chunk.response;
          tokensReceived++;
          if (tokensReceived % 50 === 0) {
            const secs = ((Date.now() - startTime) / 1000).toFixed(0);
            process.stdout.write(`\r   ... ${tokensReceived} tokens (${secs}s)`);
          }
        }
        if (chunk.done) {
          process.stdout.write("\n");
          return fullText;
        }
      } catch { /* partial JSON, continue */ }
    }
  }
  return fullText;
}

async function ollamaJSON(prompt) {
  const text = await ollama(prompt + "\n\nOutput JSON only. No preamble. No explanation.");
  // Try to extract JSON
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in Ollama response");
  return JSON.parse(match[0]);
}

function mdToHtml(md) {
  md = (md || "").replace(/<!--[\s\S]*?-->/g, "");
  let html = md;
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*([^\*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^\*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="nofollow sponsored" target="_blank">$1</a>');
  html = html.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>\n${m}</ul>\n`);
  html = html.split("\n\n").map((b) => {
    const t = b.trim();
    if (!t) return "";
    if (/^<(h[1-6]|ul|ol|blockquote|table|pre|div)/i.test(t)) return t;
    return `<p>${t}</p>`;
  }).join("\n\n");
  return html;
}

function aggressiveClean(md) {
  let out = md || "";
  out = out.replace(/\[AFFILIATE:[^\]]+\]([^\[]*)\[\/AFFILIATE\]/gi, "$1");
  out = out.replace(/\[AFFILIATE:[^\]]+\]/gi, "");
  out = out.replace(/\[\/AFFILIATE\]/gi, "");
  return out;
}

async function generateOne() {
  const kws = await supa(
    "GET",
    "keywords?status=eq.queued&assigned_article_id=is.null&order=priority.desc&limit=1&select=*,niche:niches(slug,name)"
  );
  if (!kws || kws.length === 0) return { skipped: true };
  const kw = kws[0];
  console.log(`   📝 "${kw.keyword}" (${kw.niche?.name})`);
  await supa("PATCH", `keywords?id=eq.${kw.id}`, { status: "in_progress" });

  try {
    // Phase 1: Outline (JSON) — short prompt, small output
    console.log("   🧠 Outlining...");
    const outlineText = await ollama(`Generate a JSON SEO outline for this keyword. Current date: April 2026.

Keyword: ${kw.keyword}
Article type: ${kw.article_type}

Output ONLY valid JSON (no markdown, no explanation) with keys: title (50-60 chars with "2026"), slug (kebab-case), meta_description (150-160 chars), sections (array of 5 objects with heading+bullets array), faqs (array of 3 question strings).`, { maxTokens: 1000 });

    const jsonMatch = outlineText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in outline response");
    const outline = JSON.parse(jsonMatch[0]);

    // Phase 2: Write full article
    console.log("   ✍️  Writing article...");
    const draft = await ollama(`Write a complete 2000-word article based on this outline. Current date: April 2026.

Title: ${outline.title}
Slug: ${outline.slug}

Sections to cover:
${JSON.stringify(outline.sections, null, 2)}

FAQs to answer:
${JSON.stringify(outline.faqs, null, 2)}

Rules:
1. Start with # H1 title, then a Quick verdict blockquote (> Quick verdict: ...), then intro paragraph
2. Each section: ## heading, then 2-3 paragraphs of real content
3. Include pros AND cons where applicable
4. Avoid AI-tells: "in today's fast-paced world", "revolutionary", "game-changer"
5. Use 2nd person (you), active voice, contractions OK
6. End with ## Frequently Asked Questions section answering the FAQs
7. Write real substantive content, not filler

Output: pure markdown, no commentary before or after.`, { maxTokens: 6000 });

    const cleaned = aggressiveClean(draft);

    // Get affiliates (none active likely)
    const affiliates = await supa("GET", "affiliates?status=eq.active");
    const affiliatesUsed = new Set();

    const inserted = await supa("POST", "articles", {
      keyword_id: kw.id,
      niche_id: kw.niche_id,
      title: outline.title,
      slug: outline.slug,
      meta_description: outline.meta_description,
      content_markdown: cleaned,
      article_type: kw.article_type,
      status: "draft",
      generated_by: "ollama-llama3.1-8b",
      word_count: cleaned.split(/\s+/).length,
      generation_cost_usd: 0, // FREE!
      affiliates_mentioned: [...affiliatesUsed],
    });
    const article = Array.isArray(inserted) ? inserted[0] : inserted;
    await supa("PATCH", `keywords?id=eq.${kw.id}`, {
      status: "published",
      assigned_article_id: article.id,
    });

    return { article, title: outline.title, words: article.word_count };
  } catch (e) {
    await supa("PATCH", `keywords?id=eq.${kw.id}`, { status: "queued" });
    throw e;
  }
}

async function publishAllDrafts() {
  const drafts = await supa("GET", "articles?status=eq.draft&order=created_at.asc&limit=20");
  if (!drafts || drafts.length === 0) return 0;
  let ok = 0;
  for (const a of drafts) {
    try {
      const html = mdToHtml(aggressiveClean(a.content_markdown));
      const wpPost = await wp("POST", "posts", {
        title: a.title, slug: a.slug, excerpt: a.meta_description || "",
        content: html, status: WP_STATUS,
      });
      await supa("PATCH", `articles?id=eq.${a.id}`, {
        status: WP_STATUS === "publish" ? "published" : "pending_review",
        wp_post_id: wpPost.id, wp_url: wpPost.link,
        published_at: new Date().toISOString(),
      });
      ok++;
      console.log(`   ✓ WP #${wpPost.id}: ${a.title.slice(0, 55)}`);
      if (WP_STATUS === "publish") notify(`📝 New article LIVE (Ollama): ${a.title}\n${wpPost.link}`).catch(() => {});
    } catch (e) {
      console.log(`   ✗ ${e.message.slice(0, 80)}`);
    }
  }
  return ok;
}

(async () => {
  const start = Date.now();
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  🦙 Ollama Pipeline — ${new Date().toISOString()}`);
  console.log(`  Model: ${OLLAMA_MODEL}  |  Cost: $0.00 💰`);
  console.log("═══════════════════════════════════════════════════════\n");

  // Verify Ollama is up
  try {
    const ping = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await ping.json();
    const models = (data.models || []).map((m) => m.name);
    if (!models.some((m) => m.includes(OLLAMA_MODEL.split(":")[0]))) {
      console.log(`❌ Model "${OLLAMA_MODEL}" not found. Run: ollama pull ${OLLAMA_MODEL}`);
      console.log(`   Available: ${models.join(", ")}`);
      process.exit(1);
    }
    console.log(`✅ Ollama connected. Available models: ${models.join(", ")}\n`);
  } catch (e) {
    console.log(`❌ Ollama not reachable at ${OLLAMA_URL}`);
    console.log(`   Make sure Ollama is running: launch the Ollama app`);
    process.exit(1);
  }

  let generated = 0;
  console.log(`🧠 GENERATION (×${GEN_COUNT}) via local Llama`);
  for (let i = 0; i < GEN_COUNT; i++) {
    try {
      const res = await generateOne();
      if (res.skipped) { console.log(`   [${i + 1}/${GEN_COUNT}] skip (no queued keywords)`); break; }
      generated++;
      console.log(`   [${i + 1}/${GEN_COUNT}] ✅ "${res.title}" (${res.words}w)`);
    } catch (e) {
      console.log(`   [${i + 1}/${GEN_COUNT}] ❌ ${e.message.slice(0, 120)}`);
    }
  }
  console.log();

  let published = 0;
  if (DO_PUBLISH) {
    console.log("📤 PUBLISHING");
    published = await publishAllDrafts();
    console.log(`   Published ${published}\n`);
  }

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  ✅ DONE in ${secs}s  |  Generated: ${generated}  |  Cost: $0.00 💰`);
  console.log("═══════════════════════════════════════════════════════");
})().catch((e) => { console.error("❌ FATAL:", e.message); process.exit(1); });
