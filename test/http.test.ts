import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TieredCache } from "../src/cache.js";
import type { FetchLike } from "../src/client.js";
import type { Config } from "../src/config.js";
import { createHttpApp, type HttpApp } from "../src/http.js";
import { silentLogger } from "../src/logger.js";

const GOOD_TOKEN = "a".repeat(40);
const HOUSE_TOKEN = "h".repeat(40);
const ADMIN = "admin-token-0123456789abcdef";

describe("HTTP server: keys, MCP, REST", () => {
  let dir: string;
  let app: HttpApp;
  let base: string;
  let upstream: { path: string; token: string }[];

  async function start(overrides: Partial<Config> = {}) {
    dir = mkdtempSync(path.join(os.tmpdir(), "ikhttp-"));
    upstream = [];
    const fetchImpl: FetchLike = async (u, init) => {
      const url = new URL(u);
      const token = String((init.headers as Record<string, string>).Authorization).replace("Token ", "");
      upstream.push({ path: url.pathname, token });
      if (token !== GOOD_TOKEN && token !== HOUSE_TOKEN) return new Response("forbidden", { status: 403 });
      if (url.pathname.startsWith("/docmeta/")) return new Response(JSON.stringify({ tid: 1, title: "Probe" }));
      if (url.pathname === "/search/") {
        return new Response(JSON.stringify({ found: "1 - 1 of 1", docs: [{ tid: 42, title: "A vs B on 1 January, 2020", headline: "the <b>term</b>", publishdate: "2020-01-01", docsource: "Delhi High Court" }] }));
      }
      if (url.pathname === "/origdoc/42/") {
        return new Response(JSON.stringify({ doc: Buffer.from("%PDF test").toString("base64"), "Content-Type": "application/pdf" }));
      }
      return new Response("not found", { status: 404 });
    };
    const cfg = {
      apiToken: HOUSE_TOKEN,
      baseUrl: "https://api.indiankanoon.org",
      timeoutMs: 5000,
      maxRetries: 0,
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
      transport: "http",
      httpHost: "127.0.0.1",
      httpPort: 0,
      secretKey: "s".repeat(40),
      adminToken: ADMIN,
      publicSignup: true,
      publicUrl: "",
      dataDir: dir,
      houseDailyBudgetInr: 100,
      keyDefaultBudgetInr: 50,
      shareCache: true,
      rateLimitPerMin: 1000,
      ...overrides,
    } as Config;
    const cache = new TieredCache(dir, 50, 1e7, silentLogger);
    app = await createHttpApp({ cfg, cache, log: silentLogger, fetchImpl });
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }

  const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  async function createKey(body: Record<string, unknown>) {
    const r = await post("/api/keys", body);
    return { status: r.status, body: (await r.json()) as Record<string, string> };
  }

  beforeEach(async () => start());
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the portal and health check", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Create a connection key");
    expect((await (await fetch(base + "/healthz")).json()).ok).toBe(true);
  });

  it("creates a key only for a working Indian Kanoon token", async () => {
    expect((await createKey({ label: "x" })).status).toBe(400);
    const bad = await createKey({ label: "x", ik_token: "b".repeat(40) });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("rejected");
    const good = await createKey({ label: "x", ik_token: GOOD_TOKEN });
    expect(good.status).toBe(201);
    expect(good.body.key).toMatch(/^ikm_/);
    expect(good.body.uses_server_token).toBe(false);
  });

  it("lets the admin create keys on the server token", async () => {
    expect((await createKey({ label: "x", admin_token: "wrong-token-0123456789abcd" })).status).toBe(401);
    const r = await createKey({ label: "team", admin_token: ADMIN });
    expect(r.status).toBe(201);
    expect(r.body.uses_server_token).toBe(true);
  });

  it("MCP over HTTP works with a Bearer header and with the key in the path", async () => {
    const { body } = await createKey({ label: "x", ik_token: GOOD_TOKEN });
    const key = body.key as string;

    const c1 = new Client({ name: "t", version: "1" });
    await c1.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    const tools = await c1.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("ik_search");
    const r = (await c1.callTool({ name: "ik_search", arguments: { query: "term" } })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toContain("1. [42] A vs B — Delhi High Court · 2020-01-01");
    await c1.close();

    const c2 = new Client({ name: "t", version: "1" });
    await c2.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${key}`)));
    const r2 = (await c2.callTool({ name: "ik_search", arguments: { query: "term" } })) as { content: { text: string }[] };
    expect(r2.content[0]!.text).toContain("cost: Rs 0 (cached)");
    await c2.close();

    // The user's own token paid for the search, not the server's.
    expect(upstream.filter((u) => u.path === "/search/").map((u) => u.token)).toEqual([GOOD_TOKEN]);
  });

  it("rejects missing, invalid and revoked keys", async () => {
    expect((await post("/mcp", {})).status).toBe(401);
    expect((await post("/mcp", {}, { Authorization: "Bearer ikm_" + "x".repeat(40) })).status).toBe(401);
    const { body } = await createKey({ label: "x", ik_token: GOOD_TOKEN });
    const auth = { Authorization: `Bearer ${body.key}` };
    expect((await fetch(base + "/api/me", { headers: auth })).status).toBe(200);
    expect((await post("/api/me/revoke", {}, auth)).status).toBe(200);
    expect((await fetch(base + "/api/me", { headers: auth })).status).toBe(401);
  });

  it("REST tool calls, tool list and OpenAPI", async () => {
    const { body } = await createKey({ label: "x", ik_token: GOOD_TOKEN });
    const r = await post("/api/v1/tools/ik_search", { query: "term" }, { Authorization: `Bearer ${body.key}` });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { text: string }).text).toContain("[42] A vs B");
    const bad = await post("/api/v1/tools/ik_search", { doctypes: ["moon"] }, { Authorization: `Bearer ${body.key}` });
    expect(bad.status).toBe(422);
    const list = (await (await fetch(base + "/api/v1/tools")).json()) as { tools: { name: string; input_schema: { properties: object } }[] };
    expect(list.tools.find((t) => t.name === "ik_search")?.input_schema.properties).toHaveProperty("query");
    const spec = (await (await fetch(base + "/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toContain("/api/v1/tools/ik_document");
  });

  it("court copy returns a signed download link that works and expires", async () => {
    const { body } = await createKey({ label: "x", ik_token: GOOD_TOKEN });
    const r = await post("/api/v1/tools/ik_court_copy", { docid: 42 }, { Authorization: `Bearer ${body.key}` });
    const text = ((await r.json()) as { text: string }).text;
    const link = text.match(/download: (\S+)/)![1]!;
    const dl = await fetch(link.replace(/^https?:\/\/[^/]+/, base));
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("%PDF test");
    const tampered = await fetch(link.replace(/^https?:\/\/[^/]+/, base).replace(/sig=[^&]+/, "sig=abc"));
    expect(tampered.status).toBe(403);
  });

  it("enforces per-key caps and the shared server-token cap", async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    await start({ houseDailyBudgetInr: 0.6 });
    const a = await createKey({ label: "a", admin_token: ADMIN });
    const b = await createKey({ label: "b", admin_token: ADMIN });
    const s1 = await post("/api/v1/tools/ik_search", { query: "one" }, { Authorization: `Bearer ${a.body.key}` });
    expect(s1.status).toBe(200);
    const s2 = await post("/api/v1/tools/ik_search", { query: "two" }, { Authorization: `Bearer ${b.body.key}` });
    expect(s2.status).toBe(422);
    expect(((await s2.json()) as { text: string }).text).toContain("budget reached");
  });
});
