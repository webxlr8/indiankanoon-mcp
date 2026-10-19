import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Budget } from "../src/budget.js";
import { TieredCache } from "../src/cache.js";
import { IKClient, type FetchLike } from "../src/client.js";
import type { Config } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { registerTools, SERVER_INSTRUCTIONS } from "../src/tools.js";

interface Call {
  url: URL;
  init: RequestInit;
}

const DOC_HTML = Array.from({ length: 30 }, (_, i) => `<p data-structure="${i === 29 ? "Conclusion" : "Precedent"}" id="p_${i + 1}">${i + 1}. ${"The court held that the right is fundamental. ".repeat(20)}</p>`).join("");

function route(url: URL): { status: number; body: string; headers?: Record<string, string> } {
  const p = url.pathname;
  if (p === "/search/") {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      tid: 1000 + i,
      title: `Case <b>${i}</b> vs State`,
      headline: "the <b>right to privacy</b> is a fundamental right",
      docsource: "Supreme Court of India",
      publishdate: "2017-08-24",
      numcitedby: 50 - i,
      docsize: 120000,
    }));
    return { status: 200, body: JSON.stringify({ found: "1 - 10 of 4321", docs }) };
  }
  if (p === "/doc/91938676/") {
    return {
      status: 200,
      body: JSON.stringify({
        tid: 91938676,
        title: "Justice K.S.Puttaswamy (Retd) vs Union Of India",
        doc: DOC_HTML,
        publishdate: "2017-08-24",
        docsource: "Supreme Court of India",
        numcites: 2,
        numcitedby: 3,
        cites: [{ tid: 1, title: "A" }, { tid: 2, title: "B" }],
        citedby: [{ tid: 3, title: "C" }, { tid: 4, title: "D" }, { tid: 5, title: "E" }],
      }),
    };
  }
  if (p === "/docmeta/555/") {
    return { status: 200, body: JSON.stringify({ tid: 555, title: "Meta case", doctype: "Delhi High Court", caseno: "W.P.(C) 1/2020", relurl: "x/y", numcites: 0 }) };
  }
  if (p === "/docfragment/91938676/") {
    return {
      status: 200,
      body: JSON.stringify({
        tid: 91938676,
        title: "Puttaswamy",
        headline: ["<b>privacy</b> is intrinsic to life", "Article 21", `${"lead-in words ".repeat(80)}the <b>privacy</b> holding ${"trailing words ".repeat(80)}`],
      }),
    };
  }
  if (p === "/doc/404404/") return { status: 200, body: JSON.stringify({ errmsg: "Document not found" }) };
  if (p === "/doc/777/") return { status: 503, body: "busy" };
  if (p === "/origdoc/91938676/") {
    return { status: 200, body: JSON.stringify({ doc: Buffer.from("%PDF-1.4 test").toString("base64"), "Content-Type": "application/pdf" }) };
  }
  return { status: 404, body: "not found" };
}

