import { promises as fs } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { BudgetExceededError } from "./budget.js";
import { IKApiError, IKClient, type DocResponse } from "./client.js";
import type { Config } from "./config.js";
import {
  citedByOf,
  citesOf,
  docUrl,
  focusFragment,
  formatCiteList,
  formatDocHeader,
  formatSearchResults,
  inlineText,
  parseDocument,
  renderBlocks,
  SECTION_NAMES,
  sectionStats,
  sliceText,
  type Block,
} from "./format.js";
import type { Logger } from "./logger.js";
import { buildFormInput, normalizeOperators, QueryError } from "./query.js";

export const SERVER_INSTRUCTIONS = `Indian Kanoon legal research (Indian case law, statutes, tribunals). Every uncached API call costs money, so work cheapest-first:
1. ik_search (Rs 0.50/page) to find documents. Use filters (doctypes, dates, title, cite, author, bench) instead of extra searches. For a statute, use doctypes ["laws"] with title set to the Act name.
2. ik_fragments (Rs 0.05) to read only the passages of a document that match a query. Prefer this to reading whole judgments.
3. ik_metadata (Rs 0.02) for title, court, date and citation lists.
4. ik_document (Rs 0.20, then free) when you need the reasoning. Pass sections (e.g. issues, conclusion) to read only those paragraphs. Later chunks and sections of the same document are served from cache.
Repeated calls are cached and free. Always cite documents by title and URL https://indiankanoon.org/doc/<id>/. Quote only text the tools returned.`;

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolContext {
  client: IKClient;
  cfg: Config;
  log: Logger;
  /** Remote deployments return a download link instead of a server-side file path. */
  courtCopyLink?: (fileName: string) => string;
}

const docid = z.number().int().positive().describe("Indian Kanoon document id (tid)");

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function costLine(costInr: number, cached: boolean): string {
  return cached ? "cost: Rs 0 (cached)" : `cost: Rs ${costInr.toFixed(2)}`;
}

