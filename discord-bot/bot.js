#!/usr/bin/env node
/**
 * AIPickd — Discord Bot con Claude AI
 *
 * Un asistente inteligente para AIPickd que vive en tu Discord.
 * Responde preguntas, da stats del pipeline, y puede ACTUAR:
 *   - Re-encolar artículos fallidos
 *   - Disparar el pipeline manualmente
 *   - Agregar keywords a la cola
 *   - Revisar la salud del pipeline
 *   - Ver los últimos runs de GitHub Actions
 *
 * Todo desde el cel, sin necesidad de tener la laptop prendida.
 *
 * Configuración:
 *   1. Crea tu bot en https://discord.com/developers/applications
 *   2. Activa "Message Content Intent" en Bot → Privileged Gateway Intents
 *   3. Env vars en Railway: DISCORD_BOT_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_MODEL,
 *      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GITHUB_TOKEN
 *   4. Invita el bot con: https://discord.com/api/oauth2/authorize?client_id=TU_CLIENT_ID&permissions=277025442816&scope=bot
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Client, GatewayIntentBits, Events } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const {
  getStats,
  getRecentArticles,
  getMonthlyCost,
  getKeywordsQueue,
  getAffiliates,
  getPipelineHealth,
  getPipelinePauseState,
  auditArticle,
  requeueFailedArticles,
  addKeyword,
  pausePipeline,
  resumePipeline,
  regenerateArticle,
  loadConversation,
  saveConversation,
  clearConversation,
} = require('./supabase');
const { triggerPipelineRun, getLatestRuns, dispatchWorkflow } = require('./github');
const { registerSlashCommands, formatResult } = require('./slash-commands');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID; // for slash command registration
const DISCORD_GUILD_ID  = process.env.DISCORD_GUILD_ID;  // optional, dev-mode faster
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const MODEL           = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';
const MAX_HISTORY     = 20;   // mensajes por canal que recuerda
const MAX_REPLY_LEN   = 1900; // chars por mensaje de Discord

// Canales donde el bot responde a TODO (sin necesidad de @mención)
const AUTO_RESPOND_KEYWORDS = ['claude', 'bot', 'aipickd-ai', 'asistente'];

// ── Rate limiting (anti-abuse / cost protection) ──────────────────────────────
// Sliding-window counters per user and per channel. The window is rolling:
// we keep a list of timestamps and prune anything older than RATE_WINDOW_MS
// before each check. If the surviving count exceeds the limit, we refuse
// politely and skip the Anthropic call entirely.
//
// These limits are conservative — Alexis can easily raise them by editing
// the constants if real usage demands more. The point is to prevent a
// runaway loop or a compromised account from burning the monthly budget.
const RATE_WINDOW_MS    = 60 * 60 * 1000; // 1 hour
const RATE_USER_LIMIT   = 30;             // messages/hour per user
const RATE_CHANNEL_LIMIT = 100;           // messages/hour per channel
const rateUser = new Map();    // userId → [timestamp, ...]
const rateChannel = new Map(); // channelId → [timestamp, ...]

function pruneWindow(list, now) {
  while (list.length > 0 && now - list[0] > RATE_WINDOW_MS) list.shift();
}

/**
 * Returns null if the request is allowed; otherwise a polite reject message
 * with the cooldown estimate. Pruning happens before counting so old entries
 * don't permanently inflate the count.
 */
function checkRateLimit(userId, channelId) {
  const now = Date.now();

  const u = rateUser.get(userId) || [];
  pruneWindow(u, now);
  if (u.length >= RATE_USER_LIMIT) {
    const oldest = u[0];
    const waitMin = Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 60000);
    return `🐢 Aguanta manito, llevas ${u.length} mensajes esta hora. Espera ~${waitMin} min y vuelve.`;
  }

  const c = rateChannel.get(channelId) || [];
  pruneWindow(c, now);
  if (c.length >= RATE_CHANNEL_LIMIT) {
    const waitMin = Math.ceil((RATE_WINDOW_MS - (now - c[0])) / 60000);
    return `🚦 Este canal lleva ${c.length} mensajes la última hora — calmando ${waitMin} min.`;
  }

  // Allowed — record the hit
  u.push(now);
  c.push(now);
  rateUser.set(userId, u);
  rateChannel.set(channelId, c);
  return null;
}

