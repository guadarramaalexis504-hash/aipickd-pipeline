# Prompt Library — Keyword Research & Analysis

---

## 🔎 PROMPT 1: Keyword Expansion (Claude)

Usado cuando NO tenemos DataForSEO API. Claude genera ideas basado en conocimiento.

```
You are an expert SEO strategist for AI tools and SaaS affiliate content.

**Seed topic:** {{seed_keyword}}
**Niche:** {{niche_name}}
**Existing published articles (avoid duplicates):** {{published_titles_list}}

Generate 30 keyword opportunities that:
1. Have clear commercial intent (people looking to buy/choose a tool)
2. Are long-tail (4+ words usually)
3. Are diverse across these article types:
   - Comparisons ("X vs Y", "X vs Y vs Z")
   - Listicles ("best X for Y", "top 10 X")
   - Reviews ("X review", "is X worth it")
   - Alternatives ("X alternatives", "free alternatives to X")
   - How-to with commercial angle ("how to use X for Y")
4. Target different funnel stages (awareness, consideration, decision)

For each keyword, estimate:
- **Estimated search volume** (low/medium/high) — based on your knowledge of the niche
- **Difficulty guess** (low/medium/high) — how hard to rank for
- **Commercial value** (1-10) — how likely a reader is to click an affiliate link
- **Suggested article type**
- **Recommended word count**

**Output format:** JSON array
[
  {
    "keyword": "best AI writing tools for small business",
    "article_type": "listicle",
    "estimated_volume": "medium",
    "estimated_difficulty": "medium",
    "commercial_value": 9,
    "intent": "commercial",
    "word_count": 2500,
    "why_this_keyword": "SMB owners have budget and decision-making authority; listicle format captures them early in the funnel"
  }
]

Return 30 items. Prioritize quality over novelty — repeat formats but on different angles.
```

---

## 📈 PROMPT 2: SERP Analysis (Claude, reads scraped SERP)

```
You have the top 10 Google results for the keyword: **{{keyword}}**

**SERP data (scraped):**
{{serp_json}}
// contains: title, url, meta_description, h2s for each result

**Analyze and return:**

1. **Content gap analysis:** What are the top 10 missing? What could a new article add that they don't?
2. **Common patterns:** What structure do most top results use? (listicle? comparison? tutorial?)
3. **Word count target:** Based on top 3 results, what's the sweet spot?
4. **Angles to try:** 3 unique angles that could differentiate a new article
5. **Entities to cover:** Important products/tools/concepts that appear across top results (we need these for topical authority)
6. **Verdict:** Is this keyword worth pursuing? (yes/no + 1-sentence reason)

**Output:** JSON with the above fields.
```

---

## 🎯 PROMPT 3: Keyword Clustering (Claude)

```
Cluster the following keywords into article groups. Keywords that can be targeted by ONE article (same intent, same SERP) go together.

**Keywords:**
{{keywords_list}}

**Rules:**
- Keywords with the same primary intent + similar modifiers = same cluster
- Each cluster should have 1 "primary" keyword (the one with highest volume/value)
- Other keywords in cluster = supporting (weave into H2s, LSI usage)

**Output:** JSON
[
  {
    "primary_keyword": "best AI writing tools",
    "supporting_keywords": ["top AI writing software", "best AI copywriting tools", "top content AI tools 2026"],
    "article_type": "listicle",
    "intent": "commercial",
    "estimated_traffic_potential": "high"
  }
]
```
