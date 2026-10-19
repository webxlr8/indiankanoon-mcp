import type { CiteRef, DocResponse, SearchDoc } from "./client.js";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", sect: "§", para: "¶",
  copy: "©", reg: "®", deg: "°", middot: "·", bull: "•", rupee: "₹", times: "×",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Inline HTML (search headlines, titles) to a single line of plain text. */
export function inlineText(html: string | undefined): string {
  if (!html) return "";
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Indian Kanoon tags each judgment paragraph with `data-structure`. These are
 * the labels exposed to tools, so a model can read only the holding or only
 * the facts instead of a whole judgment.
 */
export const SECTION_LABELS: Record<string, string> = {
  Facts: "facts",
  Issue: "issues",
  PetArg: "petitioner_arguments",
  RespArg: "respondent_arguments",
  Section: "provisions",
  Precedent: "precedents",
  CDiscource: "court_reasoning",
  Conclusion: "conclusion",
};
export const SECTION_NAMES = Object.values(SECTION_LABELS);

export interface Block {
  /** Friendly section name, "header" before the first labelled paragraph, or null when the document has no labels. */
  section: string | null;
  text: string;
}

// Private-use markers survive tag stripping and entity decoding untouched.
const BLOCK = "\uE000";
const LABEL_OPEN = "\uE001";
const LABEL_CLOSE = "\uE002";
const QUOTE = "\uE003";
const PRE = "\uE004";

const TERMINAL = /[.:;?!]["”’)\]]?$/;
// Line starts that mark a new list item or numbered paragraph: "A ", "2. ", "(viii) ", "iv) ".
const LIST_START = /^(?:[A-Z]|[IVXLC]{1,6}|[ivxlc]{1,6}|\d{1,3}|\([a-zA-Z0-9]{1,5}\))[.)]?\s/;

/**
 * Rejoins text that the source PDF hard-wrapped. Indian Kanoon keeps the PDF
 * line breaks (often doubled) inside paragraphs; leaving them in wastes tokens
 * and breaks sentences across chunk boundaries.
 */
function reflow(raw: string, keepBlankLines: boolean): string {
  const lines = raw.split("\n").map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim());
  let out = "";
  let prev = "";
  let sawBlank = false;
  for (const line of lines) {
    if (!line) {
      sawBlank = true;
      continue;
    }
    if (!out) {
      out = line;
    } else if (/[a-z]-$/.test(prev) && /^[a-z]/.test(line)) {
      out += line; // re-join a hyphenated word split across lines
    } else if (/^[a-z]/.test(line) || (prev.length >= 40 && !TERMINAL.test(prev) && !LIST_START.test(line))) {
      out += ` ${line}`;
    } else {
      out += keepBlankLines && sawBlank && TERMINAL.test(prev) ? `\n\n${line}` : `\n${line}`;
    }
    prev = line;
    sawBlank = false;
  }
  return out;
}

