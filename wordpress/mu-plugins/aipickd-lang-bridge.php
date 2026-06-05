<?php
/**
 * Plugin Name: AIPickd Language Bridge
 * Description: Sets a post's Polylang language from the `_pipeline_lang` meta the
 *              AIPickd pipeline sends when it creates a post via the REST API.
 *              Works around Polylang free's lack of REST language support, so
 *              Spanish articles land under /es/ automatically. No-ops safely when
 *              Polylang is inactive or the meta is absent (English stays default).
 * Version:     1.0.0
 *
 * Install: drop in wp-content/mu-plugins/ (auto-activates) OR upload as a normal
 *          plugin. Zero config.
 */

defined('ABSPATH') || exit;

// 1) Register the meta so the pipeline can SET it through the REST API. Protected
//    keys (leading underscore) are normally unwritable via REST; registering it
//    with show_in_rest + an auth callback makes it accepted from authenticated
//    requests only.
add_action('init', function () {
    register_post_meta('post', '_pipeline_lang', array(
        'type'          => 'string',
        'single'        => true,
        'show_in_rest'  => true,
        'auth_callback' => function () { return current_user_can('edit_posts'); },
    ));
});

// 2) After a post is created/updated via REST, apply its language in Polylang.
add_action('rest_after_insert_post', function ($post, $request, $creating) {
    if (!function_exists('pll_set_post_language')) {
        return; // Polylang not active — nothing to do.
    }
    $lang = get_post_meta($post->ID, '_pipeline_lang', true);
    if ($lang === 'es' || $lang === 'en') {
        pll_set_post_language($post->ID, $lang);
    }
}, 10, 3);
