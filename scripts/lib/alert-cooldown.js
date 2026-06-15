"use strict";

const { loadEnv } = require("./env");

const env = loadEnv();

// Cross-run alert cooldown.
//
// notify.js's ALERT_DEDUP is in-process only — every cron run is a fresh process,
// so a STANDING condition (stuck keyword, cost spike, queue low, dead-man) re-fires
// the same alert every single run (hourly/4-hourly), spamming #alertas. This
// persists a last-sent timestamp per alert signature in Supabase so a standing
// condition alerts at most once per window.
//
// Degrades OPEN: if Supabase is missing/unreachable/table-absent it returns true
// (alert anyway) — a real alert must never be silenced just because the cooldown
// store is down. Safe to ship before the migration is applied (it just no-ops).

async function shouldAlert(signature, windowMs = 6 * 60 * 60 * 1000) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return true;
  const sig = String(signature || "").slice(0, 200);
  if (!sig) return true;
  const H = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/alert_cooldowns?signature=eq.${encodeURIComponent(sig)}&select=last_sent_at`,
      { headers: H, signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return true; // table missing / error → don't silence
    const rows = await res.json();
    const last = Array.isArray(rows) && rows[0]?.last_sent_at ? Date.parse(rows[0].last_sent_at) : 0;
    if (last && Date.now() - last < windowMs) return false; // still within cooldown
    // Stamp now (upsert). Fire-and-forget — a failed stamp just means we might
    // alert again next run, which is the safe direction.
    await fetch(`${env.SUPABASE_URL}/rest/v1/alert_cooldowns`, {
      method: "POST",
      headers: { ...H, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ signature: sig, last_sent_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
    return true;
  } catch {
    return true; // Supabase unreachable → alert anyway
  }
}

module.exports = { shouldAlert };
