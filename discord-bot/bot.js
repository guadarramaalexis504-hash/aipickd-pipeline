#!/usr/bin/env node
/**
 * AIPickd — Discord Bot con Claude AI
 *
 * Un asistente inteligente para AIPickd que vive en tu Discord.
 * Responde preguntas, da stats del pipeline, y ayuda con estrategia —
 * todo desde tu cel, sin necesidad de tener la laptop prendida.
 *
 * Configuración:
 *   1. Crea tu bot en https://discord.com/developers/applications
 *   2. Activa "Message Content Intent" en Bot → Privileged Gateway Intents
 *   3. Copia el Token y ponlo en las env vars de Railway como DISCORD_BOT_TOKEN
 *   4. Invita el bot a tu server con: https://discord.com/api/oauth2/authorize?client_id=TU_CLIENT_ID&permissions=277025442816&scope=bot
 *
 * El bot responde cuando:
 *   - Lo @mencionas en cualquier canal
 *   - Escribes en un canal cuyo nombre contenga: claude, bot, aipickd-ai
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
} = require('./supabase');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_BOT_TOKEN;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const MODEL           = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';
const MAX_HISTORY     = 20;   // mensajes por canal que recuerda
const MAX_REPLY_LEN   = 1900; // chars por mensaje de Discord

// Canales donde el bot responde a TODO (sin necesidad de @mención)
const AUTO_RESPOND_KEYWORDS = ['claude', 'bot', 'aipickd-ai', 'asistente'];

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

// Historial de conversación por canal (en memoria, se reinicia con el bot)
const history = new Map(); // channelId → Message[]

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

IMPORTANTE: Si te preguntan sobre stats, artículos, costos o keywords → usa las tools, no adivines.`;

// ── Tools para Claude ─────────────────────────────────────────────────────────
const TOOLS = [
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
];

async function runTool(name, input) {
  try {
    switch (name) {
      case 'get_pipeline_stats':   return await getStats();
      case 'get_recent_articles':  return await getRecentArticles(Math.min(input.count || 5, 20));
      case 'get_monthly_cost':     return await getMonthlyCost();
      case 'get_keywords_queue':   return await getKeywordsQueue(Math.min(input.count || 10, 50));
      case 'get_affiliates':       return await getAffiliates();
      default: return { error: `Tool desconocida: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// ── Agentic loop con tool use ─────────────────────────────────────────────────
async function askClaude(channelId, userMessage) {
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

// ── Eventos de Discord ────────────────────────────────────────────────────────
discord.once(Events.ClientReady, (c) => {
  console.log(`✅ AIPickd Bot conectado como ${c.user.tag}`);
  console.log(`   Servidor(es): ${c.guilds.cache.map((g) => g.name).join(', ')}`);
});

discord.on(Events.MessageCreate, async (message) => {
  if (!shouldRespond(message)) return;

  const content = stripMention(message.content);
  if (!content || content.length < 2) return;

  try {
    await message.channel.sendTyping();
    const reply = await askClaude(message.channel.id, content);
    await sendChunked(message.channel, reply, message);
  } catch (err) {
    console.error('Error respondiendo:', err.message);
    await message.reply('Hubo un error 😅 Intenta de nuevo en un momento.').catch(() => {});
  }
});

// Typing indicator cada 8s para respuestas largas
discord.on(Events.MessageCreate, async (message) => {
  // handled above
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
