// ============================================
// Import articles from content-bank/*.md into Supabase
// ============================================
// Usage:
//   1. npm install @supabase/supabase-js
//   2. Set env vars SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
//   3. node scripts/import-articles.js
// ============================================

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const articles = [
  {
    file: '01-jasper-vs-copy-vs-writesonic.md',
    niche_slug: 'ai-writing',
    title: 'Jasper vs Copy.ai vs Writesonic: Which AI Writer Wins in 2026?',
    slug: 'jasper-vs-copy-vs-writesonic',
    article_type: 'comparison'
  },
  {
    file: '02-best-ai-tools-small-business.md',
    niche_slug: 'ai-business',
    title: '11 Best AI Tools for Small Business Owners in 2026 (Tested & Ranked)',
    slug: 'best-ai-tools-small-business-owners-2026',
    article_type: 'listicle'
  },
  {
    file: '03-midjourney-vs-dalle-vs-stable-diffusion.md',
    niche_slug: 'ai-image-video',
    title: 'Midjourney vs DALL-E 3 vs Stable Diffusion: Real Head-to-Head for 2026',
    slug: 'midjourney-vs-dalle-vs-stable-diffusion',
    article_type: 'comparison'
  },
  {
    file: '04-cursor-vs-copilot.md',
    niche_slug: 'ai-coding',
    title: 'Cursor vs GitHub Copilot in 2026: Which AI Coding Assistant Actually Wins?',
    slug: 'cursor-vs-github-copilot-2026',
    article_type: 'comparison'
  },
  {
    file: '05-supabase-vs-firebase.md',
    niche_slug: 'ai-hosting',
    title: 'Supabase vs Firebase in 2026: Which Backend Should You Actually Choose?',
    slug: 'supabase-vs-firebase-2026',
    article_type: 'comparison'
  }
];

async function main() {
  // Get niche IDs
  const { data: niches, error: nicheErr } = await supabase.from('niches').select('id, slug');
  if (nicheErr) {
    console.error('❌ Could not fetch niches:', nicheErr);
    process.exit(1);
  }
  const nicheBySlug = Object.fromEntries(niches.map(n => [n.slug, n.id]));

  const contentDir = path.join(__dirname, '..', 'content-bank');

  for (const article of articles) {
    const filePath = path.join(contentDir, article.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️  File not found: ${filePath}`);
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');

    // Extract meta description from HTML comment
    const metaMatch = content.match(/<!--\s*meta:\s*(.+?)\s*-->/);
    const meta = metaMatch ? metaMatch[1] : '';

    const word_count = content.split(/\s+/).length;

    const { error } = await supabase.from('articles').upsert({
      niche_id: nicheBySlug[article.niche_slug],
      title: article.title,
      slug: article.slug,
      meta_description: meta,
      article_type: article.article_type,
      content_markdown: content,
      status: 'draft',
      generated_by: 'claude',
      word_count
    }, { onConflict: 'slug' });

    if (error) {
      console.error(`❌ Error inserting ${article.file}:`, error.message);
    } else {
      console.log(`✅ Imported: ${article.title}`);
    }
  }

  console.log('\n🎉 Import complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
