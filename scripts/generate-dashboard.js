#!/usr/bin/env node
/**
 * AIPickd — Status dashboard generator
 * Writes a single HTML file with live metrics from Supabase + WordPress.
 * Open dashboard.html in a browser to see real-time state of the business.
 *
 * Usage: node scripts/generate-dashboard.js
 *        Open: C:\Users\guada\Downloads\Negocio\dashboard.html
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WP_USERNAME, WP_ADMIN_PASSWORD } = env;
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

async function supaRpc(sql) {
  // Use the REST API with a custom query via the PostgreSQL connection
  // Since we can't run raw SQL via REST, we'll use multiple queries
  return null;
}

async function wp(endpoint) {
  try {
    const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
      headers: { Authorization: `Basic ${wpAuth}` },
    });
    return await res.json();
  } catch (e) {
    return null;
  }
}

(async () => {
  console.log("Generating dashboard...\n");

  // Fetch metrics in parallel
  const [niches, keywords, articles, affiliates, wpPosts, wpPages] = await Promise.all([
    supa("niches"),
    supa("keywords?select=id,keyword,status,priority"),
    supa("articles?select=id,title,slug,status,word_count,generation_cost_usd,wp_post_id,created_at,niche_id,generated_by&order=created_at.desc"),
    supa("affiliates"),
    wp("posts?per_page=50&status=any&_fields=id,title,status,link,date"),
    wp("pages?per_page=20&status=any&_fields=id,title,status,link"),
  ]);

  const totalCost = articles.reduce((s, a) => s + Number(a.generation_cost_usd || 0), 0);
  const publishedCount = wpPosts?.filter((p) => p.status === "publish").length || 0;
  const draftCount = wpPosts?.filter((p) => p.status === "draft").length || 0;
  const byNiche = {};
  for (const a of articles) {
    const slug = niches.find((n) => n.id === a.niche_id)?.slug || "unknown";
    byNiche[slug] = (byNiche[slug] || 0) + 1;
  }
  const avgWords = articles.filter((a) => a.word_count).reduce((s, a) => s + a.word_count, 0) /
    Math.max(1, articles.filter((a) => a.word_count).length);

  const kwByStatus = {};
  for (const k of keywords) kwByStatus[k.status] = (kwByStatus[k.status] || 0) + 1;

  const affByStatus = {};
  for (const a of affiliates) affByStatus[a.status] = (affByStatus[a.status] || 0) + 1;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>AIPickd Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f172a; color: #e2e8f0; padding: 24px; min-height: 100vh;
  }
  .container { max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 32px; margin-bottom: 6px; background: linear-gradient(90deg, #6366f1, #10b981); -webkit-background-clip: text; background-clip: text; color: transparent; font-weight: 800; }
  .subtitle { color: #94a3b8; margin-bottom: 32px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
  .card h3 { font-size: 13px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
  .metric { font-size: 36px; font-weight: 800; color: #f1f5f9; }
  .metric-sub { font-size: 13px; color: #64748b; margin-top: 4px; }
  .progress-bar { background: #0f172a; border-radius: 8px; height: 10px; margin-top: 12px; overflow: hidden; }
  .progress-fill { background: linear-gradient(90deg, #6366f1, #10b981); height: 100%; border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 10px; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #334155; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
  td { padding: 10px; border-bottom: 1px solid #1e293b; font-size: 14px; }
  tr:hover { background: #1e293b; }
  .section { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .section h2 { font-size: 20px; margin-bottom: 20px; color: #f1f5f9; display: flex; justify-content: space-between; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .badge-pub { background: #065f46; color: #a7f3d0; }
  .badge-draft { background: #475569; color: #cbd5e1; }
  .badge-pending { background: #78350f; color: #fde68a; }
  .badge-active { background: #065f46; color: #a7f3d0; }
  .badge-queued { background: #1e3a8a; color: #bfdbfe; }
  a { color: #6366f1; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }
  .footer { text-align: center; padding: 32px 0; color: #64748b; font-size: 13px; }
  .niche-bar { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #1e293b; }
  .niche-bar strong { color: #6366f1; }
</style>
</head>
<body>
<div class="container">
  <h1>🤖 AIPickd Dashboard</h1>
  <p class="subtitle">Generado: ${new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" })} — aipickd.com</p>

  <!-- Main metrics grid -->
  <div class="grid">
    <div class="card">
      <h3>Artículos totales</h3>
      <div class="metric">${articles.length}</div>
      <div class="metric-sub">Promedio ${Math.round(avgWords)} palabras</div>
    </div>
    <div class="card">
      <h3>En WordPress (live)</h3>
      <div class="metric">${publishedCount}</div>
      <div class="metric-sub">${draftCount} drafts + ${publishedCount} publicados</div>
    </div>
    <div class="card">
      <h3>Costo IA total</h3>
      <div class="metric">$${totalCost.toFixed(2)}</div>
      <div class="metric-sub">~$${(totalCost / Math.max(1, articles.length)).toFixed(3)}/artículo</div>
    </div>
    <div class="card">
      <h3>Keywords queue</h3>
      <div class="metric">${kwByStatus.queued || 0}</div>
      <div class="metric-sub">${kwByStatus.published || 0} ya usadas</div>
      <div class="progress-bar"><div class="progress-fill" style="width: ${(kwByStatus.published || 0) / keywords.length * 100}%"></div></div>
    </div>
  </div>

  <div class="two-col">
    <!-- Content by niche -->
    <div class="section">
      <h2>📊 Contenido por nicho</h2>
      ${niches.map((n) => {
        const count = byNiche[n.slug] || 0;
        const pct = articles.length > 0 ? (count / articles.length * 100) : 0;
        return `<div class="niche-bar"><span>${n.name}</span><strong>${count} artículos (${pct.toFixed(0)}%)</strong></div>`;
      }).join("")}
    </div>

    <!-- Affiliate programs -->
    <div class="section">
      <h2>💰 Programas de afiliados <span class="badge badge-pending">${affByStatus.pending || 0} pending</span></h2>
      <table>
        <tr><th>Marca</th><th>Network</th><th>Status</th></tr>
        ${affiliates.slice(0, 12).map((a) => `
          <tr>
            <td>${a.brand}</td>
            <td>${a.network || "-"}</td>
            <td><span class="badge badge-${a.status}">${a.status}</span></td>
          </tr>
        `).join("")}
      </table>
      ${affiliates.length > 12 ? `<p style="margin-top:12px; color:#64748b; font-size:13px;">+${affiliates.length - 12} más en Supabase</p>` : ""}
    </div>
  </div>

  <!-- Recent articles -->
  <div class="section">
    <h2>📝 Últimos 15 artículos</h2>
    <table>
      <tr><th>Título</th><th>Palabras</th><th>Generado por</th><th>WP</th><th>Status</th></tr>
      ${articles.slice(0, 15).map((a) => {
        const wpPost = wpPosts?.find((p) => p.id === a.wp_post_id);
        return `
          <tr>
            <td>${a.title}</td>
            <td>${a.word_count || "-"}</td>
            <td>${a.generated_by || "-"}</td>
            <td>${a.wp_post_id ? `<a href="https://aipickd.com/wp-admin/post.php?post=${a.wp_post_id}&action=edit" target="_blank">#${a.wp_post_id}</a>` : "-"}</td>
            <td>
              ${wpPost?.status === "publish" ? '<span class="badge badge-pub">Live</span>' :
                wpPost?.status === "draft" ? '<span class="badge badge-draft">Draft</span>' :
                `<span class="badge badge-draft">${a.status}</span>`}
            </td>
          </tr>
        `;
      }).join("")}
    </table>
  </div>

  <!-- Quick links -->
  <div class="section">
    <h2>🔗 Enlaces rápidos</h2>
    <div class="grid" style="margin-bottom:0;">
      <div class="card"><h3>WordPress Admin</h3><a href="https://aipickd.com/wp-admin" target="_blank">aipickd.com/wp-admin →</a></div>
      <div class="card"><h3>Site Live</h3><a href="https://aipickd.com" target="_blank">aipickd.com →</a></div>
      <div class="card"><h3>Supabase</h3><a href="https://supabase.com/dashboard/project/dfftywgdvntnkybffnui" target="_blank">Database →</a></div>
      <div class="card"><h3>OpenAI Usage</h3><a href="https://platform.openai.com/usage" target="_blank">Ver gasto →</a></div>
    </div>
  </div>

  <div class="footer">
    Generado por <code>scripts/generate-dashboard.js</code> • Ejecuta de nuevo pa' refrescar
  </div>
</div>
</body>
</html>`;

  const outPath = path.join(__dirname, "..", "dashboard.html");
  fs.writeFileSync(outPath, html);
  console.log(`✅ Dashboard → ${outPath}`);
  console.log(`   Abre en browser: file:///${outPath.replace(/\\/g, "/")}`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
