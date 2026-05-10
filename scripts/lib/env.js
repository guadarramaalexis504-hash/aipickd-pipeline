/**
 * Centralized environment loader.
 *
 * Source order:
 *   1. process.env (production / GitHub Actions)
 *   2. .env file at repo root (local dev)
 *
 * The .env parser handles double-quoted values containing escaped quotes,
 * unlike the previous regex (`/^([A-Z_]+)="?([^"\n]*)"?$/`) which broke
 * silently when a secret contained a `"` character.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_ENV_PATH = path.join(ROOT, ".env");

let cache = null;

/**
 * Parses a .env file content string. Handles unquoted, single-quoted, and
 * double-quoted values; double-quoted values support `\n`, `\r`, `\t`, `\"`,
 * and `\\` escapes.
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseEnvFile(content) {
  const out = {};
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
        if (first === '"') {
          value = value
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\r")
            .replace(/\\t/g, "\t")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
        }
      }
    }

    out[key] = value;
  }
  return out;
}

/**
 * Returns a Proxy that resolves keys from process.env first (preferred in CI)
 * and falls back to the parsed .env file (preferred in local dev).
 *
 * @param {{ envPath?: string, refresh?: boolean }} [options]
 * @returns {Record<string, string | undefined>}
 */
function loadEnv({ envPath = DEFAULT_ENV_PATH, refresh = false } = {}) {
  if (cache && !refresh) return cache;

  const fileEnv = fs.existsSync(envPath) ? parseEnvFile(fs.readFileSync(envPath, "utf8")) : {};

  cache = new Proxy(
    {},
    {
      get(_t, key) {
        if (typeof key !== "string") return undefined;
        if (process.env[key] !== undefined && process.env[key] !== "") {
          return process.env[key];
        }
        return fileEnv[key];
      },
      has(_t, key) {
        return (typeof key === "string" && process.env[key] !== undefined) || key in fileEnv;
      },
      ownKeys() {
        return Array.from(new Set([...Object.keys(process.env), ...Object.keys(fileEnv)]));
      },
      getOwnPropertyDescriptor() {
        return { enumerable: true, configurable: true };
      },
    }
  );

  return cache;
}

/**
 * Asserts that all listed env vars are non-empty. Throws an Error with
 * `code: "ENV_MISSING"` and `missing: string[]` if any are absent.
 *
 * @param {string[]} keys
 * @returns {Record<string, string | undefined>}
 */
function require_(keys) {
  const env = loadEnv();
  const missing = [];
  for (const k of keys) {
    const v = env[k];
    if (!v) missing.push(k);
  }
  if (missing.length > 0) {
    const err = new Error(`Missing required env var(s): ${missing.join(", ")}`);
    err.code = "ENV_MISSING";
    err.missing = missing;
    throw err;
  }
  return env;
}

module.exports = {
  loadEnv,
  parseEnvFile,
  require: require_,
};
