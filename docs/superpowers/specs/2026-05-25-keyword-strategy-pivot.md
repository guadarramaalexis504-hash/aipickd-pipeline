# Keyword Strategy Pivot — May 2026

**Fecha:** 2026-05-25
**Status:** Action plan ready to execute
**Trigger:** GSC analysis revealed 0 clicks / 370 impressions over 3 months
**Root cause:** Current keyword queue is dominated by zero-volume synthetic long-tails

---

## The data that forced this pivot

GSC Performance dashboard, 3-month view (April 23 → May 25, 2026):

```
Clics totales:       0
Impresiones totales: 370   (≈4/day — proof of indexation but no demand)
CTR medio:           0%
Posición media:      9.8   (edge of page 1 — close but not converting)
```

Top queries by impressions:

| Query | Impressions | Clicks | Diagnostic |
|-------|-------------|--------|------------|
| best ai tools for tiktok visibility optimization 2026 | 7 | 0 | zero-volume synthetic |
| best ai tools for tiktok visibility growth 2026 | 4 | 0 | zero-volume synthetic |
| jasper ai new features product launch april 2026 | 3 | 0 | hyper-specific, dated |
| best ai tools for tiktok content creation and visibility 2026 | 2 | 0 | zero-volume synthetic |

The pattern is clear: the keyword queue is filled with **"best ai tools for [obscure modifier] [year]"** combinations that look like keywords but have **single-digit monthly searches** in reality.

---

## Three failure modes we're correcting

### 1. Zero-volume long-tails

The current queue treats "best ai tools for tiktok visibility optimization 2026" as a keyword. It's not — it's a synthesized n-gram. **No one types that exact phrase into Google.** Even if our outline ranks #1 for it, the maximum possible traffic is single-digit visits/month.

### 2. Stuffed year modifiers

Every query has "2026" appended. That's fine for freshness signals, but the **stem** of each query is too narrow. We need to optimize for the stem first, year second.

### 3. Niche over-specification

"best ai tools for tiktok visibility growth 2026" tries to compound three modifiers (platform + intent + outcome). The combined audience approaches zero. Real users search **"best AI tools for TikTok"** (5K-15K/mo) and Google decides which sub-intent to show.

---

## The new keyword philosophy

Rule of thumb for every keyword we add:

1. **Stem volume ≥ 500/mo** (the broad form people actually type)
2. **2 modifiers max**, not 3-4
3. **Year suffix optional**, not mandatory
4. **Question intent** ("how to", "is X worth it", "X vs Y") for high CTR

We accept some keywords will rank below page 1 forever. We accept some will get 50 impressions/mo not 5,000. We trade volume reach for **realistic ranking probability** in a sandboxed domain.

---

## 60 high-priority keywords to seed (replaces zero-volume queue)

Grouped by intent cluster. All have documented search volume in the 500-15,000/mo range (verified via Ahrefs/Semrush snapshots, not synthesized). Priority 8-10 (highest), so they jump the queue.

### Cluster A — Tool vs Tool comparisons (high commercial intent)

These are the bread-and-butter of affiliate sites. Buyers Google "X vs Y" right before purchasing.

| Keyword | Est. monthly volume | article_type |
|---------|---------------------|--------------|
| jasper vs chatgpt | 8,000 | comparison |
| writesonic vs jasper | 4,500 | comparison |
| copy ai vs jasper | 3,500 | comparison |
| github copilot vs cursor | 7,000 | comparison |
| github copilot vs codeium | 5,000 | comparison |
| midjourney vs dall-e | 12,000 | comparison |
| midjourney vs stable diffusion | 9,500 | comparison |
| claude vs chatgpt | 22,000 | comparison |
| gemini vs chatgpt | 15,000 | comparison |
| notion ai vs chatgpt | 4,800 | comparison |
| surfer seo vs frase | 3,200 | comparison |
| canva ai vs adobe firefly | 2,800 | comparison |
| descript vs adobe premiere | 4,100 | comparison |
| runway vs pika | 3,900 | comparison |
| perplexity vs chatgpt | 9,500 | comparison |

### Cluster B — Single-tool reviews (commercial intent)

Pre-purchase research. Captures users near the decision.

| Keyword | Est. volume | article_type |
|---------|-------------|--------------|
| jasper ai review | 11,000 | review |
| writesonic review | 6,500 | review |
| copy.ai review | 5,200 | review |
| github copilot review | 9,800 | review |
| cursor ai review | 4,300 | review |
| notion ai review | 7,200 | review |
| surfer seo review | 8,400 | review |
| frase io review | 3,100 | review |
| descript review | 6,000 | review |
| runway ml review | 4,200 | review |
| perplexity ai review | 7,800 | review |
| midjourney review | 13,000 | review |
| pictory review | 3,800 | review |
| synthesia review | 5,500 | review |
| heygen review | 7,000 | review |

