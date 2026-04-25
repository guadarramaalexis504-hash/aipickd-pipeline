#!/usr/bin/env node
/**
 * AIPickd — Unified notifications (Discord webhook + Telegram bot)
 *
 * Sends notifications when stuff happens:
 *  - New article published
 *  - Affiliate click recorded
 *  - Pipeline error
 *  - Weekly summary
 *
 * Setup (one-time, when you have time):
 *
 *  A) DISCORD (easier — 3 min):
 *     1. Create a Discord server (or use existing)
 *     2. Server Settings → Integrations → Webhooks → New Webhook
 *     3. Copy the webhook URL
 *     4. Add to .env:  DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
 *
 *  B) TELEGRAM (5 min):
 *     1. In Telegram, message @BotFather
 *     2. /newbot → pick name → copy token
 *     3. Message your new bot once (send anything)
 *     4. Visit: https://api.telegram.org/bot<TOKEN>/getUpdates — find your chat_id
 *     5. Add to .env:
 *        TELEGRAM_BOT_TOKEN="..."
 *        TELEGRAM_CHAT_ID="..."
 *
 * Usage:
 *   node scripts/notify.js "Article published: Title"       # sends to all configured channels
 *   const { notify } = require('./notify.js');  notify("text");  # from other scripts
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
try {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch {}

async function sendDiscord(message) {
  if (!env.DISCORD_WEBHOOK_URL) return { ok: false, reason: "DISCORD_WEBHOOK_URL not set" };
  try {
    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "AIPickd Bot",
        avatar_url: "https://aipickd.com/wp-content/uploads/aipickd-logo.png",
        content: message.slice(0, 2000), // Discord limit
      }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function sendTelegram(message) {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = env;
  if (!token || !chatId) return { ok: false, reason: "TELEGRAM_* not set" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message.slice(0, 4096), // Telegram limit
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      }),
    });
    const data = await res.json();
    return { ok: data.ok, status: res.status };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function notify(message) {
  const results = { discord: null, telegram: null };
  // Send in parallel
  const [d, t] = await Promise.all([sendDiscord(message), sendTelegram(message)]);
  results.discord = d;
  results.telegram = t;
  return results;
}

// Export for other scripts
module.exports = { notify, sendDiscord, sendTelegram };

// CLI usage: node scripts/notify.js "your message here"
if (require.main === module) {
  const message = process.argv.slice(2).join(" ") || "🤖 AIPickd test notification";
  notify(message).then((r) => {
    console.log("Discord:", r.discord.ok ? "✅ sent" : `❌ ${r.discord.reason || r.discord.status}`);
    console.log("Telegram:", r.telegram.ok ? "✅ sent" : `❌ ${r.telegram.reason || r.telegram.status}`);
    if (!r.discord.ok && !r.telegram.ok) {
      console.log("\n💡 Configure at least one in .env:");
      console.log("   DISCORD_WEBHOOK_URL=...");
      console.log("   TELEGRAM_BOT_TOKEN=... + TELEGRAM_CHAT_ID=...");
    }
  });
}