// ── Clientes ──────────────────────────────────────────────────────────────────
const discord  = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// Historial de conversación por canal.
// In-memory cache backed by Supabase (table bot_conversations) so we
// survive Railway redeploys without losing context. Lazy-loaded per
// channel on first message, then written back after each assistant
// reply (fire-and-forget — failures log but don't block).
const history = new Map(); // channelId → Message[]
const historyLoaded = new Set(); // channelIds whose history we've already fetched

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el asistente AI de AIPickd.com. Ayudas a Alexis (dueño del sitio) con todo lo relacionado al negocio.

PROYECTO: AIPickd.com
- Sitio de reviews y comparativas de herramientas de IA
- Dueño: Alexis (México), meta: negocio 100% autónomo
- Pipeline: GitHub Actions genera y publica artículos con GPT-4o cada 4 horas
- Stack: WordPress (Hostinger) + Supabase + GitHub Actions + Discord webhooks
- Estado: ~82+ artículos publicados, iniciando monetización por afiliados

PIPELINE:
- Scripts en Node.js en /scripts/
- run-pipeline.js — genera y publica artículos
- daily-report.js — reporte diario de costos/artículos
- validate-faq-schema.js — verifica schema SEO
- social-threads.js — genera contenido para redes sociales
- GitHub Actions: publica cada 4h, reportes lunes 11am UTC

AFILIADOS PRIORITARIOS (por aprobar):
- Jasper AI (PartnerStack) → 25-30% recurrente 🔴 ALTA
- Writesonic (PartnerStack) → 30% recurrente 🔴 ALTA
- Surfer SEO (PartnerStack) → 25% recurrente 🟡 MEDIA
- Semrush (ShareASale) → 40% primer mes 🔴 ALTA
- Canva (Impact) → $36/venta 🟡 MEDIA

SEO / GOOGLE:
- GSC propiedad: https://aipickd.com/ (URL prefix)
- 227 impresiones en primera semana, posición promedio 7.9
- Noindex en author/category archives (snippet WPCode activo)
- Articles con FAQPage + Article schema

PERSONALIDAD:
- Español mexicano casual, tutea a Alexis
- Directo al punto, usa datos concretos
- Si no tienes info, usa las tools disponibles para obtenerla
- Puedes ayudar con: SEO, ideas de contenido, copy de afiliados, análisis, estrategia

CAPACIDADES DE ACCIÓN (puedes ejecutarlas cuando Alexis lo pida):
- Re-encolar artículos fallidos → usa requeue_failed_articles
- Disparar el pipeline ahora mismo → usa trigger_pipeline
- Agregar keywords a la cola → usa add_keyword
- Ver salud del pipeline → usa get_pipeline_health
- Ver últimos runs de GitHub Actions → usa get_github_runs
- Auditar UN artículo específico por slug → usa audit_article (detecta fence/dup-H1/short)
- Re-renderizar UN artículo (fix HTML bugs) → usa republish_article
- Marcar un artículo malo pa' regenerar → usa regenerate_article
- Pausar el pipeline (debugging) → usa pause_pipeline
- Reanudar el pipeline → usa resume_pipeline
- Disparar cualquier otro workflow → usa dispatch_workflow

