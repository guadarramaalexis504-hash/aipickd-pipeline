#!/usr/bin/env node
/**
 * AIPickd — Dead Man's Switch
 *
 * Checks if the generate pipeline has run successfully in the last N hours.
 * If silent too long, fires a critical Discord alert.
 *
 * Usage:
 *   node scripts/deadmans-check.js                  # default: alert if > 12h silent
 *   node scripts/deadmans-check.js --hours 24       # alert if > 24h silent
 *   GITHUB_TOKEN=xxx node scripts/deadmans-check.js  # uses GH API (more accurate)
 */

const { loadEnv } = require('./lib/env');
const { notifyAlert } = require('./notify.js');

const env = loadEnv();

const args = process.argv.slice(2);
const hoursIdx = args.indexOf('--hours');
const MAX_SILENT_HOURS = hoursIdx >= 0 ? parseInt(args[hoursIdx + 1]) : 12;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || 'your-user/aipickd';

(async () => {
  console.log(`🔍 Dead Man's Switch — checking if pipeline ran in last ${MAX_SILENT_HOURS}h`);

  // Strategy 1: Use GitHub Actions API to check last successful run
  if (GITHUB_TOKEN) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/generate.yml/runs?status=success&per_page=1`,
        {
          headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'AIPickd-DeadMansSwitch/1.0',
          },
          signal: AbortSignal.timeout(15000),
        }
      );

      if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
      const data = await res.json();
      const lastRun = data.workflow_runs && data.workflow_runs[0];

      if (!lastRun) {
        console.log('⚠️ No successful pipeline runs found in GitHub Actions history');
        await fireAlert('No se encontraron ejecuciones exitosas del pipeline en el historial de GitHub Actions.');
        process.exit(1);
      }

      const lastRunAt = new Date(lastRun.updated_at || lastRun.created_at);
      const hoursSince = (Date.now() - lastRunAt.getTime()) / 3600000;
      console.log(`  Last successful run: ${lastRunAt.toISOString()} (${hoursSince.toFixed(1)}h ago)`);
      console.log(`  Run URL: ${lastRun.html_url}`);

      if (hoursSince > MAX_SILENT_HOURS) {
        console.error(`💀 Pipeline silent for ${hoursSince.toFixed(0)} hours! (threshold: ${MAX_SILENT_HOURS}h)`);
        await fireAlert(
          `Pipeline sin ejecutarse por **${hoursSince.toFixed(0)} horas** (umbral: ${MAX_SILENT_HOURS}h).\n\n` +
          `Último run exitoso: ${lastRunAt.toISOString()}\n🔗 [Ver en GitHub Actions](${lastRun.html_url})`
        );
        process.exit(1);
      }

      console.log(`✅ Pipeline running normally (last run ${hoursSince.toFixed(1)}h ago)`);
      return;
    } catch (e) {
      console.log(`⚠️ GitHub API check failed: ${e.message} — falling back to Supabase check`);
    }
  }

  // Strategy 2: Fallback — check Supabase for recent published articles
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ No GitHub token or Supabase credentials — cannot check pipeline health');
    process.exit(0); // Don't fire false alarms when we can't check
  }

  const cutoff = new Date(Date.now() - MAX_SILENT_HOURS * 3600000).toISOString();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/articles?created_at=gte.${cutoff}&select=id,title,created_at&order=created_at.desc&limit=1`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }
  );

  if (!res.ok) {
    console.error(`❌ Supabase check failed: ${res.status}`);
    process.exit(0); // Don't fire on infra errors
  }

  const articles = await res.json();
  if (!Array.isArray(articles) || articles.length === 0) {
    const msg = `No se generaron artículos en las últimas **${MAX_SILENT_HOURS} horas** (verificado via Supabase).\n\nEl pipeline puede estar caído o sin keywords en cola.`;
    console.error(`💀 ${msg}`);
    await fireAlert(msg);
    process.exit(1);
  }

  const last = articles[0];
  const lastAt = new Date(last.created_at);
  const hoursSince = (Date.now() - lastAt.getTime()) / 3600000;
  console.log(`✅ Last article generated ${hoursSince.toFixed(1)}h ago: "${last.title}"`);
})().catch((e) => {
  console.error('❌ Dead man check failed:', e.message);
  process.exit(0); // Don't alert on script errors
});

async function fireAlert(detail) {
  const repoUrl = `https://github.com/${GITHUB_REPOSITORY}/actions/workflows/generate.yml`;
  const message =
    `💀 **Dead Man's Switch activado**\n\n${detail}\n\n` +
    `❓ **Posibles causas:**\n` +
    `• API key vencida (OpenAI / Supabase)\n` +
    `• GitHub Actions deshabilitado o con error\n` +
    `• Sin keywords en cola\n` +
    `• Límite de presupuesto alcanzado\n\n` +
    `🔧 [Ver GitHub Actions](${repoUrl})`;

  try {
    const r = await notifyAlert(message, 'critical');
    console.log('Discord alert sent:', r.ok ? 'OK' : r.reason || r.status);
  } catch (e) {
    console.error('Failed to send Discord alert:', e.message);
  }
}
