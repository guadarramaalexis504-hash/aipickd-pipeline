#!/usr/bin/env node
/**
 * Create a "Welcome" homepage with featured posts grid and set it as
 * the front page in WordPress.
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const { WP_USERNAME, WP_ADMIN_PASSWORD } = env;
const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");

async function wp(method, endpoint, body) {
  const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WP: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  console.log("== create-homepage ==\n");

  // Get categories for the 3 featured sections
  const categories = await wp("GET", "categories?per_page=20");
  const writing = categories.find((c) => c.slug === "ai-writing");
  const business = categories.find((c) => c.slug === "ai-business");
  const image = categories.find((c) => c.slug === "ai-image-video");

  // Get latest 6 published posts (use draft since nothing is published yet)
  const latest = await wp("GET", "posts?per_page=6&status=any&_fields=id,title,link,excerpt,slug");
  const featured = latest.filter((p) => p.title?.rendered).slice(0, 6);

  const html = `
<!-- wp:heading {"level":1,"align":"center"} -->
<h1 class="wp-block-heading has-text-align-center" style="font-size:3em;font-weight:800;margin-bottom:0.2em;">Honest AI Tool Reviews & Comparisons</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","className":"has-large-font-size","style":{"color":{"text":"#64748b"}}} -->
<p class="has-text-align-center has-large-font-size" style="color:#64748b;max-width:700px;margin:0 auto 2em;">No fluff. Real tradeoffs. Deep reviews of the AI tools that actually matter for your work in 2026.</p>
<!-- /wp:paragraph -->

<!-- wp:separator -->
<hr class="wp-block-separator has-alpha-channel-opacity"/>
<!-- /wp:separator -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Latest reviews</h2>
<!-- /wp:heading -->

<!-- wp:query {"queryId":1,"query":{"perPage":6,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","author":"","search":"","exclude":[],"sticky":"","inherit":false}} -->
<div class="wp-block-query">
<!-- wp:post-template -->
<!-- wp:group {"layout":{"type":"constrained"},"style":{"spacing":{"blockGap":"0.5em","margin":{"bottom":"1.5em"}}}} -->
<div class="wp-block-group" style="margin-bottom:1.5em;">
<!-- wp:post-title {"isLink":true,"level":3} /-->
<!-- wp:post-excerpt {"moreText":"Read full review →","showMoreOnNewLine":true,"excerptLength":30} /-->
</div>
<!-- /wp:group -->
<!-- /wp:post-template -->
<!-- wp:query-no-results -->
<!-- wp:paragraph {"align":"center","style":{"color":{"text":"#64748b"}}} -->
<p class="has-text-align-center" style="color:#64748b;"><em>Reviews coming soon. We're currently testing 30+ AI tools for the first wave of reviews.</em></p>
<!-- /wp:paragraph -->
<!-- /wp:query-no-results -->
</div>
<!-- /wp:query -->

<!-- wp:separator -->
<hr class="wp-block-separator has-alpha-channel-opacity"/>
<!-- /wp:separator -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Explore by category</h2>
<!-- /wp:heading -->

<!-- wp:columns -->
<div class="wp-block-columns">
  <!-- wp:column -->
  <div class="wp-block-column">
    <!-- wp:heading {"level":3} -->
    <h3 class="wp-block-heading">✍️ AI Writing</h3>
    <!-- /wp:heading -->
    <!-- wp:paragraph -->
    <p>Jasper, Copy.ai, Writesonic, ChatGPT — we test them all so you don't have to guess which AI writing tool fits your workflow.</p>
    <!-- /wp:paragraph -->
    <!-- wp:paragraph -->
    <p><a href="/category/ai-writing/"><strong>Browse AI Writing →</strong></a></p>
    <!-- /wp:paragraph -->
  </div>
  <!-- /wp:column -->
  <!-- wp:column -->
  <div class="wp-block-column">
    <!-- wp:heading {"level":3} -->
    <h3 class="wp-block-heading">🚀 AI Business & Productivity</h3>
    <!-- /wp:heading -->
    <!-- wp:paragraph -->
    <p>Notion, ClickUp, Make.com, Monday.com — the productivity and automation tools worth paying for (and the ones to skip).</p>
    <!-- /wp:paragraph -->
    <!-- wp:paragraph -->
    <p><a href="/category/ai-business/"><strong>Browse AI Business →</strong></a></p>
    <!-- /wp:paragraph -->
  </div>
  <!-- /wp:column -->
  <!-- wp:column -->
  <div class="wp-block-column">
    <!-- wp:heading {"level":3} -->
    <h3 class="wp-block-heading">🎨 AI Image & Video</h3>
    <!-- /wp:heading -->
    <!-- wp:paragraph -->
    <p>Midjourney, Runway, DALL-E, Kling — hands-on reviews of the image and video AI tools changing creative work.</p>
    <!-- /wp:paragraph -->
    <!-- wp:paragraph -->
    <p><a href="/category/ai-image-video/"><strong>Browse AI Image & Video →</strong></a></p>
    <!-- /wp:paragraph -->
  </div>
  <!-- /wp:column -->
</div>
<!-- /wp:columns -->

<!-- wp:separator -->
<hr class="wp-block-separator has-alpha-channel-opacity"/>
<!-- /wp:separator -->

<!-- wp:heading -->
<h2 class="wp-block-heading">How we review</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Every tool on AIPickd goes through the same process: <strong>hands-on testing</strong>, <strong>real pricing analysis</strong> (including renewal rates and hidden fees), <strong>honest pros AND cons</strong>, and <strong>specific recommendations</strong> for different use cases and budgets.</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p>We don't rank by affiliate commission. Many tools we recommend pay us zero. Several tools that pay top commissions get critical reviews when they deserve them. <a href="/about/">Read more about our approach →</a></p>
<!-- /wp:paragraph -->

<!-- wp:separator -->
<hr class="wp-block-separator has-alpha-channel-opacity"/>
<!-- /wp:separator -->

<!-- wp:paragraph {"align":"center","style":{"color":{"text":"#64748b"}}} -->
<p class="has-text-align-center" style="color:#64748b;"><em>AIPickd participates in affiliate programs. <a href="/affiliate-disclosure/">See our full disclosure →</a></em></p>
<!-- /wp:paragraph -->
`;

  // Check if homepage already exists
  const existingPages = await wp("GET", "pages?slug=home&status=any&_fields=id,slug,status");
  let pageId;
  if (existingPages && existingPages.length > 0) {
    pageId = existingPages[0].id;
    console.log(`  Homepage exists (#${pageId}), updating...`);
    await wp("POST", `pages/${pageId}`, {
      content: html,
      title: "AIPickd — Honest AI Tool Reviews",
      status: "publish",
    });
  } else {
    const created = await wp("POST", "pages", {
      title: "AIPickd — Honest AI Tool Reviews",
      slug: "home",
      content: html,
      status: "publish",
    });
    pageId = created.id;
    console.log(`  Created homepage #${pageId} at ${created.link}`);
  }

  // Set it as front page
  const settings = await wp("POST", "settings", {
    show_on_front: "page",
    page_on_front: pageId,
  });
  console.log(`  Set as front page (show_on_front=${settings.show_on_front}, page_on_front=${settings.page_on_front})`);

  console.log(`\n✅ Homepage live at https://aipickd.com/`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
