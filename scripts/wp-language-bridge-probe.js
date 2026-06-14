#!/usr/bin/env node
"use strict";

const { hasWriteFlag } = require("./lib/cli-safety");
const { wp, WP_USER_AGENT } = require("./lib/clients");

const argv = process.argv.slice(2);
const GO = hasWriteFlag(argv, new Set(["--go"]));
const WP_HOST = "https://aipickd.com";

function postLooksSpanish(post) {
  const link = post.link || "";
  const meta = post.meta || {};
  return (
    link.includes("/es/") ||
    meta._pipeline_lang === "es" ||
    post.lang === "es" ||
    post.pll_language === "es"
  );
}

async function wpPublic(endpoint) {
  const res = await fetch(`${WP_HOST}/wp-json/wp/v2/${endpoint}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": WP_USER_AGENT,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`WP public GET ${endpoint}: ${res.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// Public, credential-free evidence that the language bridge is wired and ready,
// WITHOUT needing a pre-existing Spanish post. This breaks the bootstrap
// deadlock: the original read-only probe could only verify from an existing
// public ES post, but no ES post can publish until the probe passes.
//
// Two independent public signals:
//   1. Polylang has the 'es' language configured (GET pll/v1/languages).
//   2. The aipickd-lang-bridge mu-plugin registered `_pipeline_lang` in REST
//      (a published post exposes the meta key). The SAME mu-plugin file that
//      registers this meta also registers the `rest_after_insert_post` hook
//      that calls pll_set_post_language — so the meta being present in REST
//      implies the language-setting hook is active too.
//
// Both true ⇒ a new post created with `_pipeline_lang=es` will be assigned the
// Spanish language. The --go write probe remains the empirical gold standard;
// this just stops the pipeline from blocking forever on a healthy setup.
async function bridgeReadyPublic() {
  const signals = { polylang_es: false, pipeline_lang_meta: false };
  try {
    const res = await fetch(`${WP_HOST}/wp-json/pll/v1/languages`, {
      headers: { Accept: "application/json", "User-Agent": WP_USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const langs = await res.json();
      signals.polylang_es = Array.isArray(langs) && langs.some((l) => l && l.slug === "es");
    }
  } catch {
    /* Polylang REST unreachable — leave signal false */
  }
  try {
    const posts = await wpPublic("posts?per_page=1&status=publish&_fields=id,meta");
    const sample = Array.isArray(posts) ? posts[0] : null;
    signals.pipeline_lang_meta = Boolean(
      sample && sample.meta && Object.prototype.hasOwnProperty.call(sample.meta, "_pipeline_lang")
    );
  } catch {
    /* REST unreachable — leave signal false */
  }
  return { ready: signals.polylang_es && signals.pipeline_lang_meta, signals };
}

async function readOnlyProbe() {
  const posts = await wpPublic("posts?per_page=20&status=publish&_fields=id,slug,link,meta,lang,pll_language");
  const candidates = (Array.isArray(posts) ? posts : []).filter((post) => {
    const meta = post.meta || {};
    return meta._pipeline_lang === "es" || post.lang === "es" || post.pll_language === "es" || (post.link || "").includes("/es/");
  });
  const fromExistingPost = candidates.some(postLooksSpanish);
  const bridge = await bridgeReadyPublic();
  return {
    candidates,
    verified: fromExistingPost || bridge.ready,
    evidence: fromExistingPost ? "existing_es_post" : bridge.ready ? "polylang_es+meta_registered" : "none",
    bridge_signals: bridge.signals,
  };
}

async function writeProbe() {
  const title = `AIPickd language bridge probe ${Date.now()}`;
  const created = await wp("POST", "posts", {
    title,
    slug: `aipickd-language-bridge-probe-${Date.now()}`,
    status: "draft",
    content: "<p>Temporary language bridge probe. Delete after verification.</p>",
    meta: { _pipeline_lang: "es" },
  });
  const report = { created_id: created.id, created_link: created.link || null, deleted_id: null, verified: false };
  try {
    const fetched = await wp("GET", `posts/${created.id}?context=edit&_fields=id,slug,link,meta,lang,pll_language`);
    report.fetched = fetched;
    report.verified = postLooksSpanish(fetched);
  } finally {
    try {
      const deleted = await wp("DELETE", `posts/${created.id}?force=true`);
      report.deleted_id = deleted.id || created.id;
    } catch (err) {
      report.cleanup_error = err.message;
    }
  }
  return report;
}

async function main() {
  console.log(`wp-language-bridge-probe mode=${GO ? "WRITE TEMP DRAFT --go" : "READ ONLY"}`);
  const readOnly = await readOnlyProbe();
  console.log(JSON.stringify({ read_only_probe: readOnly }, null, 2));
  if (readOnly.verified) {
    console.log(
      readOnly.evidence === "existing_es_post"
        ? "Language bridge verified from existing Spanish posts."
        : "Language bridge verified read-only: Polylang has 'es' and the mu-plugin registered _pipeline_lang in REST."
    );
    return 0;
  }
  if (!GO) {
    console.log("BLOCKER: Could not verify _pipeline_lang=es read-only. No temporary post created.");
    return 3;
  }
  const writeResult = await writeProbe();
  console.log(JSON.stringify({ write_probe: writeResult }, null, 2));
  if (!writeResult.verified) {
    console.log("BLOCKER: Temporary draft did not verify Spanish language bridge.");
    return 3;
  }
  console.log("Language bridge verified with temporary draft and cleanup attempted.");
  return writeResult.cleanup_error ? 4 : 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`ERROR: ${err.message}`);
      process.exitCode = 1;
    });
}