IMPORTANTE: Si te preguntan sobre stats, artículos, costos o keywords → usa las tools, no adivines.
Antes de ejecutar acciones costosas (trigger_pipeline múltiples veces), confirma con Alexis.
Pausar el pipeline es serio — siempre confirma con Alexis antes de llamar pause_pipeline.`;

// ── Tools para Claude ─────────────────────────────────────────────────────────
const TOOLS = [
  // ── READ tools ──
  {
    name: 'get_pipeline_stats',
    description: 'Estadísticas del pipeline: artículos publicados, costo del mes, artículos hoy, keywords en cola.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_recent_articles',
    description: 'Lista los últimos artículos publicados en WordPress con título, URL, tipo y calidad.',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Cuántos artículos (default 5, max 20)' },
      },
      required: [],
    },
  },
  {
    name: 'get_monthly_cost',
    description: 'Costo de OpenAI/Anthropic este mes, promedio por artículo, proyección al fin de mes.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_keywords_queue',
    description: 'Keywords pendientes de generar artículos, ordenadas por prioridad y volumen.',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Cuántas keywords (default 10, max 50)' },
      },
      required: [],
    },
  },
  {
    name: 'get_affiliates',
    description: 'Estado de los programas de afiliados: aprobados, pendientes, rechazados.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pipeline_health',
    description: 'Salud del pipeline: si está atascado, horas desde último artículo, artículos fallidos, drafts listos.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_github_runs',
    description: 'Últimos 5 runs del pipeline en GitHub Actions con su estado (success/failure/in_progress).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── ACTION tools ──
  {
    name: 'requeue_failed_articles',
    description: 'Re-encola todos los artículos con status qa_failed de vuelta a draft. El próximo cron los publicará.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'trigger_pipeline',
    description: 'Dispara el pipeline de generación en GitHub Actions ahora mismo.',
    input_schema: {
      type: 'object',
      properties: {
        gen_count: { type: 'number', description: 'Cuántos artículos generar (1-5, default 1)' },
      },
      required: [],
    },
  },
  {
    name: 'add_keyword',
    description: 'Agrega una keyword nueva a la cola de generación en Supabase.',
    input_schema: {
      type: 'object',
      properties: {
        keyword:       { type: 'string', description: 'La keyword (ej: "best AI writing tools 2026")' },
        article_type:  { type: 'string', description: 'Tipo: comparison, review, listicle, how-to (default: comparison)' },
        search_volume: { type: 'number', description: 'Volumen de búsqueda mensual estimado (default: 0)' },
        priority:      { type: 'number', description: 'Prioridad 1-10, mayor = antes (default: 5)' },
      },
      required: ['keyword'],
    },
  },

  // ── New tools (2026-05-25 brainstorm D3) ──
  {
    name: 'audit_article',
    description: 'Audita UN artículo específico por slug. Devuelve word count, quality score, status WP/Supabase, y bugs detectados (fence leftover, dup-H1, AFFILIATE leftover, etc).',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug del artículo (ej: "best-ai-tools-for-video-editing-2026")' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'republish_article',
    description: 'Dispara fix-stale-html.yml para UN artículo específico (re-renderiza HTML desde markdown, arregla fence/dup-H1). Para artículos ya publicados.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug del artículo a re-renderizar' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'regenerate_article',
    description: 'Marca un artículo malo como qa_failed y re-encola su keyword para próxima generación. NO borra el artículo de WP — solo el row de Supabase queda flagged.',
    input_schema: {
      type: 'object',
      properties: {
        slug:   { type: 'string', description: 'Slug del artículo a regenerar' },
        reason: { type: 'string', description: 'Por qué regenerar (para logs)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'pause_pipeline',
    description: 'PAUSA el pipeline de generación. El próximo cron run aborta cleanly al inicio. Usar cuando hay un bug y no quieres más publicaciones hasta arreglar. SIEMPRE confirma con Alexis antes de llamar esta tool.',
    input_schema: {
      type: 'object',
      properties: {
        reason:    { type: 'string', description: 'Por qué pausar (visible en /status)' },
        paused_by: { type: 'string', description: 'Tu user ID o "discord-bot"' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'resume_pipeline',
    description: 'Reanuda el pipeline después de un pause. El próximo cron run procesará normalmente.',
    input_schema: {
      type: 'object',
      properties: {
        resumed_by: { type: 'string', description: 'Tu user ID o "discord-bot"' },
      },
      required: [],
    },
  },
  {
    name: 'dispatch_workflow',
    description: 'Genérico — dispara cualquier workflow_dispatch del repo por su filename (ej: "fix-stale-html.yml", "cta-injector-manual.yml", "requeue-qa-failed.yml"). Useful pa\' workflows que no tienen tool dedicada.',
    input_schema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Nombre del archivo workflow (ej: "fix-stale-html.yml")' },
        inputs:   { type: 'object', description: 'Inputs del workflow_dispatch como key-value', additionalProperties: true },
      },
      required: ['workflow'],
    },
  },
];

async function runTool(name, input) {
  try {
    switch (name) {
      // read
      case 'get_pipeline_stats':    return await getStats();
      case 'get_recent_articles':   return await getRecentArticles(Math.min(input.count || 5, 20));
      case 'get_monthly_cost':      return await getMonthlyCost();
      case 'get_keywords_queue':    return await getKeywordsQueue(Math.min(input.count || 10, 50));
      case 'get_affiliates':        return await getAffiliates();
      case 'get_pipeline_health':   return await getPipelineHealth();
      case 'get_github_runs':       return await getLatestRuns();
      // action
      case 'requeue_failed_articles': return await requeueFailedArticles();
      case 'trigger_pipeline':        return await triggerPipelineRun(input.gen_count || 1);
      case 'add_keyword':             return await addKeyword(
                                        input.keyword,
                                        input.article_type || 'comparison',
                                        input.search_volume || 0,
                                        input.priority || 5
                                      );
      // 2026-05-25 brainstorm D3 — new ops tools
      case 'audit_article':           return await auditArticle(input.slug);
      case 'republish_article':       return await dispatchWorkflow('fix-stale-html.yml', { slug: input.slug });
      case 'regenerate_article':      return await regenerateArticle(input.slug, input.reason);
      case 'pause_pipeline':          return await pausePipeline(input.reason, input.paused_by);
      case 'resume_pipeline':         return await resumePipeline(input.resumed_by);
      case 'dispatch_workflow':       return await dispatchWorkflow(input.workflow, input.inputs || {});
      default: return { error: `Tool desconocida: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// ── Agentic loop con tool use ─────────────────────────────────────────────────
