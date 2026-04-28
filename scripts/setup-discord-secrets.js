#!/usr/bin/env node
/**
 * setup-discord-secrets.js
 *
 * Imprime los comandos exactos para añadir los Discord webhooks
 * como GitHub Secrets (los que ya tenemos configurados).
 *
 * Usage:
 *   node scripts/setup-discord-secrets.js
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const env = {};
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch {}

const REPO = 'guadarramaalexis504-hash/aipickd-pipeline';

const webhooks = {
  DISCORD_WEBHOOK_URL: env.DISCORD_WEBHOOK_URL,
  DISCORD_WEBHOOK_ARTICULOS: env.DISCORD_WEBHOOK_ARTICULOS,
  DISCORD_WEBHOOK_ALERTAS: env.DISCORD_WEBHOOK_ALERTAS,
  DISCORD_WEBHOOK_PIPELINE: env.DISCORD_WEBHOOK_PIPELINE,
  DISCORD_WEBHOOK_REPORTES: env.DISCORD_WEBHOOK_REPORTES,
};

console.log('\n🔐 GitHub Secrets — Discord Webhooks para AIPickd HQ');
console.log('═'.repeat(60));
console.log('\n📋 Ve a esta URL y añade uno por uno:');
console.log(`   https://github.com/${REPO}/settings/secrets/actions/new`);
console.log('\nO si tienes gh CLI instalado, corre estos comandos:\n');

for (const [name, value] of Object.entries(webhooks)) {
  if (!value) {
    console.log(`# ⚠️  ${name}: no encontrado en .env`);
    continue;
  }
  console.log(`gh secret set ${name} \\`);
  console.log(`  --body "${value}" \\`);
  console.log(`  --repo ${REPO}\n`);
}

console.log('─'.repeat(60));
console.log('\n✅ Valores actuales en .env:');
for (const [name, value] of Object.entries(webhooks)) {
  const status = value ? '✅' : '❌ FALTA';
  const preview = value ? `${value.slice(0, 45)}...` : 'no configurado';
  console.log(`  ${status} ${name}: ${preview}`);
}

console.log('\n💡 Los webhooks apuntan al server "AIPickd HQ" en Discord.');
console.log('   Una vez que añadas los secrets en GitHub, el pipeline');
console.log('   te avisará automáticamente en Discord después de cada corrida.\n');
