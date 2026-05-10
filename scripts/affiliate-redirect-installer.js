#!/usr/bin/env node
/**
 * AIPickd — generate a WP mu-plugin that intercepts /go/<slug> requests,
 * logs the click to Supabase, and 302-redirects to the affiliate URL.
 *
 * This script DOES NOT install anything on its own (CI has no SFTP/SSH
 * to the WP host). It writes the plugin file to `dist/aipickd-affiliate-go.php`
 * and prints install instructions. You upload it once to
 * `wp-content/mu-plugins/` and forget it.
 *
 * Why a mu-plugin (not a regular plugin):
 *   - mu-plugins are auto-loaded by WP, no admin click needed.
 *   - One file, no autoloader, easy to audit.
 *
 * The plugin uses `wp_remote_post` to insert the click into Supabase and
 * never blocks the user's redirect on the network call (uses
 * `non-blocking` mode + low timeout).
 *
 * Usage:
 *   node scripts/affiliate-redirect-installer.js
 *   # → dist/aipickd-affiliate-go.php  (transfer to your WP host)
 *
 * Then articles can use links like https://aipickd.com/go/jasper instead
 * of a raw affiliate URL — gets you first-party click telemetry.
 */

const fs = require("node:fs");
const path = require("node:path");

const OUT_DIR = path.join(__dirname, "..", "dist");
const OUT_FILE = path.join(OUT_DIR, "aipickd-affiliate-go.php");

