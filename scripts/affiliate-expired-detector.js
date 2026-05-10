#!/usr/bin/env node
/**
 * AIPickd — Affiliate link health checker.
 *
 * Hits HEAD on every active affiliate's base_url. If the response is
 * 4xx (esp. 404) or redirects to a different domain than expected,
 * marks the affiliate as `expired` and (when present) swaps base_url
 * for the configured replacement_url.
 *
 * Updates the affiliate row with:
 *   - last_checked_at
 *   - last_status_code
 *   - redirect_target  (if redirect lands on a different host)
 *   - status = 'expired' | 'active' (depending on result)
 *
 * Notifies Discord when affiliates are auto-swapped or marked expired.
 *
 * Usage:
 *   node scripts/affiliate-expired-detector.js          # report only
 *   node scripts/affiliate-expired-detector.js --fix    # apply swaps
 *   node scripts/affiliate-expired-detector.js --json   # machine output
 */

const { loadEnv } = require("./lib/env");
const { supa } = require("./lib/clients");
const { fetchWithRetry } = require("./lib/http");
const log = require("./lib/log").create({ script: "affiliate-expired-detector" });

const env = loadEnv();

const FIX = process.argv.includes("--fix");
const JSON_OUT = process.argv.includes("--json");

function expectedHost(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

async function checkOne(affiliate) {
  const url = affiliate.base_url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, status: 0, reason: "invalid base_url" };
  }
  const expected = expectedHost(url);

  try {
    // HEAD first; fall back to GET if HEAD is rejected (some affiliate
    // networks 405 HEAD but accept GET).
    let res = await fetchWithRetry(
      url,
      { method: "HEAD", redirect: "follow" },
      { retries: 1, timeout: 15000, allowedHosts: ["*"] }
    );
    if (res.status === 405 || res.status === 501) {
      res = await fetchWithRetry(
        url,
        { method: "GET", redirect: "follow" },
        { retries: 1, timeout: 15000, allowedHosts: ["*"] }
      );
    }
    const finalHost = expectedHost(res.url) || expected;
    const redirected = finalHost !== expected;
    return {
      ok: res.ok && !redirected,
      status: res.status,
      finalHost,
      redirected,
      reason: !res.ok
        ? `HTTP ${res.status}`
        : redirected
          ? `redirected to ${finalHost}`
          : "ok",
    };
  } catch (e) {
    return { ok: false, status: 0, reason: e.message.slice(0, 200) };
  }
}

async function notifyDiscord(summary) {
  const url = env.DISCORD_WEBHOOK_ALERTAS;
  if (!url) return;
  const lines = [
    `🔗 **Affiliate health check** — ${summary.checked} checked`,
    `   Active: ${summary.ok}`,
    `   Newly expired: ${summary.expired}`,
    `   Auto-swapped: ${summary.swapped}`,
  ];
  if (summary.expiredList.length > 0) {
    lines.push("", "**Expired:**");
    for (const e of summary.expiredList.slice(0, 10)) {
      lines.push(`  • ${e.brand} (${e.reason})`);
    }
  }
  try {
    await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: lines.join("\n") }),
      },
      { retries: 1, timeout: 10000 }
    );
  } catch (e) {
    log.warn("Discord notify failed", { err: e.message });
  }
}

(async () => {
  log.info("Starting affiliate health check", { fix: FIX });

  const affiliates = await supa(
    "GET",
    "affiliates?status=in.(active,pending)&select=id,brand,base_url,replacement_url,status&order=last_checked_at.asc.nullsfirst&limit=200"
  );
  if (!Array.isArray(affiliates) || affiliates.length === 0) {
    log.info("No active affiliates to check");
    if (JSON_OUT) console.log(JSON.stringify({ checked: 0 }));
    return;
  }

  const summary = { checked: 0, ok: 0, expired: 0, swapped: 0, expiredList: [] };

  for (const aff of affiliates) {
    const result = await checkOne(aff);
    summary.checked++;

    const patch = {
      last_checked_at: new Date().toISOString(),
      last_status_code: result.status || null,
      redirect_target: result.redirected ? result.finalHost : null,
    };

    if (result.ok) {
      summary.ok++;
      if (aff.status === "expired") patch.status = "active";
    } else {
      summary.expired++;
      summary.expiredList.push({ brand: aff.brand, reason: result.reason });
      if (FIX) {
        if (aff.replacement_url) {
          patch.base_url = aff.replacement_url;
          patch.replacement_url = null;
          patch.status = "active";
          summary.swapped++;
          log.info("Auto-swapped affiliate", { brand: aff.brand, to: aff.replacement_url });
        } else {
          patch.status = "expired";
          log.warn("Affiliate marked expired", { brand: aff.brand, reason: result.reason });
        }
      }
    }

    if (FIX) {
      await supa("PATCH", `affiliates?id=eq.${encodeURIComponent(aff.id)}`, patch);
    }
  }

  log.info("Health check complete", summary);
  if (JSON_OUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("\n📊 Summary:");
    console.log(`   Checked: ${summary.checked}`);
    console.log(`   OK:      ${summary.ok}`);
    console.log(`   Expired: ${summary.expired}`);
    console.log(`   Swapped: ${summary.swapped}`);
  }

  if (FIX && (summary.expired > 0 || summary.swapped > 0)) {
    await notifyDiscord(summary);
  }
})().catch((e) => {
  log.error("Fatal error", { err: e.message, stack: e.stack });
  process.exit(2);
});
