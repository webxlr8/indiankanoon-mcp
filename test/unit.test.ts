import { describe, expect, it } from "vitest";
import { cleanTitle, focusFragment, formatSearchResults, htmlToText, inlineText, parseDocument, renderBlocks, sectionStats, sliceText } from "../src/format.js";
import { buildFormInput, normalizeDate, normalizeOperators, QueryError } from "../src/query.js";

describe("normalizeDate", () => {
  it("accepts common formats", () => {
    expect(normalizeDate("2020-01-05")).toBe("05-01-2020");
    expect(normalizeDate("5-1-2020")).toBe("05-01-2020");
    expect(normalizeDate("05/01/2020")).toBe("05-01-2020");
    expect(normalizeDate("1999")).toBe("01-01-1999");
    expect(normalizeDate("1999", true)).toBe("31-12-1999");
  });
  it("rejects impossible dates", () => {
    expect(() => normalizeDate("31-02-2020")).toThrow(QueryError);
    expect(() => normalizeDate("yesterday")).toThrow(QueryError);
  });
});

describe("normalizeOperators", () => {
  it("maps uppercase operators outside quotes", () => {
    expect(normalizeOperators('murder AND dowry OR "NOT guilty" NOT bail')).toBe('murder ANDD dowry ORR "NOT guilty" NOTT bail');
  });
  it("leaves lowercase words and existing operators alone", () => {
    expect(normalizeOperators("search and seizure ANDD bail")).toBe("search and seizure ANDD bail");
  });
});

describe("buildFormInput", () => {
  it("appends filters in Indian Kanoon syntax", () => {
    expect(
      buildFormInput("right to privacy", {
        doctypes: ["supremecourt"],
        fromdate: "2017",
        todate: "2017-12-31",
        sortby: "mostrecent",
      }),
    ).toBe("right to privacy doctypes: supremecourt fromdate: 01-01-2017 todate: 31-12-2017 sortby: mostrecent");
  });
  it("is deterministic for doctypes order so cache keys match", () => {
    expect(buildFormInput("x", { doctypes: ["delhi", "bombay", "delhi"] })).toBe("x doctypes: bombay,delhi");
  });
  it("rejects unknown doctypes, inverted ranges and filter injection", () => {
    expect(() => buildFormInput("x", { doctypes: ["mars"] })).toThrow(/Unknown doctypes/);
    expect(() => buildFormInput("x", { fromdate: "2020", todate: "2019" })).toThrow(/after/);
    expect(() => buildFormInput("x", { title: "a doctypes: laws" })).toThrow(/":"/);
    expect(() => buildFormInput("")).toThrow(QueryError);
  });
  it("supports filter-only and citedby queries", () => {
    expect(buildFormInput("", { citedby: 1199182 })).toBe("citedby: 1199182");
  });
});

describe("htmlToText", () => {
  it("keeps paragraphs, decodes entities and strips tags", () => {
    const html =
      '<div class="judgments"><pre>Supreme Court of India\n  A  vs  B</pre><p id="p_1">1. The appellant&#39;s claim &amp; the <b>Act</b>.</p>' +
      '<blockquote>Quoted&nbsp;text</blockquote><p>See <a href="/doc/123/">Kesavananda</a>.</p></div>';
    const text = htmlToText(html);
    expect(text).toContain("Supreme Court of India\nA vs B");
    expect(text).not.toContain("## ");
    expect(text).toContain("1. The appellant's claim & the Act.");
    expect(text).toContain("> Quoted text");
    expect(text).not.toMatch(/<|\n{3,}/);
    expect(htmlToText(html, { keepDocLinks: true })).toContain("Kesavananda [doc:123]");
  });
  it("reflows PDF hard wraps, drops page numbers and the duplicate title", () => {
    const html =
      '<h2 class="doc_title">X vs Y</h2><h3 class="doc_author">Author: <a href="/search/?formInput=authorid:a">A B</a></h3>' +
      '<p data-structure="Issue" id="p_1">1      Nine judges of this Court assembled to determine whether privacy is a\n\n' +
      "constitutionally protected value. The overarching presence of state and non-\n\nstate entities.\n\n" +
      '<span class="hidden_text" id="span_2">                3</span>\n\f      PART A\nA   The reference\nB   Decision</p>' +
      '<blockquote id="blockquote_1">   “12. We are of the opinion that the cases\n   raise questions.</blockquote>' +
      '<p data-structure="Conclusion" id="p_2">Privacy is a fundamental right.</p>';
    const blocks = parseDocument(html);
    const text = renderBlocks(blocks);
    expect(text).toContain("1 Nine judges of this Court assembled to determine whether privacy is a constitutionally protected value.");
    expect(text).toContain("state and non-state entities.");
    expect(text).toContain("PART A\nA The reference\nB Decision");
    expect(text).not.toMatch(/X vs Y|\b3\b\n|\f/);
    expect(text).toContain("Author: A B");
    expect(blocks.find((b) => b.text.startsWith(">"))?.section).toBe("issues");
    expect(renderBlocks(blocks, new Set(["conclusion"]))).toBe("[conclusion]\n\nPrivacy is a fundamental right.");
    expect(sectionStats(blocks)).toBe("issues 2 · conclusion 1");
  });
  it("joins wrapped lines but keeps list items apart", () => {
    const text = htmlToText(
      "<p>2. Rights recognised by this Charter which are based on the\nCommunity Treaties shall apply.\n(viii) Openness: a data controller shall take steps to implement\n(ix) Choice and consent</p>",
    );
    expect(text).toBe("2. Rights recognised by this Charter which are based on the Community Treaties shall apply.\n(viii) Openness: a data controller shall take steps to implement\n(ix) Choice and consent");
  });
  it("inlineText collapses whitespace", () => {
    expect(inlineText("<b>Right</b>  to\n privacy")).toBe("Right to privacy");
  });
});