async function askClaude(channelId, userMessage) {
  // Lazy-load history from Supabase on first message per channel.
  // Subsequent messages use the in-memory copy. This bounds Supabase
  // reads to 1 per bot lifetime per channel, regardless of message volume.
  if (!historyLoaded.has(channelId)) {
    const persisted = await loadConversation(channelId);
    history.set(channelId, persisted);
    historyLoaded.add(channelId);
    if (persisted.length > 0) {
      console.log(`[bot] restored ${persisted.length} msgs for channel ${channelId}`);
    }
  }
  if (!history.has(channelId)) history.set(channelId, []);
  const msgs = history.get(channelId);

  msgs.push({ role: 'user', content: userMessage });
  while (msgs.length > MAX_HISTORY) msgs.shift();

  const workingMsgs = [...msgs];

  // Loop hasta end_turn (con herramientas si las necesita)
  while (true) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: workingMsgs,
    });

    if (res.stop_reason === 'end_turn') {
      const text = res.content.find((b) => b.type === 'text')?.text || '(sin respuesta)';
      msgs.push({ role: 'assistant', content: res.content });
      // Persist async — don't block the reply. Failures log inside saveConversation.
      saveConversation(channelId, msgs);
      return text;
    }

    if (res.stop_reason === 'tool_use') {
      workingMsgs.push({ role: 'assistant', content: res.content });
      const results = [];
      for (const block of res.content.filter((b) => b.type === 'tool_use')) {
        const data = await runTool(block.name, block.input);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(data) });
      }
      workingMsgs.push({ role: 'user', content: results });
      continue;
    }

    break;
  }
  return 'Hubo un error procesando tu mensaje, intenta de nuevo.';
}

// ── Helpers de Discord ────────────────────────────────────────────────────────
function shouldRespond(message) {
  if (message.author.bot) return false;
  // DMs siempre
  if (!message.guild) return true;
  // @mención
  if (message.mentions.has(discord.user)) return true;
  // Canal designado
  const chName = message.channel.name?.toLowerCase() || '';
  return AUTO_RESPOND_KEYWORDS.some((kw) => chName.includes(kw));
}

// ── Auto-thread on critical alerts ────────────────────────────────────────────
// When notify.js posts a CRITICAL or HIGH alert via webhook to #alertas, we
// pick it up here (webhook messages have message.author.bot === true but
// crucially `webhookId` is set), create a Discord thread under the alert,
// and seed the thread with a Claude-generated "suggested fix" so Alexis can
// debug in-thread instead of scrolling history. This turns a debug session
// from "go to #alertas, read, scroll, find context" into "open thread, read
// summary, act."
const ALERT_CHANNEL_KEYWORDS = ['alertas', 'alerts'];
const ALERT_SEVERITY_INDICATORS = ['🚨', '🟠', 'CRITICAL', 'HIGH']; // skip warning/info

