/**
 * Hostinger cold-start warm-up.
 *
 * aipickd.com runs on Hostinger shared hosting. When the site has been idle,
 * the FIRST request frequently cold-starts: it hangs 10s+ and often times out,
 * while every request after it is fast (~100-950ms). Measured 2026-06-03:
 *   try1: 11,405ms → fail   try2-5: 950/111/103/100ms ✅
 *
 * That single cold-start timeout is what trips the site monitor ("site down"
 * false alarms) and makes WP-heavy batch steps (schema, dedup, title-refresh)
 * fail their first writes. This helper absorbs the cold-start: it pings the
 * homepage until the site answers quickly (or attempts run out), so the
 * caller's real work runs against an already-warm site.
 *
 * Fire-and-forget friendly: never throws. Returns {warm, attempts, ms}.
 */

const { fetchWithRetry } = require("./http");

async function warmUp({
  host = "https://aipickd.com",
  attempts = 4,
  okMs = 5000,
  timeout = 20000,
  gapMs = 1500,
  log = false,
} = {}) {
  for (let i = 0; i < attempts; i++) {
    const t0 = Date.now();
    try {
      const res = await fetchWithRetry(
        `${host}/`,
        { headers: { "User-Agent": "AIPickd-warmup/1.0" } },
        { timeout, retries: 0 }
      );
      const ms = Date.now() - t0;
      // Drain body so the connection is released cleanly.
      await res.text().catch(() => {});
      if (res.ok && ms < okMs) {
        if (log) console.log(`   🔥 warm-up: site responsive in ${ms}ms (attempt ${i + 1})`);
        return { warm: true, attempts: i + 1, ms };
      }
      if (log) console.log(`   ⏳ warm-up: attempt ${i + 1} slow/non-200 (${ms}ms, status ${res.status})`);
    } catch (e) {
      if (log) console.log(`   ⏳ warm-up: attempt ${i + 1} cold (${e.message.slice(0, 50)})`);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  if (log) console.log(`   ⚠️  warm-up: site still cold after ${attempts} attempts — proceeding anyway`);
  return { warm: false, attempts };
}

module.exports = { warmUp };
