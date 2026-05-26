/**
 * AIPickd — Post-render HTML validator
 *
 * Catches bugs that only show up in the rendered HTML, NOT in the
 * markdown source. The fence + duplicate-H1 incident on 2026-05-25
 * was exactly this: the markdown looked fine but the HTML had the
 * literal "```markdown" string at the top and two <h1> tags.
 *
 * Run this AFTER mdToHtml() and BEFORE the WP POST. If it returns
 * issues, refuse to publish and mark the article qa_failed with the
 * issues recorded. Defense in depth — markdown-side checks already
 * exist in qualityGate(), this is the second layer that catches
 * anything the markdown checks missed (or the parser introduced).
 *
 * Pure function, no I/O, easy to unit-test.
 */

/**
 * @param {string} html  - rendered HTML body (no <head>, no doctype)
 * @param {string} title - article title (for dup-H1 detection)
 * @returns {string[]}   - list of issue descriptions; empty == clean
 */
function validateRenderedHtml(html, title = "") {
  const issues = [];
  if (typeof html !== "string" || html.length === 0) {
    issues.push("empty HTML");
    return issues;
  }

  // 1. Bare markdown fences leftover — these render as literal text and
  //    were exactly the bug we shipped on 2026-05-25 to 13 articles.
  if (/```[a-z]*/i.test(html)) issues.push("markdown fence in rendered HTML");

  // 2. Multiple H1 tags. WordPress adds its own <h1> from the post title,
  //    so the body should contain ZERO H1s. (mdToHtml strips the leading
  //    one; if any survive, it's a bug.)
  const h1Matches = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/gi) || [];
  if (h1Matches.length > 0) {
    issues.push(`${h1Matches.length} <h1> tag(s) in body (WP renders title's H1 separately — body should have zero)`);
  }

  // 3. Empty paragraphs — the mdToHtml block-splitter sometimes emits
  //    <p></p> when adjacent newlines confuse it. Visually ugly.
  const emptyP = (html.match(/<p>\s*<\/p>/gi) || []).length;
  if (emptyP > 0) issues.push(`${emptyP} empty <p> tag(s)`);

  // 4. Malformed tables — <table> without <thead> AND <tbody> is broken
  //    in WP's default editor view. Comparison tables NEED both.
  const tables = html.match(/<table[^>]*>[\s\S]*?<\/table>/gi) || [];
  for (const t of tables) {
    if (!/<thead/i.test(t) || !/<tbody/i.test(t)) {
      issues.push("malformed <table> (missing <thead> or <tbody>)");
      break; // one report is enough
    }
  }

  // 5. Unprocessed [AFFILIATE:...] tags — should have been resolved by
  //    the affiliate linker step before we got here.
  if (/\[AFFILIATE:/i.test(html)) {
    issues.push("unprocessed [AFFILIATE:] tag in HTML");
  }

  // 6. Bad/dangerous link targets that suggest broken markdown links.
  const badLinks = html.match(/href="(?:|#?|javascript:|file:|localhost)"/gi);
  if (badLinks && badLinks.length > 0) {
    issues.push(`${badLinks.length} link(s) with empty/unsafe href`);
  }

  // 7. Stray meta-comment leftover from the prompt (we sometimes put
  //    <!-- meta: ... --> as a marker that should be stripped).
  if (/<!--\s*meta:/i.test(html)) {
    issues.push("leftover <!-- meta: ... --> comment");
  }

  // 8. Title duplication mid-body — if the title literal shows up as
  //    an H2 (not the leading H1), still suspicious.
  if (title) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const titleAsH2 = new RegExp(`<h2[^>]*>\\s*${escaped}\\s*</h2>`, "i");
    if (titleAsH2.test(html)) {
      issues.push("post title duplicated as <h2> in body");
    }
  }

  return issues;
}

module.exports = { validateRenderedHtml };