function isAlertMessage(message) {
  if (!message.webhookId) return false;
  const chName = message.channel.name?.toLowerCase() || '';
  if (!ALERT_CHANNEL_KEYWORDS.some((kw) => chName.includes(kw))) return false;
  // Pull text from embed title + description (notify.js puts severity in title)
  const embed = message.embeds?.[0];
  const probe = `${embed?.title || ''} ${embed?.description || ''} ${message.content || ''}`;
  return ALERT_SEVERITY_INDICATORS.some((s) => probe.includes(s));
}

async function suggestFixViaClaude(alertText) {
  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: `Eres reliability engineer de AIPickd. Te llega una alerta. Tu trabajo: 1-2 frases describiendo qué probablemente está pasando, y 2-3 acciones concretas que Alexis puede ejecutar AHORA. Sé directo, sin filler. Si la alerta es ambigua, di qué info falta. Idioma: español mexicano casual.`,
      messages: [{ role: 'user', content: `Alert recibida:\n\n${alertText.slice(0, 2000)}` }],
    });
    return res.content.find((b) => b.type === 'text')?.text || '(Claude sin respuesta)';
  } catch (e) {
    return `(No pude generar sugerencia: ${e.message.slice(0, 120)})`;
  }
}

async function handleAlertMessage(message) {
  try {
    // Skip if thread already exists (re-handling same alert on bot restart)
    if (message.hasThread) return;

    const embed = message.embeds?.[0];
    const alertTitle = embed?.title || 'Alerta';
    const alertDesc  = embed?.description || message.content || '(sin descripción)';
    const threadName = (`🔥 ${alertTitle}`).replace(/[^\w\s🔥🚨🟠⚠️ñáéíóú-]/gi, '').slice(0, 100);

    const thread = await message.startThread({
      name: threadName,
      autoArchiveDuration: 1440, // 24h
      reason: 'AIPickd auto-debug thread for critical alert',
    });

    // Drop a placeholder so the thread isn't empty while Claude thinks
    const seedMsg = await thread.send('🤖 Analizando la alerta, dame 2-3 segundos...');

    const suggestion = await suggestFixViaClaude(`${alertTitle}\n\n${alertDesc}`);
    const replyChunks = [
      `**🛠 Suggested fix (Claude):**\n${suggestion}`,
      `\n_Tip: usa \`/status\`, \`/audit slug:"X"\`, o pregúntame aquí para más context._`,
    ];
    await seedMsg.edit(replyChunks.join('\n')).catch(async () => {
      // edit failed (message too old, perms, etc) — just send a new one
      await thread.send(replyChunks.join('\n')).catch(() => {});
    });
    console.log(`[auto-thread] created thread for alert: ${threadName.slice(0, 60)}`);
  } catch (e) {
    console.error('[auto-thread] failed:', e.message);
  }
}

function stripMention(text) {
  return text.replace(/<@!?\d+>/g, '').trim() || '👋';
}

async function sendChunked(channel, text, replyTo) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, MAX_REPLY_LEN));
    remaining = remaining.slice(MAX_REPLY_LEN);
  }
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0 && replyTo) {
      await replyTo.reply(chunks[i]);
    } else {
      await channel.send(chunks[i]);
    }
  }
}

