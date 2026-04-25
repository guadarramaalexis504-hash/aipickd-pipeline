#!/usr/bin/env node
/**
 * Create the 5 legal pages (About, Privacy, Terms, Affiliate Disclosure, Contact)
 * in WordPress via REST API. Idempotent — skips pages that already exist by slug.
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

function md(html) {
  // Simple MD to HTML for pages
  let out = html;
  out = out.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  out = out.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  out = out.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  out = out.replace(/\*\*([^\*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/^- (.+)$/gm, "<li>$1</li>");
  out = out.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>\n${m}</ul>\n`);
  out = out
    .split("\n\n")
    .map((b) => {
      const t = b.trim();
      if (!t) return "";
      if (/^<(h[1-6]|ul|ol|blockquote|table|pre|div)/i.test(t)) return t;
      return `<p>${t}</p>`;
    })
    .join("\n\n");
  return out;
}

const pages = [
  {
    title: "About AIPickd",
    slug: "about",
    content: `# About AIPickd

AIPickd is an independent review site covering AI tools and SaaS products. We publish honest comparisons, in-depth reviews, and practical buying guides for marketers, developers, small business owners, and creators who want to pick the right tools without the hype.

## Why AIPickd exists

The AI tool space moves fast. Every week there's a new "top 50 AI tools" roundup, and most of them are noise — lists ranked by affiliate commission rather than genuine usefulness. We started AIPickd because we were tired of that. We wanted a place where reviews are deep, comparisons are honest, and recommendations are specific to real use cases.

## How we review

Every product we cover goes through the same process:

- **Hands-on testing.** We use the product for a meaningful workflow, not just a demo.
- **Real pricing analysis.** We dig into the fine print — renewal rates, hidden fees, what's actually included at each tier.
- **Honest pros AND cons.** No tool is perfect. If we don't mention limitations, we're not doing our job.
- **Specific recommendations.** "Best AI writing tool" is meaningless without context. We tell you who should pick what, for what use case.

## Who we write for

- **Small business owners** evaluating AI tools to save time and money
- **Marketers and creators** building content operations
- **Developers** picking the right AI coding and infrastructure tools
- **Solopreneurs and freelancers** maximizing output with AI

## How we make money

AIPickd earns revenue through affiliate partnerships with some of the products we review. When you click a link and sign up for a service, we may receive a commission at no extra cost to you.

**This does not influence our reviews.** We recommend products based on quality, not commission rates.

## Contact

Questions, feedback, or want to suggest a tool we should review? Email us at hello@aipickd.com.`,
  },
  {
    title: "Privacy Policy",
    slug: "privacy-policy",
    content: `# Privacy Policy

**Last updated:** April 2026

AIPickd ("we", "us", "our") operates the website aipickd.com (the "Service"). This page informs you of our policies regarding the collection, use, and disclosure of personal data when you use our Service.

## Information Collection and Use

We collect several different types of information for various purposes to provide and improve our Service to you.

### Types of Data Collected

**Personal Data.** While using our Service, we may ask you to provide us with certain personally identifiable information that can be used to contact or identify you. This may include:
- Email address (if you subscribe to our newsletter)
- First name (optional, if you submit a contact form)

**Usage Data.** We may also collect information on how the Service is accessed and used.

**Cookies.** We use cookies and similar tracking technologies to track activity on our Service.

## Use of Data

AIPickd uses the collected data to provide and maintain the Service, notify you about changes, provide customer support, monitor usage, and detect technical issues.

## Third-Party Services

### Google Analytics
We use Google Analytics to analyze how users interact with our Service.

### Affiliate Programs
AIPickd participates in affiliate programs. When you click on an affiliate link and make a purchase, we may receive a commission.

## Data Security

The security of your data is important to us. We strive to use commercially acceptable means to protect your Personal Data, but we cannot guarantee its absolute security.

## Children's Privacy

Our Service does not address anyone under the age of 13.

## Your Rights (GDPR)

If you are from the European Economic Area (EEA), you have certain data protection rights. Contact us at hello@aipickd.com to exercise these rights.

## Changes to This Privacy Policy

We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page.

## Contact Us

If you have any questions about this Privacy Policy, please contact us at hello@aipickd.com.`,
  },
  {
    title: "Terms of Service",
    slug: "terms-of-service",
    content: `# Terms of Service

**Last updated:** April 2026

Please read these Terms of Service ("Terms") carefully before using the aipickd.com website (the "Service") operated by AIPickd.

## Acceptance of Terms

By accessing or using the Service, you agree to be bound by these Terms.

## Content

Our Service allows you to access articles, reviews, comparisons, and other content about AI tools and software products. All content is for informational purposes only and does not constitute professional advice.

## Intellectual Property

The Service and its original content are the exclusive property of AIPickd.

## Links to Other Websites

Our Service may contain links to third-party websites. AIPickd has no control over, and assumes no responsibility for, the content or practices of any third-party websites.

## Affiliate Disclosure

AIPickd participates in affiliate marketing programs. We may earn a commission when you click on or make purchases through affiliate links on our site. This does not affect the price you pay, and it does not influence our editorial opinions.

## Disclaimer

Your use of the Service is at your sole risk. The Service is provided on an "AS IS" and "AS AVAILABLE" basis without warranties of any kind.

## Limitation of Liability

In no event shall AIPickd be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your access to or use of the Service.

## Governing Law

These Terms shall be governed by the laws of Mexico.

## Changes

We reserve the right to modify these Terms at any time.

## Contact Us

Questions about these Terms? Email us at hello@aipickd.com.`,
  },
  {
    title: "Affiliate Disclosure",
    slug: "affiliate-disclosure",
    content: `# Affiliate Disclosure

**Last updated:** April 2026

## The Short Version

AIPickd makes money through affiliate partnerships. When you click links on our site and sign up for products, we may earn a commission — **at no additional cost to you**. This does not influence our reviews or recommendations.

## The Full Version

### What are affiliate links?

Affiliate links are special URLs that contain tracking codes. When you click one and then sign up for a service or buy a product, the company knows AIPickd referred you and pays us a commission.

### Who do we partner with?

- **Amazon Associates** — books, hardware, and other products on Amazon
- **Impact** — partnerships with Jasper, ClickUp, Semrush, and others
- **PartnerStack** — partnerships with Notion, Monday.com, Make.com, and others
- **Direct partnerships** with Hostinger, Copy.ai, Writesonic, and various SaaS companies

### Does this affect our reviews?

No. Here's how we keep editorial integrity:

- **We review products, not commissions.** Our ranking methodology is based on product quality and fit for specific use cases.
- **We recommend products that pay us zero.** Our guides often highlight free tools and open-source alternatives when they're the right fit.
- **We publish honest negatives.** If a product that pays high commissions has real problems, we say so.

### How to tell if a link is an affiliate link

All affiliate links on AIPickd are nofollow and include tracking parameters. You can hover over any link to see its destination.

### Your costs

Clicking an affiliate link does NOT cost you more. The commission comes from the company's marketing budget, not from your pocket.

### FTC compliance

This disclosure is provided in compliance with 16 CFR § 255, the Federal Trade Commission's Guides Concerning the Use of Endorsements and Testimonials in Advertising.

## Questions?

Email us at hello@aipickd.com.`,
  },
  {
    title: "Contact",
    slug: "contact",
    content: `# Contact AIPickd

Got feedback, questions, or a tool you want us to review? We'd love to hear from you.

## For readers

**General inquiries, feedback, or tool suggestions:**

Email: hello@aipickd.com

We read every message, though we may not be able to respond to each personally. Priority goes to:
- Corrections or factual clarifications on our articles
- Tool recommendations for upcoming reviews
- Questions about our methodology

## For tool vendors

**Pitching your product for review:**

Email: hello@aipickd.com with "Review Request" in the subject line.

Please include:
- Product name and URL
- 2-3 sentence description
- What makes it different from existing tools in the category
- Pricing tiers
- Any free trial or demo account available for our team

**Note:** We cannot guarantee coverage. Our editorial calendar is set by reader demand and SEO research.

## For affiliate program inquiries

**Interested in partnering with AIPickd?**

Email: hello@aipickd.com with "Affiliate Partnership" in the subject line.

## Response time

We aim to respond to all emails within 3-5 business days.`,
  },
];

(async () => {
  console.log("== create-legal-pages ==\n");

  // Check existing pages
  const existing = await wp("GET", "pages?per_page=100&_fields=id,slug,title");
  const existingSlugs = new Set(existing.map((p) => p.slug));
  console.log(`Existing pages: ${existing.map((p) => p.slug).join(", ") || "(none)"}\n`);

  for (const p of pages) {
    if (existingSlugs.has(p.slug)) {
      console.log(`  ⊘ Skip (already exists): ${p.title}`);
      continue;
    }
    try {
      const created = await wp("POST", "pages", {
        title: p.title,
        slug: p.slug,
        content: md(p.content),
        status: "publish",
      });
      console.log(`  ✓ Created: ${p.title} (#${created.id}) → ${created.link}`);
    } catch (e) {
      console.log(`  ✗ Failed: ${p.title} — ${e.message.slice(0, 100)}`);
    }
  }
  console.log("\n✅ Done.");
})();
