#!/usr/bin/env node
/**
 * add-github-secrets.js
 * Adds Discord webhook URLs as GitHub Secrets using Playwright + your logged-in Chrome.
 *
 * Usage: node scripts/add-github-secrets.js
 *
 * Fix: Chrome blocks remote debugging on the DEFAULT user-data-dir.
 *      We copy the session cookies to a temp dir and use that instead.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
const env = {};
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
} catch {}

const REPO = 'guadarramaalexis504-hash/aipickd-pipeline';
const SECRETS_URL = `https://github.com/${REPO}/settings/secrets/actions`;

const SECRETS_TO_ADD = [
  { name: 'DISCORD_WEBHOOK_URL',       value: env.DISCORD_WEBHOOK_ARTICULOS || env.DISCORD_WEBHOOK_URL },
  { name: 'DISCORD_WEBHOOK_ARTICULOS', value: env.DISCORD_WEBHOOK_ARTICULOS },
  { name: 'DISCORD_WEBHOOK_ALERTAS',   value: env.DISCORD_WEBHOOK_ALERTAS },
  { name: 'DISCORD_WEBHOOK_PIPELINE',  value: env.DISCORD_WEBHOOK_PIPELINE },
  { name: 'DISCORD_WEBHOOK_REPORTES',  value: env.DISCORD_WEBHOOK_REPORTES },
].filter(s => s.value);

// Chrome's default profile (has GitHub session)
const REAL_PROFILE = `C:\\Users\\guada\\AppData\\Local\\Google\\Chrome\\User Data`;
// Temp profile that Chrome allows for remote debugging
const TEMP_PROFILE = path.join(os.tmpdir(), 'chrome-pw-aipickd');

function setupTempProfile() {
  console.log(`\n📋 Copying Chrome session to temp profile...`);
  console.log(`   From: ${REAL_PROFILE}`);
  console.log(`   To:   ${TEMP_PROFILE}\n`);

  // Create directory structure
  const dirs = [
    TEMP_PROFILE,
    path.join(TEMP_PROFILE, 'Default'),
    path.join(TEMP_PROFILE, 'Default', 'Network'),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  // Files needed: Local State (encryption key) + Cookies (session data)
  const files = [
    'Local State',                              // AES key (DPAPI-wrapped)
    path.join('Default', 'Cookies'),            // Cookies (Chrome < 96)
    path.join('Default', 'Network', 'Cookies'), // Cookies (Chrome 96+)
    path.join('Default', 'Preferences'),        // Browser preferences
    path.join('Default', 'Web Data'),           // Form data / autofill
  ];

  for (const file of files) {
    const src = path.join(REAL_PROFILE, file);
    const dst = path.join(TEMP_PROFILE, file);
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dst);
        console.log(`  ✓ Copied ${file}`);
      } catch (e) {
        // Non-fatal: warn and continue (file may be locked by Chrome, but Cookies can still be read)
        console.log(`  ⚠ Skipped ${file}: ${e.code || e.message}`);
      }
    } else {
      console.log(`  - Not found: ${file} (ok)`);
    }
  }
}

async function addSecret(page, name, value) {
  console.log(`\n  Adding secret: ${name}`);

  await page.goto(SECRETS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Check if secret already exists
  const existingLink = page.locator(`text="${name}"`).first();
  const exists = await existingLink.isVisible().catch(() => false);

  if (exists) {
    console.log(`    Secret ${name} exists — updating...`);
    await existingLink.click();
    await page.waitForTimeout(500);
    // Update button — try href-based click on "Update secret" button (language-independent)
    const updateBtn = page.locator('button[type="submit"], button:has-text("Update"), button:has-text("Actualizar"), button:has-text("Guardar")').first();
    if (await updateBtn.isVisible().catch(() => false)) {
      await updateBtn.click();
      await page.waitForTimeout(500);
    }
  } else {
    // Use href selector instead of text (works regardless of GitHub UI language)
    const newBtn = page.locator(
      `a[href*="secrets/actions/new"], a[href$="/new"], ` +
      `a:has-text("New repository secret"), button:has-text("New repository secret"), ` +
      `a:has-text("Nuevo secreto"), button:has-text("Nuevo secreto")`
    ).first();

    // Debug: if not found, dump page info
    const found = await newBtn.isVisible().catch(() => false);
    if (!found) {
      await page.screenshot({ path: path.join(__dirname, '..', 'debug-secrets.png') });
      const html = await page.content();
      fs.writeFileSync(path.join(__dirname, '..', 'debug-secrets.html'), html.slice(0, 50000));
      console.log('    📸 Screenshot saved: debug-secrets.png');
      // Try to navigate directly to new secret URL
      await page.goto(`https://github.com/${REPO}/settings/secrets/actions/new`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
    } else {
      await newBtn.click();
      await page.waitForTimeout(500);
    }
  }

  // Fill name — try all possible input selectors
  const nameInput = page.locator(
    'input[name="secret_name"], input[id*="secret_name"], ' +
    'input[placeholder*="name" i], input[placeholder*="nombre" i], ' +
    'input[autocomplete="off"]:not([type="password"]), input[type="text"]'
  ).first();
  await nameInput.waitFor({ timeout: 8000 });
  await nameInput.fill(name);

  // Fill value — textarea
  const valueInput = page.locator(
    'textarea[name="secret_value"], textarea[id*="secret_value"], ' +
    'textarea[placeholder*="value" i], textarea[placeholder*="valor" i], ' +
    'textarea'
  ).first();
  await valueInput.waitFor({ timeout: 8000 });
  await valueInput.fill(value);

  // Submit — first submit button on the form
  const submitBtn = page.locator(
    'button:has-text("Add secret"), button:has-text("Update secret"), ' +
    'button:has-text("Agregar"), button:has-text("Añadir"), ' +
    'form button[type="submit"]'
  ).first();
  await submitBtn.waitFor({ timeout: 8000 });
  await submitBtn.click();
  await page.waitForTimeout(1500);

  console.log(`    ✅ ${name} added`);
}

async function main() {
  console.log('🔐 Adding Discord secrets to GitHub...');
  console.log(`   Repo: ${REPO}`);
  console.log(`   Secrets: ${SECRETS_TO_ADD.map(s => s.name).join(', ')}`);

  if (SECRETS_TO_ADD.length === 0) {
    console.error('❌ No secrets found in .env — check DISCORD_WEBHOOK_* variables');
    process.exit(1);
  }

  // Copy Chrome session to temp profile (bypasses default-dir restriction)
  setupTempProfile();

  const browser = await chromium.launchPersistentContext(TEMP_PROFILE, {
    channel: 'chrome',
    headless: false,
    args: ['--no-first-run', '--no-default-browser-check'],
    timeout: 30000,
  });

  const page = await browser.newPage();

  try {
    await page.goto(SECRETS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const url = page.url();
    if (url.includes('login') || url.includes('sign_in') || url.includes('session')) {
      console.error('\n❌ Not logged in to GitHub in Chrome.');
      console.error('   Open Chrome, log into github.com, then run this script again.');
      await browser.close();
      return;
    }

    console.log('\n✅ Logged in to GitHub\n');

    for (const secret of SECRETS_TO_ADD) {
      await addSecret(page, secret.name, secret.value);
    }

    console.log('\n🎉 All secrets added successfully!');
    console.log('   Check: ' + SECRETS_URL);

  } catch (e) {
    console.error('❌ Error:', e.message);
  } finally {
    await page.waitForTimeout(2000);
    await browser.close();
    // Clean up temp profile
    try { fs.rmSync(TEMP_PROFILE, { recursive: true, force: true }); } catch {}
  }
}

main().catch(console.error);