// ── Slash command handler ─────────────────────────────────────────────────────
// Slash commands bypass the Claude LLM call for routine ops — instant + free.
// Each command maps to a tool function (or a small handler when special
// formatting is needed). Errors are caught and surfaced as ephemeral replies
// so a broken command doesn't spam the channel.
async function handleSlashCommand(interaction) {
  // ALL slash replies are ephemeral by default (only the invoker sees them).
  // This keeps `#general` clean when Alexis runs `/status` mid-conversation.
  await interaction.deferReply({ ephemeral: true });

  const name = interaction.commandName;
  const opts = interaction.options;
  try {
    let result;
    switch (name) {
      case 'status':
        result = await getPipelineHealth();
        break;
      case 'audit':
        result = await runTool('audit_article', { slug: opts.getString('slug') });
        break;
      case 'republish':
        result = await runTool('republish_article', { slug: opts.getString('slug') });
        break;
      case 'generate':
        result = await runTool('trigger_pipeline', { gen_count: opts.getInteger('count') || 1 });
        break;
      case 'pause':
        result = await runTool('pause_pipeline', {
          reason: opts.getString('reason'),
          paused_by: interaction.user.username,
        });
        break;
      case 'resume':
        result = await runTool('resume_pipeline', { resumed_by: interaction.user.username });
        break;
      case 'cost':
        result = await getMonthlyCost();
        break;
      case 'articles':
        result = await getRecentArticles(opts.getInteger('count') || 5);
        break;
      case 'runs':
        result = await getLatestRuns();
        break;
      case 'reset':
        await clearConversation(interaction.channelId);
        history.delete(interaction.channelId);
        historyLoaded.delete(interaction.channelId);
        result = '🧹 Memoria del canal borrada. Próximo mensaje empieza fresco.';
        break;
      default:
        result = `Comando desconocido: /${name}`;
    }
    await interaction.editReply(formatResult(result));
  } catch (e) {
    console.error(`[slash:/${name}]`, e.message);
    await interaction.editReply(`❌ Error en /${name}: \`${e.message.slice(0, 300)}\``);
  }
}

// ── Eventos de Discord ────────────────────────────────────────────────────────
discord.once(Events.ClientReady, async (c) => {
  console.log(`✅ AIPickd Bot conectado como ${c.user.tag}`);
  console.log(`   Servidor(es): ${c.guilds.cache.map((g) => g.name).join(', ')}`);
  console.log(`   Herramientas: ${TOOLS.length} (${TOOLS.filter((t) => ['requeue_failed_articles', 'trigger_pipeline', 'add_keyword', 'pause_pipeline', 'resume_pipeline', 'regenerate_article', 'republish_article', 'dispatch_workflow'].includes(t.name)).length} de acción)`);
  try {
    const reg = await registerSlashCommands(DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID);
    if (reg.skipped) {
      console.log(`   Slash commands: SKIPPED (DISCORD_CLIENT_ID not set)`);
    } else {
      console.log(`   Slash commands: ${reg.registered} registered (${reg.scope})`);
      console.log(`     ${reg.commands.join(' · ')}`);
    }
  } catch (e) {
    console.error(`   Slash command registration failed: ${e.message}`);
  }
});

discord.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await handleSlashCommand(interaction);
});

discord.on(Events.MessageCreate, async (message) => {
  // Auto-thread on critical alerts runs BEFORE the normal shouldRespond
  // gate because alert messages come from webhooks (author.bot === true)
  // which shouldRespond rejects. We want webhooks for this specific path.
  if (isAlertMessage(message)) {
    handleAlertMessage(message); // fire-and-forget so we don't block other events
    return;
  }

  if (!shouldRespond(message)) return;

  const content = stripMention(message.content);
  if (!content || content.length < 2) return;

  // Rate limit check BEFORE the Anthropic call — this is the actual cost
  // protection. We respond with a polite reject (and a Discord typing
  // indicator is skipped) so a runaway loop just bounces off cheaply.
  const rejection = checkRateLimit(message.author.id, message.channel.id);
  if (rejection) {
    await message.reply(rejection).catch(() => {});
    return;
  }

  try {
    await message.channel.sendTyping();
    const reply = await askClaude(message.channel.id, content);
    await sendChunked(message.channel, reply, message);
  } catch (err) {
    console.error('Error respondiendo:', err.message);
    await message.reply('Hubo un error 😅 Intenta de nuevo en un momento.').catch(() => {});
  }
});

// ── Arrancar ──────────────────────────────────────────────────────────────────
if (!DISCORD_TOKEN) {
  console.error('❌ Falta DISCORD_BOT_TOKEN en las variables de entorno.');
  process.exit(1);
}

discord.login(DISCORD_TOKEN).catch((e) => {
  console.error('❌ No pude conectar a Discord:', e.message);
  process.exit(1);
});
