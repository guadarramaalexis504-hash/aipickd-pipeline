#!/usr/bin/env node
"use strict";

const { hasWriteFlag, readIntFlag } = require("./lib/cli-safety");
const { supa } = require("./lib/clients");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const MAX_RELEASE_LIMIT = 1;
const BRIDGE_CONFIRMATION = "WP_LANGUAGE_BRIDGE_VERIFIED";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readOption(argv, name, fallback = null) {
  const exactIdx = argv.indexOf(name);
  if (exactIdx !== -1) {
    const value = argv[exactIdx + 1];
    return value && !value.startsWith("--") ? value : fallback;
  }

  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

function normalizeBridgeRunId(value) {
  if (!value) return null;
  const runId = String(value).trim();
  return /^\d+$/.test(runId) ? runId : null;
}

function normalizeKeywordId(value) {
  if (!value) return null;
  const keywordId = String(value).trim();
  if (!UUID_RE.test(keywordId)) {
    throw new Error("--keyword-id must be a valid UUID.");
  }
  return keywordId;
}

function parseReleaseOptions(inputArgv = process.argv.slice(2)) {
  const argv = [...inputArgv];
  const requestedLimit = readIntFlag(argv, "--limit", 1);
  const bridgeRunId = normalizeBridgeRunId(readOption(argv, "--bridge-run-id", null));
  const bridgeConfirmation = readOption(argv, "--confirm-bridge", null);
  const bridgeVerified = argv.includes("--bridge-verified");
  const keywordId = normalizeKeywordId(readOption(argv, "--keyword-id", null));

  return {
    argv,
    go: hasWriteFlag(argv, new Set(["--go"])),
    requestedLimit,
    effectiveLimit: Math.min(requestedLimit, MAX_RELEASE_LIMIT),
    bridgeRunId,
    bridgeVerified,
    bridgeConfirmation,
    keywordId,
  };
}

function explicitBridgeEvidence(options) {
  if (options.bridgeRunId) {
    return {
      verified: true,
      source: `GitHub Actions run ${options.bridgeRunId} supplied via --bridge-run-id`,
    };
  }

  if (options.bridgeVerified && options.bridgeConfirmation === BRIDGE_CONFIRMATION) {
    return {
      verified: true,
      source: "explicit --bridge-verified confirmation supplied by operator",
    };
  }

  if (options.bridgeVerified || options.bridgeConfirmation) {
    return {
      verified: false,
      reason: `Incomplete bridge confirmation. Use --bridge-verified --confirm-bridge ${BRIDGE_CONFIRMATION}.`,
    };
  }

  return { verified: false, reason: null };
}

function resolveBridgeVerification(options, { readOnlyVerified = false } = {}) {
  if (readOnlyVerified) {
    return {
      verified: true,
      source: "read-only WordPress language bridge probe",
    };
  }

  const explicit = explicitBridgeEvidence(options);
  if (explicit.verified) return explicit;

  const suffix = explicit.reason ? ` ${explicit.reason}` : "";
  return {
    verified: false,
    reason:
      "blocked: read-only WordPress language bridge probe did not find published ES evidence " +
      "and no explicit bridge evidence was supplied (--bridge-run-id <id> or " +
      `--bridge-verified --confirm-bridge ${BRIDGE_CONFIRMATION}).${suffix}`,
  };
}

function selectKeywordsForRelease(keywords, options) {
  if (options.keywordId) {
    return keywords
      .filter((keyword) => keyword.id === options.keywordId)
      .slice(0, MAX_RELEASE_LIMIT);
  }
  return keywords.slice(0, options.effectiveLimit);
}

function buildReleaseKeywordEndpoint(options) {
  const select = "select=id,keyword,language,status,priority,search_volume,assigned_article_id";
  if (options.keywordId) {
    return `keywords?id=eq.${encodeURIComponent(
      options.keywordId
    )}&status=eq.es_hold&language=eq.es&assigned_article_id=is.null&limit=1&${select}`;
  }
  return `keywords?status=eq.es_hold&language=eq.es&assigned_article_id=is.null&order=priority.desc,search_volume.desc&limit=${options.effectiveLimit}&${select}`;
}

function buildReleaseAction(keyword) {
  return {
    id: keyword.id,
    keyword: keyword.keyword,
    language: keyword.language || "es",
    from: keyword.status,
    to: "queued",
    assigned_article_id: keyword.assigned_article_id || null,
  };
}

function validatePipelineConfig(config) {
  if (!config) {
    return { ok: false, reason: "pipeline_config row missing" };
  }
  if (config.spanish_pipeline_enabled !== false) {
    return { ok: false, reason: "pipeline_config.spanish_pipeline_enabled must remain false" };
  }
  return { ok: true, reason: "pipeline_config.spanish_pipeline_enabled=false" };
}

function runWordPressLanguageBridgeProbe() {
  const probe = spawnSync(process.execPath, [path.join(__dirname, "wp-language-bridge-probe.js")], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 60_000,
  });

  const output = `${probe.stdout || ""}${probe.stderr || ""}`.trim();
  return {
    verified: probe.status === 0,
    output,
  };
}