describe("sliceText", () => {
  const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}. ${"word ".repeat(40).trim()}.`).join("\n\n");
  it("covers the whole text without gaps or overlap", () => {
    let offset = 0;
    let rebuilt = "";
    for (let guard = 0; guard < 100; guard++) {
      const { chunk, next } = sliceText(text, offset, 1500);
      expect(chunk.length).toBeLessThanOrEqual(1500);
      rebuilt += (rebuilt ? "\n\n" : "") + chunk;
      if (next === null) break;
      expect(next).toBeGreaterThan(offset);
      offset = next;
    }
    expect(rebuilt).toBe(text);
  });
  it("ends chunks on paragraph boundaries", () => {
    const { chunk } = sliceText(text, 0, 1500);
    expect(chunk.endsWith(".")).toBe(true);
  });
});

describe("search result formatting", () => {
  it("strips the trailing date from titles", () => {
    expect(cleanTitle("Asha Ranjan vs State Of Bihar And Ors on 15 February, 2017")).toBe("Asha Ranjan vs State Of Bihar And Ors");
  });
  it("drops snippets that only repeat the title and folds duplicate cases", () => {
    const docs = [
      { tid: 1, title: "Power Machines vs State on 17 April, 2017", headline: "Power Machines vs State on 17 April", docsource: "Supreme Court of India", publishdate: "2017-04-17" },
      { tid: 2, title: "Power Machines vs State on 17 April, 2017", headline: "x", docsource: "Supreme Court - Daily Orders", publishdate: "2017-04-17" },
      { tid: 3, title: "Other vs Union", headline: "the <b>buyer</b> located anywhere in India", publishdate: "2020-01-01" },
    ];
    const out = formatSearchResults(docs, 1, 200, 0);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("1. [1] Power Machines vs State — Supreme Court of India · 2017-04-17\n   same case also: [2] Supreme Court - Daily Orders");
    expect(out[1]).toContain("3. [3] Other vs Union");
    expect(out[1]).toContain("the buyer located anywhere in India");
  });
});

describe("focusFragment", () => {
  it("keeps short passages whole and centres long ones on the first match", () => {
    expect(focusFragment("short <b>match</b>", 600)).toBe("short match");
    const long = `${"a ".repeat(500)}<b>needle</b>${" z".repeat(500)}`;
    const f = focusFragment(long, 200);
    expect(f).toContain("needle");
    expect(f.length).toBeLessThanOrEqual(202);
    expect(f.startsWith("…") && f.endsWith("…")).toBe(true);
  });
  it("prefers the window with the most matches over the first match", () => {
    const html = `<b>Section</b> ${"filler ".repeat(100)}rule on its own <b>jurisdiction</b> under <b>Section</b> <b>16</b> ${"tail ".repeat(100)}`;
    const f = focusFragment(html, 300);
    expect(f).toContain("rule on its own jurisdiction under Section 16");
  });
});