const PHP_TEMPLATE = `<?php
/**
 * Plugin Name: AIPickd Affiliate /go redirect
 * Description: Intercepts /go/<slug> URLs, logs the click to Supabase, redirects to the
 *              affiliate URL. Auto-loaded as a mu-plugin.
 * Version:     1.0.0
 *
 * Setup:
 *   1. Upload this file to wp-content/mu-plugins/aipickd-affiliate-go.php
 *   2. Set the constants AIPICKD_SUPABASE_URL and AIPICKD_SUPABASE_KEY in
 *      wp-config.php (the anon key is fine — Supabase RLS protects writes
 *      via a policy that only allows INSERTs to affiliate_clicks).
 *   3. Test: visit https://aipickd.com/go/jasper — should redirect.
 *
 * The expected affiliate slug → URL mapping is fetched from Supabase on
 * demand and cached in transients for 5 minutes (so adding a new
 * affiliate doesn't require redeploying this plugin).
 */

defined('ABSPATH') || exit;

if (!defined('AIPICKD_SUPABASE_URL'))  define('AIPICKD_SUPABASE_URL',  '');
if (!defined('AIPICKD_SUPABASE_KEY'))  define('AIPICKD_SUPABASE_KEY',  '');
if (!defined('AIPICKD_GO_PREFIX'))     define('AIPICKD_GO_PREFIX',     '/go/');
if (!defined('AIPICKD_DAILY_SALT'))    define('AIPICKD_DAILY_SALT',    wp_salt('auth'));

// 1) Add /go/<slug> as a virtual rewrite rule.
add_action('init', function () {
    add_rewrite_rule('^go/([a-z0-9-]+)/?$', 'index.php?aipickd_go=$matches[1]', 'top');
});

add_filter('query_vars', function ($vars) {
    $vars[] = 'aipickd_go';
    return $vars;
});

// 2) On parse_request, hijack the response when aipickd_go is set.
add_action('parse_request', function ($wp) {
    $slug = isset($wp->query_vars['aipickd_go']) ? sanitize_title($wp->query_vars['aipickd_go']) : '';
    if (!$slug) return;

    $affiliate = aipickd_get_affiliate_by_slug($slug);
    if (!$affiliate || empty($affiliate['base_url'])) {
        status_header(404);
        wp_die('Unknown affiliate', 'Not found', ['response' => 404]);
    }

    // Fire-and-forget click insert; non-blocking so the user redirects fast.
    aipickd_record_click($affiliate, $_SERVER, $_GET);

    wp_redirect(esc_url_raw($affiliate['base_url']), 302);
    exit;
});

/**
 * Fetch affiliate row by slug (lower(brand)). Cached in a transient.
 *
 * @return array|null
 */
function aipickd_get_affiliate_by_slug($slug) {
    $cache_key = 'aipickd_aff_' . md5($slug);
    $cached = get_transient($cache_key);
    if ($cached !== false) return $cached === 'NONE' ? null : $cached;

    if (!AIPICKD_SUPABASE_URL || !AIPICKD_SUPABASE_KEY) return null;

    $url = AIPICKD_SUPABASE_URL . '/rest/v1/affiliates'
         . '?select=id,brand,base_url'
         . '&status=eq.active'
         . '&brand=ilike.' . rawurlencode($slug)
         . '&limit=1';

    $resp = wp_remote_get($url, [
        'timeout'   => 5,
        'headers'   => [
            'apikey'        => AIPICKD_SUPABASE_KEY,
            'Authorization' => 'Bearer ' . AIPICKD_SUPABASE_KEY,
        ],
    ]);

    if (is_wp_error($resp) || wp_remote_retrieve_response_code($resp) !== 200) {
        set_transient($cache_key, 'NONE', 60);  // 1-minute negative cache
        return null;
    }
    $rows = json_decode(wp_remote_retrieve_body($resp), true);
    if (!is_array($rows) || empty($rows)) {
        set_transient($cache_key, 'NONE', 60);
        return null;
    }
    set_transient($cache_key, $rows[0], 5 * MINUTE_IN_SECONDS);
    return $rows[0];
}

/**
 * Record a click row in Supabase. Non-blocking.
 */
function aipickd_record_click($affiliate, $server, $get) {
    if (!AIPICKD_SUPABASE_URL || !AIPICKD_SUPABASE_KEY) return;

    $ip = isset($server['HTTP_X_FORWARDED_FOR'])
        ? trim(explode(',', $server['HTTP_X_FORWARDED_FOR'])[0])
        : ($server['REMOTE_ADDR'] ?? '');
    $daily_salt = AIPICKD_DAILY_SALT . gmdate('Y-m-d');
    $ip_hash = $ip ? hash('sha256', $ip . $daily_salt) : null;

    $row = [
        'affiliate_id'  => $affiliate['id'],
        'user_agent'    => isset($server['HTTP_USER_AGENT']) ? substr($server['HTTP_USER_AGENT'], 0, 500) : null,
        'referer'       => isset($server['HTTP_REFERER']) ? substr($server['HTTP_REFERER'], 0, 500) : null,
        'ip_hash'       => $ip_hash,
        'utm_source'    => isset($get['utm_source'])   ? substr(sanitize_text_field($get['utm_source']),   0, 100) : null,
        'utm_medium'    => isset($get['utm_medium'])   ? substr(sanitize_text_field($get['utm_medium']),   0, 100) : null,
        'utm_campaign' => isset($get['utm_campaign']) ? substr(sanitize_text_field($get['utm_campaign']), 0, 100) : null,
        'country'       => $server['HTTP_CF_IPCOUNTRY'] ?? null, // Cloudflare adds this
        'device_type'   => aipickd_detect_device($server['HTTP_USER_AGENT'] ?? ''),
    ];

    wp_remote_post(AIPICKD_SUPABASE_URL . '/rest/v1/affiliate_clicks', [
        'timeout'   => 2,
        'blocking'  => false,
        'headers'   => [
            'apikey'        => AIPICKD_SUPABASE_KEY,
            'Authorization' => 'Bearer ' . AIPICKD_SUPABASE_KEY,
            'Content-Type'  => 'application/json',
            'Prefer'        => 'return=minimal',
        ],
        'body' => wp_json_encode([$row]),
    ]);
}

function aipickd_detect_device($ua) {
    $ua = strtolower($ua);
    if (preg_match('/bot|spider|crawler|crawling|fetch/', $ua)) return 'bot';
    if (preg_match('/ipad|tablet/', $ua)) return 'tablet';
    if (preg_match('/mobile|iphone|android/', $ua)) return 'mobile';
    return 'desktop';
}

// Flush rewrite rules on activation. mu-plugins don't fire activation
// hooks, so we attempt this once via a transient flag.
add_action('init', function () {
    if (!get_transient('aipickd_go_flushed_v1')) {
        flush_rewrite_rules();
        set_transient('aipickd_go_flushed_v1', 1, YEAR_IN_SECONDS);
    }
}, 99);
`;

function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, PHP_TEMPLATE);
  console.log(`✅ Wrote ${OUT_FILE}`);
  console.log("");
  console.log("Install steps:");
  console.log("  1. SFTP this file to: <wp-root>/wp-content/mu-plugins/aipickd-affiliate-go.php");
  console.log("     (create the mu-plugins/ directory if it doesn't exist)");
  console.log("");
  console.log("  2. Add to wp-config.php (above the 'stop editing' line):");
  console.log("       define('AIPICKD_SUPABASE_URL', 'https://YOUR_PROJECT.supabase.co');");
  console.log("       define('AIPICKD_SUPABASE_KEY', 'YOUR_ANON_KEY');");
  console.log("");
  console.log("  3. Add a Supabase RLS policy on affiliate_clicks that ALLOWS INSERT for the");
  console.log("     anon role only (no SELECT/UPDATE/DELETE):");
  console.log("       CREATE POLICY anon_insert ON affiliate_clicks FOR INSERT TO anon WITH CHECK (true);");
  console.log("");
  console.log("  4. Visit https://aipickd.com/go/jasper to test (should redirect).");
}

main();
