/**
 * Healthchecks.io heartbeat helpers.
 *
 * Why: GitHub's cron is best-effort — if the runner queue is delayed by
 * an hour or a workflow gets disabled by accident, you don't find out
 * until the next time you log in. Healthchecks.io (free tier, no signup
 * needed beyond email) pings you when it stops hearing from a job.
 *
 * Setup:
 *   1. Create a check at https://healthchecks.io (or self-host).
 *   2. Set env HEALTHCHECK_URL_<NAME>=https://hc-ping.com/<uuid>
 *      e.g. HEALTHCHECK_URL_GENERATE for the generate.yml workflow.
 *   3. In the workflow's last step, run:
 *        node -e "require('./scripts/lib/heartbeat').ping('GENERATE')"
 *
 * The function is fire-and-forget by design: if the heartbeat itself
 * fails, we don't block the workflow on it.
 */

const { fetchWithRetry } = require("./http");

/**
 * Pings the healthchecks.io URL identified by name.
 * Optionally signals "starting" or "failure" so HC tracks duration + state.
 *
 * @param {string} name      Suffix of `HEALTHCHECK_URL_<NAME>` env var.
 * @param {{
 *   state?: "start" | "success" | "fail",
 *   exitCode?: number,
 *   message?: string,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function ping(name, opts = {}) {
  const url = process.env[`HEALTHCHECK_URL_${name.toUpperCase()}`];
  if (!url) return { ok: false, reason: "no HEALTHCHECK_URL_" + name };

  const state = opts.state || "success";
  let pingUrl = url;
  if (state === "start") pingUrl += "/start";
  else if (state === "fail") {
    pingUrl += opts.exitCode !== undefined ? `/${opts.exitCode}` : "/fail";
  }

  try {
    const res = await fetchWithRetry(
      pingUrl,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: opts.message ? String(opts.message).slice(0, 100_000) : undefined,
      },
      { retries: 1, timeout: 5000 }
    );
    return { ok: res.ok, reason: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    // Heartbeat must never block the pipeline — swallow + return.
    return { ok: false, reason: err.message };
  }
}

module.exports = { ping };