describe("MCP server against mocked Indian Kanoon", () => {
  let dir: string;
  let calls: Call[];
  let client: Client;
  let ik: IKClient;
  let failuresBeforeSuccess: number;

  async function setup(overrides: Partial<Config> = {}) {
    dir = mkdtempSync(path.join(os.tmpdir(), "ikmcp-"));
    calls = [];
    const fetchImpl: FetchLike = async (u, init) => {
      const url = new URL(u);
      calls.push({ url, init });
      if (url.pathname === "/doc/888/" && failuresBeforeSuccess-- > 0) return new Response("err", { status: 502 });
      if (url.pathname === "/doc/888/") return new Response(JSON.stringify({ tid: 888, title: "Flaky", doc: "<p>ok</p>" }));
      const r = route(url);
      return new Response(r.body, { status: r.status, headers: r.headers });
    };
    const cfg = {
      apiToken: "secret-token",
      baseUrl: "https://api.indiankanoon.org",
      timeoutMs: 5000,
      maxRetries: 2,
      concurrency: 2,
      cacheDir: dir,
      cacheMaxMb: 10,
      memCacheEntries: 50,
      ttl: { search: 60, doc: 60, meta: 60, fragment: 60, origdoc: 60 },
      dailyBudgetInr: 0,
      maxPagesPerSearch: 5,
      enableOrigdoc: true,
      downloadDir: path.join(dir, "downloads"),
      logLevel: "error",
      transport: "stdio",
      httpHost: "127.0.0.1",
      httpPort: 0,
      httpAuthToken: "",
      ...overrides,
    } as Config;
    const cache = new TieredCache(dir, cfg.memCacheEntries, cfg.cacheMaxMb * 1024 * 1024, silentLogger);
    const budget = new Budget(dir, cfg.dailyBudgetInr, silentLogger);
    ik = new IKClient(cfg, cache, budget, silentLogger, fetchImpl);
    const server = new McpServer({ name: "t", version: "1" }, { instructions: SERVER_INSTRUCTIONS });
    registerTools(server, { client: ik, cfg, log: silentLogger });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
  }

  async function call(name: string, args: Record<string, unknown>) {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
  }

  beforeEach(() => {
    failuresBeforeSuccess = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists the tools", async () => {
    await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["ik_court_copy", "ik_document", "ik_fragments", "ik_metadata", "ik_search", "ik_usage"]);
  });

  it("search sends POST with token, builds formInput and formats compactly", async () => {
    await setup();
    const r = await call("ik_search", { query: "right to privacy AND Article 21", doctypes: ["supremecourt"], fromdate: "2017" });
    expect(r.isError).toBe(false);
    const c = calls[0]!;
    expect(c.init.method).toBe("POST");
    expect((c.init.headers as Record<string, string>).Authorization).toBe("Token secret-token");
    expect(c.url.searchParams.get("formInput")).toBe("right to privacy ANDD Article 21 doctypes: supremecourt fromdate: 01-01-2017");
    expect(c.url.searchParams.get("pagenum")).toBe("0");
    expect(r.text).toContain("1. [1000] Case 0 vs State — Supreme Court of India · 2017-08-24");
    expect(r.text).toContain("cost: Rs 0.50");
    expect(r.text).toContain("more: page=1");
    expect(r.text).not.toContain("<b>");
  });

  it("serves repeat calls from cache at zero cost", async () => {
    await setup();
    await call("ik_search", { query: "privacy" });
    const r = await call("ik_search", { query: "privacy" });
    expect(calls).toHaveLength(1);
    expect(r.text).toContain("cost: Rs 0 (cached)");
  });

  it("document is chunked; later chunks and metadata reuse the cached document", async () => {
    await setup();
    const first = await call("ik_document", { docid: 91938676, max_chars: 5000 });
    expect(first.text).toContain("[91938676] Justice K.S.Puttaswamy (Retd) vs Union Of India");
    expect(first.text).toContain("https://indiankanoon.org/doc/91938676/");
    expect(first.text).toContain("Cites:\n- [1] A");
    const next = Number(first.text.match(/next_offset: (\d+)/)![1]);
    const second = await call("ik_document", { docid: 91938676, offset: next, max_chars: 5000 });
    expect(second.text).toContain("cost: Rs 0 (cached)");
    expect(second.text).not.toContain("Cites:");
    const meta = await call("ik_metadata", { docid: 91938676 });
    expect(meta.text).toContain("Cited by:\n- [3] C");
    expect(calls.map((c) => c.url.pathname)).toEqual(["/doc/91938676/"]);
    expect(calls[0]!.url.searchParams.get("maxcites")).toBe("50");
  });

  it("document sections filter returns only tagged paragraphs from cache", async () => {
    await setup();
    const full = await call("ik_document", { docid: 91938676, max_chars: 2000 });
    expect(full.text).toContain("sections (paragraphs): precedents 29 · conclusion 1");
    const r = await call("ik_document", { docid: 91938676, sections: ["conclusion"] });
    expect(r.text).toContain("[conclusion]\n\n30. The court held");
    expect(r.text).not.toContain("29. The court");
    expect(r.text).toContain("cost: Rs 0 (cached)");
    expect(calls).toHaveLength(1);
  });

  it("metadata shows extra scalar fields", async () => {
    await setup();
    const r = await call("ik_metadata", { docid: 555 });
    expect(r.text).toContain("Delhi High Court");
    expect(r.text).toContain("caseno: W.P.(C) 1/2020");
    expect(r.text).not.toContain("relurl");
    expect(r.text).toContain("cost: Rs 0.02");
  });

  it("fragments returns plain passages", async () => {
    await setup();
    const r = await call("ik_fragments", { docid: 91938676, query: "privacy" });
    expect(r.text).toContain("1. privacy is intrinsic to life");
    expect(r.text).toContain("cost: Rs 0.05");
    const third = r.text.split("\n").find((l) => l.startsWith("3. "))!;
    expect(third.length).toBeLessThan(920);
    expect(third).toContain("the privacy holding");
    expect(third.startsWith("3. …")).toBe(true);
  });

  it("surfaces errmsg as a tool error without caching it", async () => {
    await setup();
    const r = await call("ik_document", { docid: 404404 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Document not found");
    await call("ik_document", { docid: 404404 });
    expect(calls).toHaveLength(2);
  });

  it("retries transient upstream failures", async () => {
    await setup();
    failuresBeforeSuccess = 2;
    const r = await call("ik_document", { docid: 888 });
    expect(r.isError).toBe(false);
    expect(calls).toHaveLength(3);
  }, 15000);

  it("gives up after max retries", async () => {
    await setup({ maxRetries: 1 });
    const r = await call("ik_document", { docid: 777 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 503");
    expect(calls).toHaveLength(2);
  }, 15000);

  it("enforces the daily budget before calling the API", async () => {
    await setup({ dailyBudgetInr: 0.6 });
    expect((await call("ik_search", { query: "a" })).isError).toBe(false);
    const r = await call("ik_search", { query: "b" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Daily Indian Kanoon budget reached");
    expect(calls).toHaveLength(1);
    // cached results stay available after the cap
    expect((await call("ik_search", { query: "a" })).isError).toBe(false);
    const usage = await call("ik_usage", {});
    expect(usage.text).toContain("Rs 0.50 spent");
    expect(usage.text).toContain("remaining Rs 0.10");
  });

  it("deduplicates concurrent identical requests", async () => {
    await setup();
    await Promise.all([call("ik_fragments", { docid: 91938676, query: "x" }), call("ik_fragments", { docid: 91938676, query: "x" })]);
    expect(calls).toHaveLength(1);
  });

  it("persists cache to disk across client instances", async () => {
    await setup();
    await call("ik_fragments", { docid: 91938676, query: "privacy" });
    const cache2 = new TieredCache(dir, 0, 1e7, silentLogger);
    const ik2 = new IKClient(
      { apiToken: "t", baseUrl: "https://api.indiankanoon.org", timeoutMs: 1000, maxRetries: 0, concurrency: 1, ttl: { search: 60, doc: 60, meta: 60, fragment: 60, origdoc: 60 }, maxPagesPerSearch: 5 },
      cache2,
      new Budget(null, 0, silentLogger),
      silentLogger,
      async () => {
        throw new Error("network must not be used");
      },
    );
    const r = await ik2.fragment(91938676, "privacy");
    expect(r.cached).toBe(true);
  });

  it("court copy saves the decoded file", async () => {
    await setup();
    const r = await call("ik_court_copy", { docid: 91938676 });
    const file = r.text.match(/saved: (.+)/)![1]!;
    expect(file.endsWith("91938676.pdf")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("%PDF-1.4 test");
  });

  it("rejects invalid input before spending money", async () => {
    await setup();
    const r = await call("ik_search", { query: "x", doctypes: ["moon"] });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("never leaks the API token in tool output", async () => {
    await setup();
    const texts = [
      (await call("ik_search", { query: "x" })).text,
      (await call("ik_document", { docid: 777 })).text,
      (await call("ik_usage", {})).text,
    ];
    for (const t of texts) expect(t).not.toContain("secret-token");
  }, 15000);
});
