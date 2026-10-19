/**
 * Builds Indian Kanoon `formInput` strings. Filters are not separate URL
 * parameters: the API expects them inside formInput (e.g. `doctypes: delhi`),
 * matching the official reference client.
 */

export const COURT_DOCTYPES = [
  "supremecourt", "delhi", "bombay", "kolkata", "chennai", "allahabad", "andhra",
  "chattisgarh", "gauhati", "jammu", "srinagar", "kerala", "lucknow", "orissa",
  "uttaranchal", "gujarat", "himachal_pradesh", "jharkhand", "karnataka",
  "madhyapradesh", "patna", "punjab", "rajasthan", "sikkim", "kolkata_app",
  "jodhpur", "patna_orders", "meghalaya", "delhidc",
] as const;

export const TRIBUNAL_DOCTYPES = [
  "aptel", "drat", "cat", "cegat", "stt", "itat", "consumer", "cerc", "cic", "clb",
  "copyrightboard", "ipab", "mrtp", "sebisat", "tdsat", "trademark", "greentribunal", "cci",
] as const;

export const AGGREGATE_DOCTYPES = ["judgments", "highcourts", "tribunals", "laws"] as const;

export const ALL_DOCTYPES: ReadonlySet<string> = new Set([
  ...COURT_DOCTYPES,
  ...TRIBUNAL_DOCTYPES,
  ...AGGREGATE_DOCTYPES,
]);

export interface SearchFilters {
  doctypes?: string[];
  fromdate?: string;
  todate?: string;
  title?: string;
  cite?: string;
  author?: string;
  bench?: string;
  citedby?: number;
  sortby?: "mostrecent" | "leastrecent";
}

export class QueryError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "QueryError";
  }
}

/** Accepts DD-MM-YYYY, D-M-YYYY, YYYY-MM-DD or a bare year; returns DD-MM-YYYY. */
export function normalizeDate(input: string, end = false): string {
  const s = input.trim();
  let d: number, m: number, y: number;
  let match: RegExpMatchArray | null;
  if ((match = s.match(/^(\d{4})$/))) {
    y = Number(match[1]);
    [d, m] = end ? [31, 12] : [1, 1];
  } else if ((match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    throw new QueryError(`Invalid date "${input}". Use DD-MM-YYYY, YYYY-MM-DD or YYYY.`);
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new QueryError(`Invalid calendar date "${input}".`);
  }
  return `${String(d).padStart(2, "0")}-${String(m).padStart(2, "0")}-${y}`;
}

/**
 * Converts common boolean operators to Indian Kanoon syntax outside quoted
 * phrases: AND/&& -> ANDD, OR/|| -> ORR, NOT -> NOTT. Only uppercase words
 * are treated as operators so ordinary text like "and" stays a search term.
 */
export function normalizeOperators(q: string): string {
  const parts = q.split(/("[^"]*")/g);
  return parts
    .map((part) => {
      if (part.startsWith('"') && part.endsWith('"') && part.length >= 2) return part;
      return part
        .replace(/(^|\s)(?:AND|&&)(?=\s|$)/g, "$1ANDD")
        .replace(/(^|\s)(?:OR|\|\|)(?=\s|$)/g, "$1ORR")
        .replace(/(^|\s)NOT(?=\s|$)/g, "$1NOTT");
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanFilterValue(name: string, v: string): string {
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) throw new QueryError(`Empty value for ${name}.`);
  // A colon would let the value inject another filter into formInput.
  if (s.includes(":")) throw new QueryError(`${name} must not contain ":".`);
  return s;
}

export function buildFormInput(query: string, f: SearchFilters = {}): string {
  const parts: string[] = [];
  const q = normalizeOperators(query ?? "");
  if (q) parts.push(q);

  if (f.doctypes?.length) {
    const bad = f.doctypes.filter((d) => !ALL_DOCTYPES.has(d));
    if (bad.length) throw new QueryError(`Unknown doctypes: ${bad.join(", ")}. Valid: ${[...ALL_DOCTYPES].join(", ")}.`);
    parts.push(`doctypes: ${[...new Set(f.doctypes)].sort().join(",")}`);
  }
  let from: string | undefined;
  let to: string | undefined;
  if (f.fromdate) parts.push(`fromdate: ${(from = normalizeDate(f.fromdate, false))}`);
  if (f.todate) parts.push(`todate: ${(to = normalizeDate(f.todate, true))}`);
  if (from && to) {
    const toKey = (s: string) => s.split("-").reverse().join("");
    if (toKey(from) > toKey(to)) throw new QueryError("fromdate is after todate.");
  }
  if (f.title) parts.push(`title: ${cleanFilterValue("title", f.title)}`);
  if (f.cite) parts.push(`cite: ${cleanFilterValue("cite", f.cite)}`);
  if (f.author) parts.push(`author: ${cleanFilterValue("author", f.author)}`);
  if (f.bench) parts.push(`bench: ${cleanFilterValue("bench", f.bench)}`);
  if (f.citedby !== undefined) parts.push(`citedby: ${f.citedby}`);
  if (f.sortby) parts.push(`sortby: ${f.sortby}`);

  const out = parts.join(" ");
  if (!out) throw new QueryError("Provide a query or at least one filter.");
  if (out.length > 2000) throw new QueryError("Query too long (max 2000 characters).");
  return out;
}
