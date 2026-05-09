/**
 * Structured JSON logger for the AIPickd pipeline.
 *
 * Why: today scripts use `console.log` with string concatenation which is
 * impossible to grep/aggregate after the fact. With JSON lines we can pipe
 * any workflow's stdout into Loki/Datadog/Grafana later for free.
 *
 * Usage:
 *   const log = require("./lib/log").create({ script: "run-pipeline" });
 *   log.info("article generated", { articleId: 42, words: 2500 });
 *   log.error("openai failed", { err: e.message, attempt: 2 });
 *
 * In TTY (local dev) the output is human-readable. In CI (no TTY, NDJSON
 * everywhere) the output is one JSON object per line.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function isTTY() {
  return Boolean(process.stdout.isTTY);
}

function levelFromEnv() {
  const v = String(process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVELS[v] !== undefined ? LEVELS[v] : LEVELS.info;
}

function safeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  });
}

function format(record, pretty) {
  if (!pretty) return safeStringify(record) + "\n";
  const { level, msg, ts, ...rest } = record;
  const stamp = ts.slice(11, 19);
  const tag =
    level === "error"
      ? "\x1b[31mERR \x1b[0m"
      : level === "warn"
        ? "\x1b[33mWARN\x1b[0m"
        : level === "debug"
          ? "\x1b[90mDBG \x1b[0m"
          : "\x1b[36mINFO\x1b[0m";
  const extras = Object.keys(rest).length > 0 ? " " + safeStringify(rest) : "";
  return `${stamp} ${tag} ${msg}${extras}\n`;
}

function create(baseFields = {}) {
  const minLevel = levelFromEnv();
  const pretty = isTTY() && process.env.LOG_FORMAT !== "json";

  function emit(level, msg, fields) {
    if (LEVELS[level] < minLevel) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: String(msg),
      ...baseFields,
      ...(fields || {}),
    };
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(format(record, pretty));
  }

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (extra) => create({ ...baseFields, ...extra }),
  };
}

module.exports = { create, LEVELS };
