/**
 * Optional Sentry error reporting.
 *
 * Why opt-in: Sentry's official SDK is a heavy dep (~3 MB). For a 2-deps
 * project this is overkill. We post directly to the Sentry envelope
 * endpoint with a tiny inline payload — no SDK, no init, just a
 * fire-and-forget POST when SENTRY_DSN is set.
 *
 * Activate by setting SENTRY_DSN in env (the standard format
 * https://<key>@<host>/<project>). Without it, all calls are no-ops.
 *
 * Usage:
 *   const sentry = require("./lib/sentry");
 *   sentry.installGlobalHandlers({ script: "run-pipeline" });
 *   ...
 *   // explicit:
 *   await sentry.captureException(err, { tags: { stage: "publish" } });
 */

const { fetchWithRetry } = require("./http");

let dsnCache = null;

function parseDsn() {
  if (dsnCache !== null) return dsnCache;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    dsnCache = false;
    return false;
  }
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, "");
    if (!projectId) throw new Error("missing project id");
    dsnCache = {
      key: u.username,
      host: u.host,
      projectId,
      url: `${u.protocol}//${u.host}/api/${projectId}/store/`,
    };
    return dsnCache;
  } catch {
    process.stderr.write(`[sentry] invalid SENTRY_DSN — disabled\n`);
    dsnCache = false;
    return false;
  }
}

/**
 * Send an exception event to Sentry.
 *
 * @param {Error | unknown} err
 * @param {{ tags?: Record<string, string>, extra?: Record<string, unknown>, level?: "fatal" | "error" | "warning" }} [opts]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function captureException(err, opts = {}) {
  const dsn = parseDsn();
  if (!dsn) return { ok: false, reason: "SENTRY_DSN not set" };

  const errObj =
    err instanceof Error
      ? err
      : new Error(typeof err === "string" ? err : JSON.stringify(err).slice(0, 500));

  const event = {
    event_id: randomHex(32),
    timestamp: Math.floor(Date.now() / 1000),
    platform: "node",
    level: opts.level || "error",
    server_name: process.env.GITHUB_REPOSITORY || "aipickd-pipeline",
    environment: process.env.NODE_ENV || (process.env.CI ? "ci" : "local"),
    release: process.env.GITHUB_SHA?.slice(0, 8) || undefined,
    tags: opts.tags || {},
    extra: opts.extra || {},
    exception: {
      values: [
        {
          type: errObj.name || "Error",
          value: String(errObj.message).slice(0, 4000),
          stacktrace: errObj.stack ? { frames: parseStack(errObj.stack) } : undefined,
        },
      ],
    },
  };

  try {
    const auth = [
      "Sentry sentry_version=7",
      `sentry_key=${dsn.key}`,
      `sentry_client=aipickd/1.0`,
    ].join(", ");
    const res = await fetchWithRetry(
      dsn.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sentry-Auth": auth,
        },
        body: JSON.stringify(event),
      },
      { retries: 1, timeout: 5000, allowedHosts: ["*"] }
    );
    return { ok: res.ok, reason: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Wire up `unhandledRejection` and `uncaughtException` to ship to Sentry
 * before exiting. Idempotent — safe to call from multiple scripts.
 *
 * @param {{ tags?: Record<string, string> }} [opts]
 */
function installGlobalHandlers(opts = {}) {
  if (process.__aipickdSentryInstalled) return;
  process.__aipickdSentryInstalled = true;

  process.on("unhandledRejection", async (reason) => {
    await captureException(reason, { ...opts, level: "fatal" }).catch(() => {});
    process.stderr.write(`[sentry] unhandledRejection: ${String(reason).slice(0, 200)}\n`);
  });
  process.on("uncaughtException", async (err) => {
    await captureException(err, { ...opts, level: "fatal" }).catch(() => {});
    process.stderr.write(`[sentry] uncaughtException: ${err.message}\n`);
    process.exit(1);
  });
}

function randomHex(len) {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function parseStack(stack) {
  const lines = stack.split("\n").slice(1, 11);
  return lines
    .map((line) => {
      const m = line.match(/at (?:(.+?) )?\(?([^():]+):(\d+):(\d+)\)?$/);
      if (!m) return null;
      return {
        function: m[1] || "<anonymous>",
        filename: m[2],
        lineno: Number(m[3]),
        colno: Number(m[4]),
      };
    })
    .filter(Boolean)
    .reverse();
}

// Reset cache for tests.
function _resetCache() {
  dsnCache = null;
}

module.exports = { captureException, installGlobalHandlers, _resetCache };
