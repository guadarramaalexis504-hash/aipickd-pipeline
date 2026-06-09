#!/usr/bin/env node
"use strict";

const { hasWriteFlag, readIntFlag } = require("./lib/cli-safety");
const { supa } = require("./lib/clients");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const MAX_RELEASE_LIMIT = 1;
const BRIDGE_CONFIRMATION = "WP_LANGUAGE_BRIDGE_VERIFIED";

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

function parseReleaseOptions(inputArgv = process.argv.slice(2)) {
  const argv = [...inputArgv];
  const requestedLimit = readIntFlag(argv, "--limit", 1);
  const bridgeRunId = normalizeBridgeRunId(readOption(argv, "--bridge-run-id", null));
  const bridgeConfirmation = readOption(argv, "--confirm-bridge", null);
  const bridgeVerified = argv.includes("--bridge-verified");

  return {
    argv,
    go: hasWriteFlag(argv, new Set(["--go"])),
    requestedLimit,
    effectiveLimit: Math.min(requestedLimit, MAX_RELEASE_LIMIT),
    bridgeRunId,
    bridgeVerified,
    bridgeConfirmation,
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
  return keywords.slice(0, options.effectiveLimit);
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

  const rows = await supa(
    "GET",
    `keywords?status=eq.es_hold&order=priority.desc,search_volume.desc&limit=${options.effectiveLimit}&select=id,keyword,language,status,priority,search_volume,assigned_article_id`
  );
  const keywords = selectKeywordsForRelease(Array.isArray(rows) ? rows : [], options);
  console.log(
    `release-es-keywords mode=${options.go ? "WRITE --go" : "REPORT ONLY"} requested_limit=${options.requestedLimit} effective_limit=${options.effectiveLimit}`
  );
  console.log("Phase 1 guardrail: this script can release at most 1 Spanish keyword per run.");
  console.log("spanish_pipeline_enabled is not changed by this script.");
  console.log("This script does not publish articles.");

  if (keywords.length === 0) {
    console.log("No es_hold keywords found.");
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
  buildReleaseAction,
  parseReleaseOptions,
  resolveBridgeVerification,
  selectKeywordsForRelease,
};
