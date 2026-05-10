#!/usr/bin/env node
/**
 * AIPickd — Auto alt-text generator (gpt-4o-mini vision).
 *
 * Finds published articles whose featured image is missing alt text in
 * WordPress, asks gpt-4o-mini to describe each in ≤120 chars, and
 * updates the WP media row. Improves SEO + accessibility.
 *
 * Caps:
 *   - Max 20 images per run (safety against runaway cost).
 *   - $0.0001 per image roughly — full run < $0.005.
 *
 * Usage:
 *   node scripts/auto-alt-text.js          # dry-run
 *   node scripts/auto-alt-text.js --fix    # actually update WP
 */

const { loadEnv } = require("./lib/env");
const { wp } = require("./lib/clients");
const { fetchWithRetry } = require("./lib/http");
const log = require("./lib/log").create({ script: "auto-alt-text" });

const env = loadEnv();
const FIX = process.argv.includes("--fix");
const MAX_IMAGES = 20;

async function describeImage(imageUrl) {
  const res = await fetchWithRetry(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 60,
        messages: [
          {
            role: "system",
            content:
              "Write a concise, descriptive alt text in English for the image, ≤120 chars. " +
              "Focus on what's visible. No 'image of' or 'picture of'. No quotes.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Generate alt text:" },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
    },
    { timeout: 30000, retries: 2 }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const alt = data?.choices?.[0]?.message?.content?.trim() || "";
  return alt.replace(/^["']|["']$/g, "").slice(0, 120);
}

(async () => {
  log.info("Starting auto alt-text run", { fix: FIX, max: MAX_IMAGES });
  if (!env.OPENAI_API_KEY) {
    log.error("OPENAI_API_KEY required");
    process.exit(2);
  }

  // Find media items without alt text. WP REST: /media?_fields=id,alt_text,source_url&per_page=50
  const media = await wp("GET", `media?per_page=${MAX_IMAGES * 4}&_fields=id,alt_text,source_url,post`);
  if (!Array.isArray(media)) {
    log.error("WP media list returned non-array");
    process.exit(2);
  }

  const missing = media.filter((m) => !m.alt_text || m.alt_text.trim() === "");
  log.info("Found media items", { total: media.length, missing: missing.length });

  if (missing.length === 0) {
    log.info("All media has alt text — nothing to do");
    return;
  }

  const candidates = missing.slice(0, MAX_IMAGES);
  let updated = 0;
  let failed = 0;

  for (const m of candidates) {
    try {
      const alt = await describeImage(m.source_url);
      if (!alt) {
        log.warn("Empty alt returned; skipping", { mediaId: m.id });
        continue;
      }
      log.info("Generated alt", { mediaId: m.id, post: m.post, preview: alt.slice(0, 60) });
      if (FIX) {
        await wp("POST", `media/${m.id}`, { alt_text: alt });
        updated++;
      }
    } catch (e) {
      failed++;
      log.error("Image failed", { mediaId: m.id, err: e.message });
    }
  }

  log.info("Run complete", {
    candidates: candidates.length,
    updated,
    failed,
    dryRun: !FIX,
  });
})().catch((e) => {
  log.error("Fatal", { err: e.message });
  process.exit(1);
});
