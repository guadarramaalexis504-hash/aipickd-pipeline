#!/usr/bin/env node
"use strict";

const { hasWriteFlag, readIntFlag } = require("./lib/cli-safety");
const { supa, WP_USER_AGENT } = require("./lib/clients");

const argv = process.argv.slice(2);
const GO = hasWriteFlag(argv, new Set(["--go"]));
const LIMIT = readIntFlag(argv, "--limit", 100);
const WP_HOST = "https://aipickd.com";

function slugFromLink(link) {
  try {
    const url = new URL(link);
    return url.pathname.replace(/^\/es\//, "/").replace(/^\/|\/$/g, "");
  } catch {
    return "";
  }
}

async function wpPublic(endpoint) {
  const res = await fetch(`${WP_HOST}/wp-json/wp/v2/${endpoint}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": WP_USER_AGENT,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`WP public GET ${endpoint}: ${res.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function fetchWpPosts(limit) {
  const posts = [];
  let page = 1;
  while (posts.length < limit) {
    const batch = await wpPublic(
      `posts?per_page=${Math.min(100, limit - posts.length)}&page=${page}&status=publish&_fields=id,slug,link,status,meta`
    ).catch((err) => {
      if (/rest_post_invalid_page_number/.test(err.message)) return [];
      throw err;
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    posts.push(...batch);
    page++;
  }
  return posts;
}

async function main() {
  console.log(`reconcile-wp-supabase mode=${GO ? "WRITE --go" : "REPORT ONLY"} limit=${LIMIT}`);
  const [articles, wpPosts] = await Promise.all([
    supa(
      "GET",
      `articles?select=id,title,slug,language,status,wp_post_id,wp_url,gsc_clicks,gsc_impressions,published_at&limit=${LIMIT}&order=created_at.desc`
    ),
    fetchWpPosts(LIMIT),
  ]);

  const articleRows = Array.isArray(articles) ? articles : [];
  const bySlug = new Map(articleRows.map((article) => [article.slug, article]));
  const byWpId = new Map(articleRows.filter((article) => article.wp_post_id).map((article) => [article.wp_post_id, article]));
  const planned = [];

  for (const post of wpPosts) {
    const normalizedSlug = post.slug || slugFromLink(post.link);
    const match = bySlug.get(normalizedSlug);
    if (match && (!match.wp_post_id || !match.wp_url)) {
      planned.push({
        type: "link_supabase_article_to_wp_post",
        article_id: match.id,
        slug: match.slug,
        wp_post_id: post.id,
        wp_url: post.link,
      });
    } else if (!match && !byWpId.has(post.id)) {
      planned.push({ type: "wp_post_missing_supabase_row", wp_post_id: post.id, slug: normalizedSlug, link: post.link });
    }
  }

  for (const article of articleRows) {
    if (article.wp_post_id && !wpPosts.some((post) => post.id === article.wp_post_id)) {
      planned.push({
        type: "supabase_article_missing_wp_post_in_sample",
        article_id: article.id,
        slug: article.slug,
        wp_post_id: article.wp_post_id,
      });
    }
  }

  console.log(JSON.stringify({ planned_actions: planned }, null, 2));
  if (!GO) {
    console.log("No writes performed. Re-run with --go to apply safe Supabase link repairs.");
    return 0;
  }

  const linkRepairs = planned.filter((item) => item.type === "link_supabase_article_to_wp_post");
  for (const repair of linkRepairs) {
    await supa("PATCH", `articles?id=eq.${encodeURIComponent(repair.article_id)}`, {
      wp_post_id: repair.wp_post_id,
      wp_url: repair.wp_url,
      status: "published",
      published_at: new Date().toISOString(),
    });
  }
  console.log(`Applied ${linkRepairs.length} Supabase link repair(s).`);
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`ERROR: ${err.message}`);
      process.exitCode = 1;
    });
}
