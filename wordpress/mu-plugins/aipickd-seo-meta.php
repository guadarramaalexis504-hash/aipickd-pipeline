<?php
/**
 * Plugin Name: AIPickd SEO Meta & Social Cards
 * Description: Outputs <meta name="description">, Open Graph, and Twitter Card
 *              tags in <head> for every post/page. The site has no SEO plugin
 *              (no Yoast/Rank Math), so Google was auto-generating snippets and
 *              social shares had no preview card. This renders the meta
 *              description the pipeline already stores (excerpt / Yoast metadesc
 *              field) and builds rich social cards from the featured image.
 * Version:     1.0.0
 *
 * Setup (one-time, ~1 min):
 *   1. Upload this file to wp-content/mu-plugins/aipickd-seo-meta.php
 *      (via Hostinger File Manager → public_html/wp-content/mu-plugins/ —
 *       create the mu-plugins folder if it doesn't exist).
 *   2. That's it. mu-plugins auto-activate — no admin step needed.
 *   3. Verify: view-source on any article and search for "og:image".
 *
 * Zero config. Reads everything from existing post data. If you later install
 * Yoast/Rank Math, delete this file to avoid duplicate tags.
 */

defined('ABSPATH') || exit;

if (!defined('AIPICKD_SITE_NAME'))    define('AIPICKD_SITE_NAME', 'AIPickd');
if (!defined('AIPICKD_TWITTER_HANDLE')) define('AIPICKD_TWITTER_HANDLE', '@aipickd');
// Verified default OG image URL. Leave '' until you upload a real one to WP
// Media — a 404 default shows a broken card, so we omit og:image entirely when
// a post has neither a featured image nor this default. (Most posts have a
// featured image, so og:image is populated per-article regardless.)
if (!defined('AIPICKD_DEFAULT_OG_IMAGE')) {
    define('AIPICKD_DEFAULT_OG_IMAGE', '');
}

/**
 * Build the best available meta description for a post:
 *   1. Yoast metadesc field (the pipeline sets _yoast_wpseo_metadesc)
 *   2. Post excerpt (the pipeline sets this from meta_description)
 *   3. First ~155 chars of stripped content
 */
function aipickd_meta_description($post) {
    $desc = get_post_meta($post->ID, '_yoast_wpseo_metadesc', true);
    if (!$desc) {
        $desc = has_excerpt($post->ID) ? get_the_excerpt($post) : '';
    }
    if (!$desc) {
        $desc = wp_strip_all_tags(strip_shortcodes($post->post_content));
    }
    $desc = trim(preg_replace('/\s+/', ' ', $desc));
    if (mb_strlen($desc) > 160) {
        $desc = mb_substr($desc, 0, 157) . '…';
    }
    return $desc;
}

function aipickd_og_image($post) {
    $img = get_the_post_thumbnail_url($post->ID, 'full');
    if ($img) return $img;
    return AIPICKD_DEFAULT_OG_IMAGE ?: ''; // '' → image tags omitted below
}

add_action('wp_head', function () {
    // Only emit rich tags on singular content; emit minimal site tags elsewhere.
    if (is_singular()) {
        $post = get_queried_object();
        if (!$post || empty($post->ID)) return;

        $title = wp_strip_all_tags(get_the_title($post));
        $desc  = aipickd_meta_description($post);
        $url   = get_permalink($post);
        $image = aipickd_og_image($post);
        $type  = 'article';

        echo "\n<!-- AIPickd SEO Meta -->\n";
        printf('<meta name="description" content="%s">' . "\n", esc_attr($desc));

        // Open Graph
        printf('<meta property="og:type" content="%s">' . "\n", esc_attr($type));
        printf('<meta property="og:title" content="%s">' . "\n", esc_attr($title));
        printf('<meta property="og:description" content="%s">' . "\n", esc_attr($desc));
        printf('<meta property="og:url" content="%s">' . "\n", esc_url($url));
        if ($image) printf('<meta property="og:image" content="%s">' . "\n", esc_url($image));
        printf('<meta property="og:site_name" content="%s">' . "\n", esc_attr(AIPICKD_SITE_NAME));

        // Article timestamps (freshness signal for crawlers)
        $published = get_the_date('c', $post);
        $modified  = get_the_modified_date('c', $post);
        if ($published) printf('<meta property="article:published_time" content="%s">' . "\n", esc_attr($published));
        if ($modified)  printf('<meta property="article:modified_time" content="%s">' . "\n", esc_attr($modified));

        // Twitter Card — "large image" only when we actually have an image.
        printf('<meta name="twitter:card" content="%s">' . "\n", $image ? 'summary_large_image' : 'summary');
        printf('<meta name="twitter:title" content="%s">' . "\n", esc_attr($title));
        printf('<meta name="twitter:description" content="%s">' . "\n", esc_attr($desc));
        if ($image) printf('<meta name="twitter:image" content="%s">' . "\n", esc_url($image));
        if (AIPICKD_TWITTER_HANDLE) {
            printf('<meta name="twitter:site" content="%s">' . "\n", esc_attr(AIPICKD_TWITTER_HANDLE));
        }
        echo "<!-- /AIPickd SEO Meta -->\n";
    } else {
        // Home / archives: minimal OG so shared category/home links look decent.
        $title = wp_get_document_title();
        $desc  = get_bloginfo('description');

        echo "\n<!-- AIPickd SEO Meta -->\n";
        if ($desc) printf('<meta name="description" content="%s">' . "\n", esc_attr($desc));
        printf('<meta property="og:type" content="%s">' . "\n", 'website');
        printf('<meta property="og:title" content="%s">' . "\n", esc_attr($title));
        if ($desc) printf('<meta property="og:description" content="%s">' . "\n", esc_attr($desc));
        if (AIPICKD_DEFAULT_OG_IMAGE) printf('<meta property="og:image" content="%s">' . "\n", esc_url(AIPICKD_DEFAULT_OG_IMAGE));
        printf('<meta property="og:site_name" content="%s">' . "\n", esc_attr(AIPICKD_SITE_NAME));
        printf('<meta name="twitter:card" content="%s">' . "\n", AIPICKD_DEFAULT_OG_IMAGE ? 'summary_large_image' : 'summary');
        if (AIPICKD_DEFAULT_OG_IMAGE) printf('<meta name="twitter:image" content="%s">' . "\n", esc_url(AIPICKD_DEFAULT_OG_IMAGE));
        echo "<!-- /AIPickd SEO Meta -->\n";
    }
}, 1);
