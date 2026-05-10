#!/usr/bin/env node
/**
 * AIPickd unified CLI.
 *
 * Replaces `node scripts/<name>.js …` with `aipickd <command> …`.
 * Discovers commands from a static map (each one a thin wrapper around
 * an existing script) so adding a command is one line here.
 *
 * Usage:
 *   aipickd help
 *   aipickd pipeline --gen 1
 *   aipickd cost --json
 *   aipickd dlq list
 *   aipickd dlq triage <id>
 *   aipickd affiliate check
 *   aipickd dashboard
 *   aipickd monitor
 */

const path = require("node:path");
const { spawn } = require("node:child_process");

const SCRIPTS = path.join(__dirname);

const COMMANDS = {
  help: { handler: showHelp, description: "Show this help text" },

  pipeline: {
    description: "Run the main generate + publish pipeline",
    script: "run-pipeline.js",
  },
  monitor: {
    description: "Run the Playwright site health check",
    script: "monitor-site.js",
  },
  cost: {
    description: "Print spend report (--json for machine output)",
    script: "cost-monitor.js",
  },
  health: {
    description: "Run the pre-flight health check",
    script: "health-check.js",
  },
  dashboard: {
    description: "Generate the markdown dashboard to stdout",
    handler: runDashboard,
  },
  "dlq list": {
    description: "List untriaged DLQ entries",
    handler: dlqList,
  },
  "dlq triage": {
    description: "Mark a DLQ entry as triaged: aipickd dlq triage <id> [note]",
    handler: dlqTriage,
  },
  "affiliate check": {
    description: "Check affiliate URL health (use --fix to apply swaps)",
    script: "affiliate-expired-detector.js",
  },
  "validate-secrets": {
    description: "Verify all required secrets are set + correctly formatted",
    script: "validate-secrets.js",
  },
};

function showHelp() {
  console.log("AIPickd CLI — unified entry point\n");
  console.log("Commands:\n");
  const keys = Object.keys(COMMANDS).sort();
  const padding = Math.max(...keys.map((k) => k.length));
  for (const key of keys) {
    const cmd = COMMANDS[key];
    console.log(`  ${key.padEnd(padding)}  ${cmd.description}`);
  }
  console.log("\nExample: aipickd pipeline --gen 1");
}

async function runDashboard() {
  const { render } = require("./lib/dashboard");
  const md = await render();
  process.stdout.write(md);
}

async function dlqList() {
  const { listUntriaged } = require("./lib/dlq");
  const rows = await listUntriaged({ limit: 50 });
  if (rows.length === 0) {
    console.log("DLQ is empty.");
    return;
  }
  for (const r of rows) {
    console.log(
      `${r.id}  ${r.archived_at}  attempts=${r.attempts}  ${r.keyword}\n  └─ ${r.last_error || "(no error)"}`
    );
  }
}

async function dlqTriage(args) {
  const id = args[0];
  if (!id) {
    console.error("Usage: aipickd dlq triage <id> [note]");
    process.exit(2);
  }
  const note = args.slice(1).join(" ") || null;
  const { markTriaged } = require("./lib/dlq");
  await markTriaged(id, { note });
  console.log(`✓ Marked ${id} as triaged.`);
}

function runScript(scriptName, args) {
  const child = spawn(process.execPath, [path.join(SCRIPTS, scriptName), ...args], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    showHelp();
    return;
  }

  // Try two-word command first ("dlq list", "affiliate check"), then one-word.
  let key = args.length >= 2 ? `${args[0]} ${args[1]}` : null;
  let restStart = 2;
  if (!key || !COMMANDS[key]) {
    key = args[0];
    restStart = 1;
  }
  const cmd = COMMANDS[key];
  if (!cmd) {
    console.error(`Unknown command: ${args[0]}`);
    console.error("Run `aipickd help` for the list.");
    process.exit(2);
  }

  const rest = args.slice(restStart);
  if (cmd.handler) {
    Promise.resolve(cmd.handler(rest)).catch((e) => {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    });
    return;
  }
  runScript(cmd.script, rest);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { COMMANDS, main };