async function main() {
  const options = parseReleaseOptions(process.argv.slice(2));

  const rows = await supa("GET", buildReleaseKeywordEndpoint(options));
  const keywords = selectKeywordsForRelease(Array.isArray(rows) ? rows : [], options);
  console.log(
    `release-es-keywords mode=${options.go ? "WRITE --go" : "REPORT ONLY"} requested_limit=${options.requestedLimit} effective_limit=${options.effectiveLimit}`
  );
  if (options.keywordId) {
    console.log(`Target keyword_id: ${options.keywordId}`);
  }
  console.log("Phase 1 guardrail: this script can release at most 1 Spanish keyword per run.");
  console.log("spanish_pipeline_enabled is not changed by this script.");
  console.log("This script does not publish articles.");

  if (keywords.length === 0) {
    if (options.keywordId) {
      console.log(
        "No matching es_hold Spanish keyword found for the requested keyword_id with assigned_article_id=null."
      );
    } else {
      console.log("No es_hold keywords found.");
    }
    return 0;
  }

  for (const keyword of keywords) {
    console.log(JSON.stringify({ planned_action: buildReleaseAction(keyword) }, null, 2));
  }

  if (!options.go) {
    console.log(
      "Bridge verification: not required in report-only mode; --go requires read-only probe success or explicit bridge evidence."
    );
    console.log(
      "No writes performed. Re-run with --go and bridge evidence to release one keyword."
    );
    return 0;
  }

  const configRows = await supa(
    "GET",
    "pipeline_config?id=eq.00000000-0000-0000-0000-000000000001&select=spanish_pipeline_enabled"
  );
  const config = Array.isArray(configRows) ? configRows[0] : null;
  const configValidation = validatePipelineConfig(config);
  console.log(`Spanish pipeline gate: ${configValidation.reason}`);
  if (!configValidation.ok) {
    console.log("No writes performed. Spanish release remains blocked.");
    return 4;
  }

  const probe = runWordPressLanguageBridgeProbe();
  if (!probe.verified && probe.output) {
    console.log("Read-only WordPress language bridge probe did not verify:");
    console.log(probe.output.slice(0, 1200));
  }

  const bridge = resolveBridgeVerification(options, { readOnlyVerified: probe.verified });
  if (!bridge.verified) {
    console.log(`Bridge verification: ${bridge.reason}`);
    console.log("No writes performed. Spanish release remains blocked.");
    return 3;
  }

  console.log(`Bridge verification used: ${bridge.source}`);

  for (const keyword of keywords) {
    await supa("PATCH", `keywords?id=eq.${encodeURIComponent(keyword.id)}`, {
      status: "queued",
      language: "es",
      updated_at: new Date().toISOString(),
    });
    console.log(`Released ${keyword.id} -> queued`);
  }
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`ERROR: ${err.message}`);
      process.exitCode = err.code === "ENV_MISSING" ? 2 : 1;
    });
}

module.exports = {
  BRIDGE_CONFIRMATION,
  MAX_RELEASE_LIMIT,
  buildReleaseKeywordEndpoint,
  buildReleaseAction,
  parseReleaseOptions,
  resolveBridgeVerification,
  selectKeywordsForRelease,
  validatePipelineConfig,
};