/** Splits judgment HTML into clean plain-text blocks tagged with their section. */
export function parseDocument(html: string | undefined, opts: { keepDocLinks?: boolean } = {}): Block[] {
  if (!html) return [];
  let s = html;
  s = s.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Page numbers from the source PDF: pure noise.
  s = s.replace(/<span\b[^>]*class="hidden_text"[^>]*>[^<]*<\/span>/gi, "");
  s = s.replace(/\f/g, "\n");
  if (opts.keepDocLinks) {
    s = s.replace(/<a\b[^>]*href="\/doc\/(\d+)\/?"[^>]*>([\s\S]*?)<\/a>/gi, "$2 [doc:$1]");
  }
  s = s.replace(/<h2\b[^>]*class="doc_title"[^>]*>[\s\S]*?<\/h2>/i, ""); // repeated in the tool header
  s = s.replace(/<p\b[^>]*data-structure="(\w+)"[^>]*>/gi, `${BLOCK}${LABEL_OPEN}$1${LABEL_CLOSE}`);
  s = s.replace(/<pre\b[^>]*>/gi, `${BLOCK}${PRE}`);
  s = s.replace(/<blockquote\b[^>]*>/gi, `${BLOCK}${QUOTE}`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, `${BLOCK}- `);
  s = s.replace(/<\/?(p|div|pre|blockquote|h[1-6]|li|ul|ol|table|tr|section|article)\b[^>]*>/gi, BLOCK);
  s = s.replace(/<\/t[dh]>/gi, " | ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);

  const blocks: Block[] = [];
  const labelled = s.includes(LABEL_OPEN);
  let section: string | null = labelled ? "header" : null;
  for (let part of s.split(BLOCK)) {
    let isQuote = false;
    let isPre = false;
    const m = part.match(new RegExp(`^${LABEL_OPEN}(\\w+)${LABEL_CLOSE}`));
    if (m) {
      section = SECTION_LABELS[m[1] as string] ?? (m[1] as string).toLowerCase();
      part = part.slice(m[0].length);
    }
    if (part.startsWith(QUOTE)) [isQuote, part] = [true, part.slice(1)];
    if (part.startsWith(PRE)) [isPre, part] = [true, part.slice(1)];
    const text = reflow(part, isPre);
    if (!text) continue;
    blocks.push({ section, text: isQuote ? `> ${text}` : text });
  }
  return blocks;
}

export function renderBlocks(blocks: Block[], sections?: ReadonlySet<string>): string {
  if (!sections || sections.size === 0) return blocks.map((b) => b.text).join("\n\n");
  const out: string[] = [];
  let last: string | null = null;
  for (const b of blocks) {
    if (!b.section || !sections.has(b.section)) continue;
    if (b.section !== last) out.push(`[${b.section}]`);
    out.push(b.text);
    last = b.section;
  }
  return out.join("\n\n");
}

export function sectionStats(blocks: Block[]): string | null {
  const counts = new Map<string, number>();
  for (const b of blocks) if (b.section && b.section !== "header") counts.set(b.section, (counts.get(b.section) ?? 0) + 1);
  if (counts.size === 0) return null;
  return SECTION_NAMES.filter((n) => counts.has(n)).map((n) => `${n} ${counts.get(n)}`).join(" · ");
}

/** Judgment HTML to compact plain text with paragraph boundaries kept. */
export function htmlToText(html: string | undefined, opts: { keepDocLinks?: boolean } = {}): string {
  return renderBlocks(parseDocument(html, opts));
}

/** The API names citation lists `cites`/`citedby` on /doc/ and `citeList`/`citedbyList` elsewhere. */
export function citesOf(d: { [k: string]: unknown }): CiteRef[] | undefined {
  const v = d.citeList ?? d.cites;
  return Array.isArray(v) ? (v as CiteRef[]) : undefined;
}
export function citedByOf(d: { [k: string]: unknown }): CiteRef[] | undefined {
  const v = d.citedbyList ?? d.citedby;
  return Array.isArray(v) ? (v as CiteRef[]) : undefined;
}

export function docUrl(tid: number | string): string {
  return `https://indiankanoon.org/doc/${tid}/`;
}

function clip(s: string, max: number): string {
  if (max <= 0 || s.length <= max) return s;
  return `${s.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

/** Titles end with " on 24 August, 2017"; the date is printed separately, so drop it. */
export function cleanTitle(title: string | undefined): string {
  return inlineText(title).replace(/\s+on\s+\d{1,2}\s+[A-Za-z]+,?\s+\d{4}\s*$/, "");
}

/** Indian Kanoon often returns the title itself as the "snippet"; that carries no information. */
function snippetFor(d: SearchDoc, maxChars: number): string {
  if (maxChars <= 0) return "";
  const h = inlineText(d.headline);
  const t = cleanTitle(d.title);
  if (!h || (t && h.toLowerCase().startsWith(t.slice(0, 25).toLowerCase()))) return "";
  return clip(h, maxChars);
}

export function formatSearchDoc(d: SearchDoc, i: number, headlineChars: number, citeCount: number, also: SearchDoc[] = []): string {
  const meta: string[] = [];
  if (d.docsource) meta.push(inlineText(d.docsource));
  if (d.publishdate) meta.push(String(d.publishdate));
  if (d.citation) meta.push(inlineText(String(d.citation)));
  if (typeof d.numcitedby === "number") meta.push(`cited by ${d.numcitedby}`);
  if (typeof d.docsize === "number") meta.push(`${Math.round(d.docsize / 1000)}k chars`);
  const lines = [`${i}. [${d.tid}] ${cleanTitle(d.title)}${meta.length ? ` — ${meta.join(" · ")}` : ""}`];
  if (also.length) {
    lines.push(`   same case also: ${also.map((x) => `[${x.tid}]${x.docsource && x.docsource !== d.docsource ? ` ${inlineText(x.docsource)}` : ""}`).join(", ")}`);
  }
  const headline = snippetFor(d, headlineChars);
  if (headline) lines.push(`   ${headline}`);
  const cites = citesOf(d);
  if (citeCount > 0 && Array.isArray(cites) && cites.length) {
    lines.push(`   cites: ${cites.slice(0, citeCount).map((c) => `[${c.tid}] ${cleanTitle(c.title)}`).join("; ")}`);
  }
  return lines.join("\n");
}

/**
 * Formats a result page, folding repeated entries for the same case (same
 * title and date, e.g. a judgment and its "Daily Orders" copy) into one line.
 */
export function formatSearchResults(docs: SearchDoc[], startIndex: number, headlineChars: number, citeCount: number): string[] {
  const groups = new Map<string, { first: SearchDoc; index: number; also: SearchDoc[] }>();
  docs.forEach((d, i) => {
    const key = `${cleanTitle(d.title).toLowerCase()}|${d.publishdate ?? ""}`;
    const g = groups.get(key);
    if (g) g.also.push(d);
    else groups.set(key, { first: d, index: startIndex + i, also: [] });
  });
  return [...groups.values()].map((g) => formatSearchDoc(g.first, g.index, headlineChars, citeCount, g.also));
}

/**
 * Trims one matching passage to the window that holds the most highlighted
 * terms. Indian Kanoon marks matches with <b>, so the kept part is the part
 * that answers the query.
 */
export function focusFragment(html: string, maxChars: number): string {
  const text = inlineText(html);
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const hits: number[] = [];
  const re = /<b>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) hits.push(inlineText(html.slice(0, m.index)).length);
  if (hits.length === 0) hits.push(0);
  const lead = Math.floor(maxChars / 5);
  let best = 0;
  let bestCount = -1;
  for (const h of hits) {
    const s = Math.max(0, h - lead);
    const count = hits.filter((x) => x >= s && x < s + maxChars - 20).length;
    if (count > bestCount) [best, bestCount] = [s, count];
  }
  let start = Math.min(best, text.length - maxChars);
  if (start > 0) {
    const sp = text.indexOf(" ", start);
    if (sp >= 0 && sp - start < 30) start = sp + 1;
  }
  let end = Math.min(text.length, start + maxChars);
  if (end < text.length) {
    const sp = text.lastIndexOf(" ", end);
    if (sp > start + maxChars / 2) end = sp;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function formatCiteList(label: string, list: CiteRef[] | undefined, total: number | undefined, limit: number): string | null {
  if (limit <= 0 || !Array.isArray(list) || list.length === 0) return null;
  const shown = list.slice(0, limit);
  const totalNote = typeof total === "number" && total > shown.length ? ` (showing ${shown.length} of ${total})` : "";
  return `${label}${totalNote}:\n${shown.map((c) => `- [${c.tid}] ${inlineText(c.title)}`).join("\n")}`;
}

export function formatDocHeader(tid: number, d: DocResponse): string {
  const lines = [`[${tid}] ${inlineText(d.title) || "(untitled)"}`];
  const meta: string[] = [];
  const court = d.docsource ?? (typeof d.doctype === "string" ? d.doctype : undefined);
  if (court) meta.push(inlineText(court));
  if (d.publishdate) meta.push(String(d.publishdate));
  if (typeof d.numcites === "number") meta.push(`cites ${d.numcites}`);
  if (typeof d.numcitedby === "number") meta.push(`cited by ${d.numcitedby}`);
  if (meta.length) lines.push(meta.join(" · "));
  lines.push(docUrl(tid));
  return lines.join("\n");
}

/**
 * Picks a window of text that ends on a paragraph (or at least sentence)
 * boundary so the model never sees a half-cut sentence.
 */
export function sliceText(text: string, offset: number, maxChars: number): { chunk: string; next: number | null } {
  const start = Math.max(0, Math.min(offset, text.length));
  if (start + maxChars >= text.length) return { chunk: text.slice(start), next: null };
  const hardEnd = start + maxChars;
  const window = text.slice(start, hardEnd);
  const minEnd = Math.floor(maxChars * 0.6);
  let cut = window.lastIndexOf("\n\n");
  if (cut < minEnd) {
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"));
    cut = sentence >= minEnd ? sentence + 1 : cut;
  }
  if (cut < minEnd) cut = window.lastIndexOf(" ") >= minEnd ? window.lastIndexOf(" ") : maxChars;
  const end = start + cut;
  let next = end;
  while (next < text.length && /\s/.test(text[next] as string)) next++;
  return { chunk: text.slice(start, end).trimEnd(), next };
}
