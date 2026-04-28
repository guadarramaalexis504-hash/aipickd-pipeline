#!/usr/bin/env node
/**
 * set-github-secrets-api.js
 *
 * Agrega los Discord webhooks como GitHub Secrets usando la REST API de GitHub.
 * Requiere libsodium-wrappers para encriptar los valores.
 *
 * ANTES de correr: proporciona el token vía variable de entorno:
 *   $env:GH_TOKEN = "ghp_..."; node scripts/set-github-secrets-api.js
 * o en una línea:
 *   GH_TOKEN=ghp_... node scripts/set-github-secrets-api.js
 *
 * El token necesita permiso: repo → secrets (write)
 * Crea uno en: https://github.com/settings/tokens/new?scopes=repo
 */

const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
const env = {};
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch {}

const REPO  = 'guadarramaalexis504-hash/aipickd-pipeline';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

const SECRETS_TO_ADD = [
  { name: 'DISCORD_WEBHOOK_URL',       value: env.DISCORD_WEBHOOK_ARTICULOS || env.DISCORD_WEBHOOK_URL },
  { name: 'DISCORD_WEBHOOK_ARTICULOS', value: env.DISCORD_WEBHOOK_ARTICULOS },
  { name: 'DISCORD_WEBHOOK_ALERTAS',   value: env.DISCORD_WEBHOOK_ALERTAS },
  { name: 'DISCORD_WEBHOOK_PIPELINE',  value: env.DISCORD_WEBHOOK_PIPELINE },
  { name: 'DISCORD_WEBHOOK_REPORTES',  value: env.DISCORD_WEBHOOK_REPORTES },
].filter(s => s.value);

async function getPublicKey() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/secrets/public-key`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aipickd-setup/1.0',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get public key: ${res.status} ${body}`);
  }
  return res.json();
}

async function encryptSecret(publicKeyBase64, secretValue) {
  // GitHub uses libsodium crypto_box_seal (X25519 + XSalsa20Poly1305)
  // We use the Web Crypto API + manual X25519 if libsodium not installed,
  // OR load libsodium-wrappers if available.

  try {
    const sodium = require('libsodium-wrappers');
    await sodium.ready;

    const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
    const msg = sodium.from_string(secretValue);
    const encrypted = sodium.crypto_box_seal(msg, key);
    return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        'libsodium-wrappers not installed. Run:\n  npm install libsodium-wrappers\nthen retry.'
      );
    }
    throw e;
  }
}

async function setSecret(name, value, keyId, encryptedValue) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/secrets/${name}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'aipickd-setup/1.0',
      },
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: keyId,
      }),
    }
  );

  if (res.status === 201 || res.status === 204) return { ok: true };
  const body = await res.text();
  return { ok: false, status: res.status, body };
}

async function main() {
  console.log('🔐 GitHub Secrets via REST API');
  console.log(`   Repo: ${REPO}`);

  if (!TOKEN) {
    console.error('\n❌ No token found!\n');
    console.error('Crea un Personal Access Token en:');
    console.error('  https://github.com/settings/tokens/new?scopes=repo\n');
    console.error('Luego corre:');
    console.error('  $env:GH_TOKEN="ghp_TU_TOKEN"; node scripts/set-github-secrets-api.js\n');
    process.exit(1);
  }

  if (SECRETS_TO_ADD.length === 0) {
    console.error('❌ No secrets found in .env — check DISCORD_WEBHOOK_* variables');
    process.exit(1);
  }

  console.log(`   Secrets: ${SECRETS_TO_ADD.map(s => s.name).join(', ')}\n`);

  // Get repo public key
  console.log('🔑 Getting repo public key...');
  let keyData;
  try {
    keyData = await getPublicKey();
    console.log(`   Key ID: ${keyData.key_id}\n`);
  } catch (e) {
    console.error('❌', e.message);
    if (e.message.includes('401') || e.message.includes('403')) {
      console.error('\nEl token no tiene permisos suficientes.');
      console.error('Necesitas: repo scope (o secrets:write en fine-grained PAT)');
    }
    process.exit(1);
  }

  // Add each secret
  let success = 0;
  for (const secret of SECRETS_TO_ADD) {
    process.stdout.write(`  Adding ${secret.name}... `);
    try {
      const encrypted = await encryptSecret(keyData.key, secret.value);
      const result = await setSecret(secret.name, secret.value, keyData.key_id, encrypted);
      if (result.ok) {
        console.log('✅');
        success++;
      } else {
        console.log(`❌ HTTP ${result.status}: ${result.body}`);
      }
    } catch (e) {
      console.log(`❌ ${e.message}`);
      if (e.message.includes('libsodium-wrappers')) {
        console.log('\n💡 Installing libsodium-wrappers...');
        const { execSync } = require('child_process');
        try {
          execSync('npm install libsodium-wrappers --no-save', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
          console.log('✅ Installed. Re-running...\n');
          // Retry this secret
          const encrypted = await encryptSecret(keyData.key, secret.value);
          const result = await setSecret(secret.name, secret.value, keyData.key_id, encrypted);
          if (result.ok) { console.log(`  ${secret.name}: ✅`); success++; }
          else console.log(`  ${secret.name}: ❌ HTTP ${result.status}`);
        } catch (e2) {
          console.error('Failed to install libsodium-wrappers:', e2.message);
        }
      }
    }
  }

  console.log(`\n${success === SECRETS_TO_ADD.length ? '🎉' : '⚠️'} ${success}/${SECRETS_TO_ADD.length} secrets added`);
  if (success > 0) {
    console.log(`   Check: https://github.com/${REPO}/settings/secrets/actions`);
  }
}

main().catch(console.error);