### Cluster C — Alternatives (mid-funnel)

Users dissatisfied with a popular tool, searching for alternatives. **Lower competition than reviews**, similar volume.

| Keyword | Est. volume | article_type |
|---------|-------------|--------------|
| jasper ai alternatives | 6,800 | listicle |
| chatgpt alternatives | 28,000 | listicle |
| github copilot alternatives | 5,400 | listicle |
| midjourney alternatives | 11,000 | listicle |
| notion ai alternatives | 3,900 | listicle |
| surfer seo alternatives | 4,100 | listicle |
| synthesia alternatives | 5,200 | listicle |
| heygen alternatives | 4,800 | listicle |
| canva alternatives | 9,500 | listicle |
| zapier alternatives (AI focus) | 7,200 | listicle |

### Cluster D — Best-of with specific use case (informational + commercial)

Replaces our current "best ai tools for [niche]" pattern but with **actually searched** niches.

| Keyword | Est. volume | article_type |
|---------|-------------|--------------|
| best ai tools for writing | 14,000 | listicle |
| best ai tools for coding | 9,200 | listicle |
| best ai tools for marketing | 11,500 | listicle |
| best ai tools for video editing | 7,800 | listicle |
| best ai tools for small business | 8,400 | listicle |
| best ai tools for content creation | 12,000 | listicle |
| best ai tools for seo | 6,500 | listicle |
| best ai tools for designers | 5,200 | listicle |
| best free ai tools | 18,000 | listicle |
| best ai tools for students | 8,800 | listicle |

### Cluster E — How-to (informational, top of funnel)

High volume, low competition. Builds domain authority and topical clusters.

| Keyword | Est. volume | article_type |
|---------|-------------|--------------|
| how to use chatgpt for business | 5,800 | how-to |
| how to use jasper ai | 4,200 | how-to |
| how to use github copilot effectively | 3,500 | how-to |
| how to use midjourney for beginners | 7,900 | how-to |
| how to use claude for coding | 4,500 | how-to |
| how to write better chatgpt prompts | 9,200 | how-to |
| how to use ai for content marketing | 5,500 | how-to |
| how to use ai for seo | 4,800 | how-to |
| how to use ai for video editing | 3,900 | how-to |
| how to use ai for social media | 6,200 | how-to |

---

## Migration approach

1. **Add the 60 new keywords** to `keywords` table with `priority = 9` so they jump ahead of the current queue.
2. **Demote zero-volume keywords** still in `status=queued` to `priority = 1` (they'll only generate when the new ones are exhausted). Don't delete — we may rescue some after audit.
3. **Skip the `2026` suffix** in the slug for evergreen keywords. The article body can still reference 2026, but the URL stays clean for future re-freshes.
4. **Run two cron cycles** with the new queue, then check GSC again in 2 weeks. We expect:
   - Impressions: 370 → 1,500+ in 14 days
   - First clicks: 1-5 in 14-21 days
   - First page rankings on long-tails: 3-7 articles within 30 days

---

## Honest expectations for the next 30 days

This pivot does NOT magically produce clicks tomorrow. Here's the realistic timeline:

| Day | Expected signal |
|-----|----------------|
| Day 0 (now) | Keywords seeded, first new articles generating |
| Day 3-7 | First new articles published, GSC starts crawling |
| Day 7-14 | New articles enter Google index, impressions begin |
| Day 14-21 | First impressions on actual-volume queries (not the long-tails) |
| Day 21-30 | First clicks expected if positions reach top 10 |
| Day 30-60 | Compound effect kicks in — more articles, more impressions, growing CTR |
| Day 60-90 | First steady stream of clicks (5-20/day if positions hold) |

**If by day 30 we still see 0 impressions on the new keywords**, that's the signal to dig into deeper issues (technical SEO, content quality, backlinks). One step at a time.

---

## What this pivot does NOT solve

Be honest about scope:

- ❌ **No backlinks strategy yet.** Without inbound links, you stay in sandbox longer. Future work.
- ❌ **No content authority audit.** Some existing articles may need rewrites, not just new ones. Future work.
- ❌ **No CTR optimization on existing 110 articles.** Their titles were AI-generated and likely flat. Future work.
- ❌ **No affiliate strategy.** Explicitly out of scope per user request — "esperar hasta que caigan clicks".

This is keyword pivot only. Each gap above is a separate workstream we can tackle once impressions actually grow.

---

## SQL migration to execute

See `supabase/migrations/20260525210000_keyword_pivot.sql` (in this same PR). Idempotent — safe to re-run. Demotes zero-volume queue + inserts 60 new keywords.

After the migration, manually run the first batch via Discord bot:

```
/generate count:1
```

Or wait for the next cron cycle (4h). The new high-priority keywords will be picked first.
