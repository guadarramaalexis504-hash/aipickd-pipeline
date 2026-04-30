#!/usr/bin/env node
/**
 * AIPickd — Social Thread Generator
 *
 * Generates Twitter/X threads, LinkedIn posts, and Reddit comments
 * from published articles. Saves drafts to reports/ for manual posting,
 * or auto-posts if API credentials are configured.
 *
 * Usage:
 *   node scripts/social-threads.js                    # generate for latest 5 articles
 *   node scripts/social-threads.js --count 10         # for latest 10 articles
 *   node scripts/social-threads.js --article-id UUID  # for specific article
 *   node scripts/social-threads.js --platform twitter # only generate Twitter threads
 *
 * Env vars needed for auto-post:
 *   TWITTER_BEARER_TOKEN, TWITTER_API_KEY, TWITTER_API_SECRET,
 *   TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET
 *   (LinkedIn and Reddit auto-post require their own OAuth setup)
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

const args = process.argv.slice(2);
const countIdx   = args.indexOf('--count');
const COUNT      = countIdx >= 0 ? parseInt(args[countIdx + 1]) : 5;
const artIdx     = args.indexOf('--article-id');
const ART_ID     = artIdx >= 0 ? args[artIdx + 1] : null;
const platIdx    = args.indexOf('--platform');
const PLATFORM   = platIdx >= 0 ? args[platIdx + 1] : 'all';

async function supa(endpoint) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`Supabase: ${r.status}`);
  return r.json();
}

async function gpt(systemPrompt, userPrompt, maxTokens = 1000) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function generateTwitterThread(article) {
  const text = await gpt(
    'You are a viral Twitter/X content creator. Write engaging threads that drive clicks and shares. Keep each tweet under 280 characters.',
    `Write a 5-tweet Twitter/X thread about this article.

Article title: ${article.title}
URL: ${article.wp_url}
Type: ${article.article_type}
Keywords: ${article.primary_keyword}
Summary: ${(article.meta_description || '').slice(0, 200)}

Thread format:
1/ [Hook tweet — a shocking fact or bold claim, under 280 chars]
2/ [Key insight #1, under 280 chars]
3/ [Key insight #2, under 280 chars]
4/ [Key insight #3, under 280 chars]
5/ [CTA tweet with URL, under 280 chars]

Make it punchy, no corporate speak. Each tweet standalone readable.`,
    800
  );
  return text;
}

async function generateLinkedInPost(article) {
  const text = await gpt(
    'You are a LinkedIn content creator. Write professional but engaging posts that drive traffic.',
    `Write a LinkedIn post about this article. Format: hook + 3-4 key insights + CTA with link.
Max 1300 characters total. Use line breaks and bullet points for readability.

Article title: ${article.title}
URL: ${article.wp_url}
Type: ${article.article_type}
Summary: ${(article.meta_description || '').slice(0, 200)}`,
    600
  );
  return text;
}

async function generateRedditPost(article) {
  const subreddits = {
    'ai-writing': ['r/artificial', 'r/MachineLearning', 'r/ChatGPT', 'r/AIMarketing'],
    'ai-image-video': ['r/artificial', 'r/StableDiffusion', 'r/midjourney'],
    'ai-coding': ['r/programming', 'r/learnprogramming', 'r/AIAssistants'],
    'ai-business': ['r/Entrepreneur', 'r/smallbusiness', 'r/marketing'],
    'ai-hosting': ['r/webdev', 'r/sysadmin', 'r/selfhosted'],
  };
  const niche = article.niche?.slug || 'ai-writing';
  const reddits = subreddits[niche] || subreddits['ai-writing'];

  const text = await gpt(
    'You are a Reddit content creator. Write genuine, helpful Reddit posts that don\'t feel like spam. Reddit hates obvious self-promotion.',
    `Write a Reddit post title + body for this article.
Article: ${article.title}
URL: ${article.wp_url}
Suitable subreddits: ${reddits.join(', ')}

Requirements:
- Title: genuine question or insight (not clickbait), under 300 chars
- Body: share genuine value, mention the article naturally at the end
- Don't be promotional — Reddit will downvote you
- Format: TITLE: [title]\n\nSUBREDDIT: [best one]\n\nBODY: [body]`,
    600
  );
  return text;
}

(async () => {
  console.log(`📱 AIPickd Social Thread Generator\n`);

  // Fetch articles
  const endpoint = ART_ID
    ? `articles?id=eq.${ART_ID}&status=eq.published&select=id,title,wp_url,article_type,primary_keyword,meta_description,niche:niches(slug)&limit=1`
    : `articles?status=eq.published&select=id,title,wp_url,article_type,primary_keyword,meta_description,niche:niches(slug)&order=published_at.desc&limit=${COUNT}`;

  const articles = await supa(endpoint);
  if (!Array.isArray(articles) || articles.length === 0) {
    console.log('⚠️ No published articles found.');
    return;
  }

  console.log(`Generating social content for ${articles.length} articles...\n`);

  const reportsDir = path.join(__dirname, '..', 'reports', 'social');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  for (const article of articles) {
    console.log(`\n📝 "${article.title.slice(0, 60)}"`);
    const dateStr = new Date().toISOString().slice(0, 10);
    const slug = (article.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const outFile = path.join(reportsDir, `${dateStr}-${slug}.md`);

    let md = `# Social Content — ${article.title}\n\n**URL:** ${article.wp_url}\n**Date:** ${dateStr}\n\n---\n\n`;

    if (PLATFORM === 'all' || PLATFORM === 'twitter') {
      console.log('   🐦 Generating Twitter/X thread...');
      const thread = await generateTwitterThread(article);
      md += `## Twitter/X Thread\n\n${thread}\n\n---\n\n`;
    }

    if (PLATFORM === 'all' || PLATFORM === 'linkedin') {
      console.log('   💼 Generating LinkedIn post...');
      const li = await generateLinkedInPost(article);
      md += `## LinkedIn Post\n\n${li}\n\n---\n\n`;
    }

    if (PLATFORM === 'all' || PLATFORM === 'reddit') {
      console.log('   🤖 Generating Reddit post...');
      const reddit = await generateRedditPost(article);
      md += `## Reddit Post\n\n${reddit}\n\n---\n\n`;
    }

    md += `_Generated ${new Date().toISOString()} by social-threads.js_\n`;
    fs.writeFileSync(outFile, md);
    console.log(`   ✅ Saved to: reports/social/${path.basename(outFile)}`);
  }

  console.log(`\n✅ Done! Social content saved to reports/social/`);
  console.log(`\n💡 To auto-post, configure API credentials in .env:`);
  console.log(`   TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET`);
})().catch((e) => {
  console.error('❌ Social threads failed:', e.message);
  process.exit(1);
});
