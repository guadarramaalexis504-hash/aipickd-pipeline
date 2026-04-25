#!/usr/bin/env node
/**
 * AIPickd — Weekly email digest sender
 *
 * Sends a weekly summary email to your inbox with key business metrics.
 * Schedule via Task Scheduler every Monday at 9 AM.
 *
 * Setup (one-time, 3 min):
 *   1. Enable 2FA on your Gmail (security.google.com)
 *   2. Generate App Password: myaccount.google.com/apppasswords
 *      - Pick "Mail" and "Windows Computer"
 *      - Copy the 16-character password
 *   3. Add to .env:
 *      GMAIL_APP_PASSWORD="xxxx xxxx xxxx xxxx"
 *      DIGEST_TO_EMAIL="guadarramaalexis504@gmail.com"
 *
 * Usage:
 *   node scripts/email-digest.js              # sends weekly digest
 *   node scripts/email-digest.js --test       # sends to console only
 *
 * Dependencies: nodemailer (auto-installed if missing)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const TEST_MODE = process.argv.includes("--test");

// Lazy-install nodemailer if not present
let nodemailer;
try {
  nodemailer = require("nodemailer");
} catch {
  if (!TEST_MODE) {
    console.log("Installing nodemailer...");
    execSync("npm install nodemailer --no-save", { cwd: path.join(__dirname, ".."), stdio: "inherit" });
    nodemailer = require("nodemailer");
  }
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WP_USERNAME, WP_ADMIN_PASSWORD, GMAIL_APP_PASSWORD, DIGEST_TO_EMAIL } = env;
const wpAuth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");

async function supa(endpoint) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  return await res.json();
}

async function wp(endpoint) {
  try {
    const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
      headers: { Authorization: `Basic ${wpAuth}` },
    });
    return await res.json();
  } catch {
    return null;
  }
}

(async () => {
  const weekAgo = new Date(Date.now() - 7 * 86400_000);

  const [articles, keywords, affiliates, wpPosts] = await Promise.all([
    supa("articles?select=id,title,status,word_count,generation_cost_usd,created_at,wp_url,featured_image_url"),
    supa("keywords?select=status"),
    supa("affiliates?select=brand,status"),
    wp("posts?per_page=10&status=publish&orderby=date&order=desc&_fields=id,title,link,date"),
  ]);

  const articlesWeek = articles.filter((a) => new Date(a.created_at) >= weekAgo);
  const costWeek = articlesWeek.reduce((s, a) => s + Number(a.generation_cost_usd || 0), 0);
  const liveCount = articles.filter((a) => a.status === "published").length;
  const totalWords = articles.reduce((s, a) => s + (a.word_count || 0), 0);
  const kwQueued = keywords.filter((k) => k.status === "queued").length;
  const affActive = affiliates.filter((a) => a.status === "active").length;

  const now = new Date().toLocaleDateString("es-MX", { timeZone: "America/Mexico_City" });

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body { font-family: -apple-system, 'Segoe UI', sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; padding: 20px; background: #f8fafc; }
  h1 { background: linear-gradient(90deg, #6366f1, #10b981); -webkit-background-clip: text; background-clip: text; color: transparent; font-size: 28px; }
  .metric-card { background: white; padding: 16px; border-radius: 8px; margin: 10px 0; border-left: 4px solid #6366f1; }
  .metric-value { font-size: 28px; font-weight: 800; color: #6366f1; }
  .metric-label { color: #64748b; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
  a { color: #6366f1; text-decoration: none; }
  .footer { color: #94a3b8; font-size: 12px; margin-top: 20px; }
</style></head>
<body>
  <h1>🤖 AIPickd Weekly — ${now}</h1>
  <p>Hola manito, aquí está tu reporte semanal de AIPickd.</p>

  <div class="metric-card">
    <div class="metric-label">Artículos LIVE en tu site</div>
    <div class="metric-value">${liveCount}</div>
    <div>+${articlesWeek.length} generados esta semana</div>
  </div>

  <div class="metric-card">
    <div class="metric-label">Palabras totales publicadas</div>
    <div class="metric-value">${totalWords.toLocaleString()}</div>
    <div>= ${Math.round(totalWords / liveCount)} palabras promedio</div>
  </div>

  <div class="metric-card">
    <div class="metric-label">Gasto IA esta semana</div>
    <div class="metric-value">$${costWeek.toFixed(2)} USD</div>
    <div>De $10/día de presupuesto</div>
  </div>

  <div class="metric-card">
    <div class="metric-label">Keywords en cola</div>
    <div class="metric-value">${kwQueued}</div>
    <div>~${Math.round(kwQueued / 30)} meses más de contenido futuro</div>
  </div>

  <div class="metric-card">
    <div class="metric-label">Afiliados activos</div>
    <div class="metric-value">${affActive} / ${affiliates.length}</div>
    ${affActive === 0 ? '<div style="color:#dc2626;">⚠️ Aplica a Impact.com y PartnerStack para desbloquear ingresos</div>' : ""}
  </div>

  <h2 style="margin-top:30px;">📝 Últimos 5 artículos publicados:</h2>
  <ul>${(wpPosts || []).slice(0, 5).map((p) => `<li><a href="${p.link}">${p.title.rendered}</a></li>`).join("")}</ul>

  <h2 style="margin-top:30px;">✅ Checklist de la semana:</h2>
  <ul>
    <li>[ ] Revisar Google Search Console (impressions vs clicks)</li>
    <li>[ ] Checar si algún afiliado te aprobó (email)</li>
    <li>[ ] Leer 2-3 artículos al azar y confirmar calidad</li>
    <li>[ ] Revisar dashboard.html</li>
  </ul>

  <div class="footer">
    Generado por <code>scripts/email-digest.js</code><br>
    Dashboard: file:///C:/Users/guada/Downloads/Negocio/dashboard.html<br>
    Site: https://aipickd.com
  </div>
</body>
</html>
  `;

  if (TEST_MODE) {
    console.log("=== TEST MODE (email not sent) ===");
    console.log(`Would send to: ${DIGEST_TO_EMAIL || env.WP_USERNAME}`);
    console.log(`Subject: 📊 AIPickd Weekly — ${now}`);
    console.log(`\nHTML preview saved to: reports/email-preview.html`);
    const out = path.join(__dirname, "..", "reports", "email-preview.html");
    if (!fs.existsSync(path.dirname(out))) fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    return;
  }

  if (!GMAIL_APP_PASSWORD) {
    console.log("❌ GMAIL_APP_PASSWORD not set in .env — cannot send.");
    console.log("\n📋 One-time setup:");
    console.log("   1. Enable 2FA: https://myaccount.google.com/security");
    console.log("   2. App password: https://myaccount.google.com/apppasswords");
    console.log("   3. Add to .env: GMAIL_APP_PASSWORD=\"xxxx xxxx xxxx xxxx\"");
    console.log("\n💡 Or run with --test to preview the email.");
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: env.WP_USERNAME, pass: GMAIL_APP_PASSWORD },
  });

  const info = await transporter.sendMail({
    from: `"AIPickd Bot" <${env.WP_USERNAME}>`,
    to: DIGEST_TO_EMAIL || env.WP_USERNAME,
    subject: `📊 AIPickd Weekly — ${now}`,
    html,
  });

  console.log(`✅ Email sent: ${info.messageId}`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