function fail(e: unknown, log: Logger): ToolResult {
  if (e instanceof QueryError || e instanceof BudgetExceededError || e instanceof IKApiError) return err(e.message);
  if (e instanceof z.ZodError) return err(`Invalid arguments: ${e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
  log.error("tool failed", { err: e instanceof Error ? e.stack : String(e) });
  return err("Internal error while calling Indian Kanoon. See server logs.");
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

/** Defines every tool once so the MCP server and the REST API share the same behaviour. */
export function buildTools(ctx: ToolContext): ToolDef[] {
  const { client, cfg, log } = ctx;

  const define = <S extends ZodRawShape>(
    def: Omit<ToolDef, "handler" | "inputSchema"> & { inputSchema: S; run: (a: z.infer<z.ZodObject<S>>) => Promise<ToolResult> },
  ): ToolDef => {
    const schema = z.object(def.inputSchema);
    return {
      name: def.name,
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
      handler: async (raw) => {
        try {
          return await def.run(schema.parse(raw ?? {}) as z.infer<z.ZodObject<S>>);
        } catch (e) {
          return fail(e, log);
        }
      },
    };
  };

  const tools: ToolDef[] = [];

  tools.push(
    define({
      name: "ik_search",
      title: "Search Indian Kanoon",
      description:
        "Search Indian judgments, statutes and tribunal orders. Rs 0.50 per result page (10 results). " +
        'Query syntax: "exact phrase", ANDD (default between words), ORR, NOTT; plain AND/OR/NOT are converted. ' +
        "Returns [docid] title — court · date · citation · cited-by count, plus a matching snippet.",
      inputSchema: {
        query: z.string().max(1000).default("").describe("Search terms. May be empty when filters are given."),
        doctypes: z
          .array(z.string())
          .max(10)
          .optional()
          .describe(
            "Court filters: supremecourt, highcourts, judgments, tribunals, laws (central acts), or a court code such as delhi, bombay, chennai, kolkata, allahabad, karnataka, kerala, gujarat, punjab, rajasthan, itat, consumer, cat, greentribunal.",
          ),
        fromdate: z.string().optional().describe("Earliest decision date: DD-MM-YYYY, YYYY-MM-DD or YYYY"),
        todate: z.string().optional().describe("Latest decision date: DD-MM-YYYY, YYYY-MM-DD or YYYY"),
        title: z.string().max(200).optional().describe("Words that must appear in the title, e.g. a party name or Act name"),
        cite: z.string().max(100).optional().describe('Citation, e.g. "1973 AIR 1461" or "(2017) 10 SCC 1"'),
        author: z.string().max(100).optional().describe("Judge who wrote the judgment"),
        bench: z.string().max(100).optional().describe("Judge on the bench"),
        cited_by_docid: z.number().int().positive().optional().describe("Only documents that cite this docid"),
        sort: z.enum(["relevance", "mostrecent", "leastrecent"]).default("relevance"),
        page: z.number().int().min(0).max(999).default(0).describe("0-based result page"),
        pages: z
          .number()
          .int()
          .min(1)
          .max(cfg.maxPagesPerSearch)
          .default(1)
          .describe("Pages to fetch in one call (10 results each, Rs 0.50 each)"),
        snippet_chars: z.number().int().min(0).max(1000).default(200).describe("Snippet length per result; 0 omits snippets"),
        include_cites: z.number().int().min(0).max(10).default(0).describe("Cited authorities to list per result"),
      },
      annotations: { ...READ_ONLY, title: "Search Indian Kanoon" },
      run: async (a) => {
        const formInput = buildFormInput(a.query, {
          doctypes: a.doctypes,
          fromdate: a.fromdate,
          todate: a.todate,
          title: a.title,
          cite: a.cite,
          author: a.author,
          bench: a.bench,
          citedby: a.cited_by_docid,
          sortby: a.sort === "relevance" ? undefined : a.sort,
        });
        const res = await client.search(formInput, a.page, a.pages, a.include_cites > 0);
        const docs = res.data.docs ?? [];
        const head = [`query: ${formInput}`, `found: ${inlineText(String(res.data.found ?? docs.length))}`, costLine(res.costInr, res.cached)];
        if (docs.length === 0) return ok(`${head.join("\n")}\nNo results. Broaden terms, drop filters, or try synonyms.`);
        const body = formatSearchResults(docs, a.page * 10 + 1, a.snippet_chars, a.include_cites);
        const lastPage = a.page + Math.ceil(docs.length / 10) - 1;
        const more = docs.length >= a.pages * 10 ? `\nmore: page=${lastPage + 1}` : "";
        return ok(`${head.join("\n")}\n\n${body.join("\n")}${more}`);
      },
    }),
  );

  tools.push(
    define({
      name: "ik_fragments",
      title: "Matching passages in a document",
      description:
        "Return only the passages of one document that match a query (Rs 0.05). Cheapest way to verify a holding, find a section or quote a paragraph without reading the whole judgment.",
      inputSchema: {
        docid,
        query: z.string().min(1).max(500).describe('Terms or "exact phrase" to locate in the document'),
        max_chars_per_fragment: z
          .number()
          .int()
          .min(0)
          .max(5000)
          .default(900)
          .describe("Trim each passage to this many characters around the match; 0 returns whole passages"),
      },
      annotations: { ...READ_ONLY, title: "Matching passages" },
      run: async (a) => {
        const q = normalizeOperators(a.query);
        const res = await client.fragment(a.docid, q);
        const raw = res.data.headline;
        const frags = (Array.isArray(raw) ? raw : raw ? [raw] : [])
          .map((h) => focusFragment(String(h), a.max_chars_per_fragment))
          .filter(Boolean);
        const lines = [`[${a.docid}] ${inlineText(res.data.title) || "(untitled)"}`, docUrl(a.docid), costLine(res.costInr, res.cached), ""];
        if (frags.length === 0) lines.push(`No passages match "${q}". Try other terms or ik_document.`);
        else frags.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
        return ok(lines.join("\n"));
      },
    }),
  );

  tools.push(
    define({
      name: "ik_metadata",
      title: "Document metadata and citations",
      description:
        "Title, court, date, and the authorities a document cites and is cited by (Rs 0.02, free if the full document is already cached). Use to check precedent treatment or build a citation trail.",
      inputSchema: {
        docid,
        cites_limit: z.number().int().min(0).max(50).default(10).describe("Authorities cited by this document to list"),
        citedby_limit: z.number().int().min(0).max(50).default(10).describe("Later documents citing this one to list"),
      },
      annotations: { ...READ_ONLY, title: "Document metadata" },
      run: async (a) => {
        let data: DocResponse;
        let cost = "cost: Rs 0 (cached)";
        const fromDoc = await client.peekDoc(a.docid);
        if (fromDoc) {
          data = fromDoc;
        } else {
          const res = await client.meta(a.docid);
          data = res.data;
          cost = costLine(res.costInr, res.cached);
        }
        const parts = [formatDocHeader(a.docid, data), cost];
        const extra = extraScalars(data);
        if (extra) parts.push(extra);
        const cites = formatCiteList("Cites", citesOf(data), data.numcites, a.cites_limit);
        const citedby = formatCiteList("Cited by", citedByOf(data), data.numcitedby, a.citedby_limit);
        if (cites) parts.push(cites);
        if (citedby) parts.push(citedby);
        return ok(parts.join("\n\n"));
      },
    }),
  );

  tools.push(
    define({
      name: "ik_document",
      title: "Read a document",
      description:
        "Text of a judgment or statute as clean plain text, in chunks. First call costs Rs 0.20; every later call on the same document (other chunks, other sections) is free from cache. " +
        'Use `sections` to read only part of a judgment, e.g. ["issues","conclusion"] for the holding. Prefer ik_fragments when you only need specific passages.',
      inputSchema: {
        docid,
        offset: z.number().int().min(0).default(0).describe("Character offset; use the next_offset value from the previous chunk"),
        max_chars: z.number().int().min(1000).max(60000).default(12000).describe("Chunk size in characters (~4 chars per token)"),
        cites_limit: z.number().int().min(0).max(50).default(5).describe("Cited authorities to list on the first chunk"),
        citedby_limit: z.number().int().min(0).max(50).default(5).describe("Citing documents to list on the first chunk"),
        sections: z
          .array(z.enum(SECTION_NAMES as [string, ...string[]]))
          .optional()
          .describe("Only paragraphs Indian Kanoon tagged with these roles. Omit for the full text. Offsets refer to the filtered text."),
        keep_doc_links: z.boolean().default(false).describe("Mark inline references to other documents as [doc:<id>]"),
      },
      annotations: { ...READ_ONLY, title: "Read document" },
      run: async (a) => {
        const res = await client.doc(a.docid);
        const blocks = parsedBlocks(a.docid, res.data.doc, a.keep_doc_links);
        const filter = a.sections?.length ? new Set(a.sections) : undefined;
        const text = renderBlocks(blocks, filter);
        if (!text) {
          const why = filter
            ? `No paragraphs tagged ${[...filter].join(", ")}. Available: ${sectionStats(blocks) ?? "none (document is not tagged; read without sections)"}.`
            : "Document has no text.";
          return ok(`${formatDocHeader(a.docid, res.data)}\n${costLine(res.costInr, res.cached)}\n${why}`);
        }
        if (a.offset >= text.length) return err(`offset ${a.offset} is past the end (length ${text.length}).`);
        const { chunk, next } = sliceText(text, a.offset, a.max_chars);
        const parts: string[] = [];
        if (a.offset === 0) {
          parts.push(formatDocHeader(a.docid, res.data));
          const cites = formatCiteList("Cites", citesOf(res.data), res.data.numcites, a.cites_limit);
          const citedby = formatCiteList("Cited by", citedByOf(res.data), res.data.numcitedby, a.citedby_limit);
          if (cites) parts.push(cites);
          if (citedby) parts.push(citedby);
          const stats = sectionStats(blocks);
          if (stats) parts.push(`sections (paragraphs): ${stats}`);
        } else {
          parts.push(`[${a.docid}] ${inlineText(res.data.title)}`);
        }
        const end = a.offset + chunk.length;
        const status =
          `${filter ? `sections ${[...filter].join(",")} · ` : ""}chars ${a.offset}-${end} of ${text.length} · ${costLine(res.costInr, res.cached)}` +
          (next !== null ? ` · next_offset: ${next}` : " · end of document");
        parts.push(status, "---", chunk);
        if (next !== null) parts.push(`--- continue with offset=${next}`);
        return ok(parts.join("\n\n"));
      },
    }),
  );

  if (cfg.enableOrigdoc) {
    tools.push(
      define({
        name: "ik_court_copy",
        title: "Download official court copy",
        description: ctx.courtCopyLink
          ? "Get a download link for the original court-issued copy (usually PDF) of a judgment (Rs 0.50). Use only when the user needs the original file."
          : "Download the original court-issued copy (usually PDF) of a judgment to disk and return the file path (Rs 0.50). Use only when the user needs the original file.",
        inputSchema: { docid },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true, title: "Court copy" },
        run: async (a) => {
          const res = await client.origdoc(a.docid);
          const b64 = res.data.doc;
          if (!b64) return err("No court copy is available for this document.");
          const type = String(res.data["Content-Type"] ?? "application/octet-stream");
          const buf = Buffer.from(b64, "base64");
          const name = `${a.docid}.${extensionFor(type)}`;
          await fs.mkdir(cfg.downloadDir, { recursive: true });
          const file = path.join(cfg.downloadDir, name);
          await fs.writeFile(file, buf);
          const where = ctx.courtCopyLink ? `download: ${ctx.courtCopyLink(name)} (link valid 24 hours)` : `saved: ${file}`;
          return ok(`${where}\ntype: ${type}\nsize: ${buf.length} bytes\n${costLine(res.costInr, res.cached)}\nsource: ${docUrl(a.docid)}`);
        },
      }),
    );
  }

  tools.push(
    define({
      name: "ik_usage",
      title: "API spend and cache stats",
      description: "Show today's Indian Kanoon spend, remaining budget, and cache savings. Free.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false, title: "Usage" },
      run: async () => {
        const b = client.budget.snapshot();
        const c = client.cache.stats;
        const calls = (o: Record<string, number | undefined>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
        const lines = [
          `today (${b.today.day} IST): Rs ${b.today.spentInr.toFixed(2)} spent; calls: ${calls(b.today.calls)}`,
          `daily cap: ${b.capInr > 0 ? `Rs ${b.capInr.toFixed(2)}, remaining Rs ${b.remainingInr?.toFixed(2)}` : "none"}`,
          `since restart: Rs ${b.session.spentInr.toFixed(2)} spent, Rs ${b.session.savedInr.toFixed(2)} saved by cache; calls: ${calls(b.session.calls)}`,
          `cache: ${c.memHits} memory hits, ${c.diskHits} disk hits, ${c.misses} misses`,
          "Spend is estimated from published prices; your Indian Kanoon account statement is authoritative.",
        ];
        return ok(lines.join("\n"));
      },
    }),
  );

  return tools;
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const t of buildTools(ctx)) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations },
      // The SDK validates input against inputSchema before calling; the handler re-parses to apply defaults identically for REST.
      ((args: Record<string, unknown>) => t.handler(args)) as never,
    );
  }
}

const KNOWN_FIELDS = new Set([
  "tid", "title", "doc", "publishdate", "docsource", "numcites", "numcitedby", "citeList", "citedbyList",
  "headline", "docsize", "divtype", "relurl", "doctype", "citetid", "query_alert", "cites", "citedby",
]);

/** Parsing a large judgment takes tens of milliseconds; keep the last few so chunked reads stay fast. */
const parsedCache = new Map<string, Block[]>();
function parsedBlocks(id: number, html: string | undefined, keepLinks: boolean): Block[] {
  const key = `${id}:${keepLinks}`;
  let blocks = parsedCache.get(key);
  if (!blocks) {
    blocks = parseDocument(html, { keepDocLinks: keepLinks });
    parsedCache.set(key, blocks);
    if (parsedCache.size > 8) parsedCache.delete(parsedCache.keys().next().value as string);
  }
  return blocks;
}

/** Shows short scalar fields the API returns beyond the known ones (e.g. caseno, courtcopy) without dumping large blobs. */
function extraScalars(d: DocResponse): string | null {
  const out: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (KNOWN_FIELDS.has(k)) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const s = typeof v === "string" ? inlineText(v) : String(v);
      if (s && s.length <= 300) out.push(`${k}: ${s}`);
    } else if (Array.isArray(v) && v.length && v.length <= 10 && v.every((x) => typeof x === "string")) {
      out.push(`${k}: ${v.map((x) => inlineText(x)).join("; ")}`);
    }
  }
  return out.length ? out.join("\n") : null;
}

function extensionFor(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t.includes("pdf")) return "pdf";
  if (t.includes("html")) return "html";
  if (t.includes("msword")) return "doc";
  if (t.includes("wordprocessingml")) return "docx";
  if (t.includes("rtf")) return "rtf";
  if (t.includes("plain")) return "txt";
  if (t.includes("png")) return "png";
  if (t.includes("jpeg")) return "jpg";
  return "bin";
}
