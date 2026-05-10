/**
 * Enriched RSS feed generator.
 *
 * WP's default `/feed/` is plain RSS 2.0 — no images, no categories
 * structured well. Google News, Apple News, and most newsreaders look
 * for `<media:content>` (Yahoo MRSS) and `<dc:creator>` extensions,
 * which we add here.
 *
 * Use this output as the body of a custom feed endpoint (a WP mu-plugin
 * can register `/feed/aipickd` and serve this), or save it as a static
 * file and serve via Cloudflare Workers.
 */

const SITE_URL = "https://aipickd.com";

/**
 * @typedef {object} Item
 * @property {string} title
 * @property {string} link              Canonical URL of the article.
 * @property {string} guid              Stable unique ID (use the article URL).
 * @property {string} pubDate           ISO date or RFC 822.
 * @property {string} [description]     Plain-text excerpt.
 * @property {string} [content]         HTML content (full body).
 * @property {string} [author]          Display name.
 * @property {string} [imageUrl]        Featured image URL.
 * @property {number} [imageWidth]
 * @property {number} [imageHeight]
 * @property {string[]} [categories]    Tags / categories.
 */

/**
 * Build a complete RSS 2.0 + Yahoo MRSS + Dublin Core feed.
 *
 * @param {{
 *   title: string,
 *   description: string,
 *   link?: string,
 *   language?: string,
 *   items: Item[],
 *   generator?: string,
 * }} channel
 * @returns {string}  XML string ready to serve as `application/rss+xml`.
 */
function build(channel) {
  if (!channel || !channel.title || !channel.description) {
    throw new Error("rss.build: title and description required");
  }
  if (!Array.isArray(channel.items)) {
    throw new Error("rss.build: items must be an array");
  }

  const link = channel.link || SITE_URL;
  const language = channel.language || "es-MX";
  const generator = channel.generator || "AIPickd Pipeline";
  const lastBuildDate = toRfc822(new Date());

  const head =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0"\n` +
    `     xmlns:media="http://search.yahoo.com/mrss/"\n` +
    `     xmlns:dc="http://purl.org/dc/elements/1.1/"\n` +
    `     xmlns:atom="http://www.w3.org/2005/Atom"\n` +
    `     xmlns:content="http://purl.org/rss/1.0/modules/content/">\n`;

  const channelOpen =
    `  <channel>\n` +
    `    <title>${esc(channel.title)}</title>\n` +
    `    <link>${esc(link)}</link>\n` +
    `    <description>${esc(channel.description)}</description>\n` +
    `    <language>${esc(language)}</language>\n` +
    `    <generator>${esc(generator)}</generator>\n` +
    `    <lastBuildDate>${lastBuildDate}</lastBuildDate>\n` +
    `    <atom:link href="${esc(link)}/feed/aipickd" rel="self" type="application/rss+xml" />\n`;

  const items = channel.items.map(renderItem).join("");

  return head + channelOpen + items + "  </channel>\n</rss>\n";
}

function renderItem(item) {
  if (!item.title || !item.link) {
    throw new Error("rss item: title and link required");
  }
  const guid = item.guid || item.link;
  const pubDate = toRfc822(item.pubDate ? new Date(item.pubDate) : new Date());

  let xml = "    <item>\n";
  xml += `      <title>${esc(item.title)}</title>\n`;
  xml += `      <link>${esc(item.link)}</link>\n`;
  xml += `      <guid isPermaLink="true">${esc(guid)}</guid>\n`;
  xml += `      <pubDate>${pubDate}</pubDate>\n`;
  if (item.description) {
    xml += `      <description>${esc(item.description)}</description>\n`;
  }
  if (item.author) {
    xml += `      <dc:creator>${esc(item.author)}</dc:creator>\n`;
  }
  for (const cat of item.categories || []) {
    xml += `      <category>${esc(cat)}</category>\n`;
  }
  if (item.imageUrl) {
    const wh =
      item.imageWidth && item.imageHeight
        ? ` width="${item.imageWidth}" height="${item.imageHeight}"`
        : "";
    xml += `      <media:content url="${esc(item.imageUrl)}" medium="image"${wh} />\n`;
  }
  if (item.content) {
    xml += `      <content:encoded><![CDATA[${item.content.replace(/]]>/g, "]]]]><![CDATA[>")}]]></content:encoded>\n`;
  }
  xml += "    </item>\n";
  return xml;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toRfc822(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return new Date().toUTCString();
  }
  return date.toUTCString();
}

module.exports = { build };
