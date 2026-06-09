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

async function readOnlyProbe() {
  const posts = await wpPublic("posts?per_page=20&status=publish&_fields=id,slug,link,meta,lang,pll_language");
  const candidates = (Array.isArray(posts) ? posts : []).filter((post) => {
    const meta = post.meta || {};
    return meta._pipeline_lang === "es" || post.lang === "es" || post.pll_language === "es" || (post.link || "").includes("/es/");
  });
  return { candidates, verified: candidates.some(postLooksSpanish) };
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
    console.log("Language bridge verified from existing posts.");
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
