#!/usr/bin/env node
/**
 * AIPickd Discord Bot — Slash Commands
 *
 * Discord slash commands (/status, /audit, /generate, /pause, etc) give Alexis
 * a much faster UX than natural-language @mentions for routine ops: autocomplete,
 * structured args, instant ephemeral replies, and no rate-limit hit on the
 * Anthropic API for things that don't need LLM reasoning.
 *
 * Commands shortcut directly to the underlying tool functions — no Claude
 * call required, so they're free and instant.
 *
 * Setup:
 *   1. Set DISCORD_CLIENT_ID in Railway env vars (find it at
 *      discord.com/developers/applications → your app → General Info → Application ID)
 *   2. Optional: set DISCORD_GUILD_ID to register commands only for one server
 *      (faster propagation during dev). Empty = global registration (~1h to appear).
 *   3. On bot startup, this module registers all commands via discord.js REST.
 */

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const COMMAND_DEFS = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Pipeline status: artículos hoy/semana, cost, drafts, qa_failed, etc.'),

  new SlashCommandBuilder()
    .setName('audit')
    .setDescription('Audita UN artículo por slug — detecta fence/dup-H1/short/AFFILIATE leftover')
    .addStringOption((opt) =>
      opt.setName('slug')
         .setDescription('Slug del artículo (ej: best-ai-tools-for-video-editing-2026)')
         .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('republish')
    .setDescription('Re-renderiza UN artículo (fix HTML bugs vía fix-stale-html workflow)')
    .addStringOption((opt) =>
      opt.setName('slug')
         .setDescription('Slug del artículo a re-renderizar')
         .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('generate')
    .setDescription('Dispara el pipeline (genera N artículos ya, sin esperar el cron)')
    .addIntegerOption((opt) =>
      opt.setName('count')
         .setDescription('Cuántos artículos generar (1-5, default 1)')
         .setMinValue(1).setMaxValue(5)
    ),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('PAUSA el pipeline (el próximo cron aborta clean). Confirmar razón.')
    .addStringOption((opt) =>
      opt.setName('reason')
         .setDescription('Por qué pausar (visible en /status)')
         .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Reanuda el pipeline después de un pause'),

  new SlashCommandBuilder()
    .setName('cost')
    .setDescription('Cost breakdown del mes (gastado, projected, % de $50)'),

  new SlashCommandBuilder()
    .setName('articles')
    .setDescription('Lista los últimos N artículos publicados')
    .addIntegerOption((opt) =>
      opt.setName('count')
         .setDescription('Cuántos (default 5, max 20)')
         .setMinValue(1).setMaxValue(20)
    ),

  new SlashCommandBuilder()
    .setName('runs')
    .setDescription('Últimos 5 runs del workflow generate en GitHub Actions'),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Borra la memoria del bot en este canal (próximo mensaje empieza fresco)'),
];

/**
 * Register commands with Discord. Called once on bot startup.
 * Idempotent: re-registering with the same set is a no-op.
 */
async function registerSlashCommands(token, clientId, guildId = null) {
  if (!clientId) {
    console.warn('[slash] DISCORD_CLIENT_ID not set — skipping slash command registration');
    return { registered: 0, skipped: true };
  }
  const rest = new REST({ version: '10' }).setToken(token);
  const body = COMMAND_DEFS.map((c) => c.toJSON());
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
  await rest.put(route, { body });
  return {
    registered: body.length,
    scope: guildId ? `guild ${guildId}` : 'global',
    commands: body.map((c) => `/${c.name}`),
  };
}

/**
 * Format a tool result object into a Discord-friendly markdown reply.
 * Truncates long fields and uses code blocks for structured data.
 */
function formatResult(result) {
  if (!result) return '(sin respuesta)';
  if (typeof result === 'string') return result.slice(0, 1900);
  if (result.error) return `❌ Error: \`${String(result.error).slice(0, 300)}\``;

  // Pretty-print common shapes
  if (result.found === false) return `🔍 No encontré nada con esos criterios.`;
  if (result.triggered === true) {
    return `🚀 ${result.message || 'Workflow disparado'}${result.actions_url ? `\n${result.actions_url}` : ''}`;
  }
  if (result.paused !== undefined) {
    return result.paused
      ? `⏸  Pipeline pausado por **${result.paused_by || 'unknown'}** — ${result.paused_reason || 'sin razón'}`
      : `✅ Pipeline activo`;
  }

  // Default — pretty JSON, capped at 1900 chars
  const json = JSON.stringify(result, null, 2);
  return '```json\n' + json.slice(0, 1850) + (json.length > 1850 ? '\n...' : '') + '\n```';
}

module.exports = { registerSlashCommands, formatResult, COMMAND_DEFS };
