import { timingSafeEqual } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { TieredCache } from "./cache.js";
import type { FetchLike, IKClient } from "./client.js";
import type { Config } from "./config.js";
import { KeyStore, looksLikeKey, signDownload, verifyDownload, type KeyRecord } from "./keys.js";
import type { Logger } from "./logger.js";
import { portalHtml } from "./portal.js";
import { Tenants } from "./tenants.js";
import { buildTools, registerTools, SERVER_INSTRUCTIONS, type ToolContext } from "./tools.js";
import { VERSION } from "./version.js";

export { VERSION };
const MAX_BODY_BYTES = 1_000_000;
const DOWNLOAD_TTL_MS = 24 * 3600 * 1000;
/** Puttaswamy (2017): a stable document used to check that a submitted Indian Kanoon token works (one Rs 0.02 metadata call). */
const TOKEN_PROBE_DOCID = 91938676;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Fixed-window counter per caller. */
class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  allow(id: string): boolean {
    const now = Date.now();
    const h = this.hits.get(id);
    if (!h || now - h.start >= this.windowMs) {
      this.hits.set(id, { start: now, n: 1 });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    return ++h.n <= this.limit;
  }
  private prune(now: number) {
    for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const CreateKeyBody = z.object({
  label: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200).optional(),
  ik_token: z.string().trim().regex(/^[A-Za-z0-9]{20,100}$/, "Indian Kanoon token should be 20-100 letters and digits").optional(),
  daily_budget_inr: z.number().min(1).max(10_000).optional(),
  admin_token: z.string().optional(),
});

const AdminPatchBody = z.object({
  disabled: z.boolean().optional(),
  daily_budget_inr: z.number().min(0).max(100_000).optional(),
  label: z.string().trim().min(1).max(80).optional(),
});

function publicKeyView(r: KeyRecord) {
  return {
    id: r.id,
    prefix: r.prefix,
    label: r.label,
    email: r.email,
    created_at: r.createdAt,
    last_used_at: r.lastUsedAt,
    disabled: r.disabled,
    daily_budget_inr: r.dailyBudgetInr,
    uses_server_token: r.usesHouseToken,
  };
}

export interface HttpDeps {
  cfg: Config;
  cache: TieredCache;
  log: Logger;
  fetchImpl?: FetchLike;
}

export interface HttpApp {
  server: Server;
  keys: KeyStore;
  tenants: Tenants;
  close(): Promise<void>;
}

export async function createHttpApp({ cfg, cache, log, fetchImpl }: HttpDeps): Promise<HttpApp> {
  const keys = new KeyStore(cfg.dataDir, cfg.secretKey);
  const tenants = new Tenants(cfg, cache, log, fetchImpl);
  await tenants.init();
  const perKey = new RateLimiter(cfg.rateLimitPerMin, 60_000);
  const signups = new RateLimiter(10, 3600_000);
  const doFetch: FetchLike = fetchImpl ?? ((u, i) => fetch(u, i));
  const portal = portalHtml({ publicSignup: cfg.publicSignup, adminEnabled: Boolean(cfg.adminToken), version: VERSION });
  // `npm pack` output baked into the Docker image, so anyone can install the local (stdio) server with npx.
  const packageDir = process.env.PACKAGE_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

  const baseUrl = (req: IncomingMessage): string => {
    if (cfg.publicUrl) return cfg.publicUrl;
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
    const host = (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host || `localhost:${cfg.httpPort}`;
    return `${proto}://${host}`;
  };

  const toolContext = (client: IKClient, req: IncomingMessage): ToolContext => ({
    client,
    cfg,
    log,
    courtCopyLink: (name) => {
      const exp = Date.now() + DOWNLOAD_TTL_MS;
      return `${baseUrl(req)}/download/${encodeURIComponent(name)}?exp=${exp}&sig=${signDownload(cfg.secretKey, name, exp)}`;
    },
  });

  /** Resolves the caller's key from the Authorization header or a /mcp/<key> path segment. */
  const authenticate = async (req: IncomingMessage, pathKey?: string) => {
    const key = pathKey ?? bearer(req);
    if (!key) throw new HttpError(401, "Missing connection key. Send Authorization: Bearer <key> or use /mcp/<key>.");
    const found = looksLikeKey(key) ? keys.authenticate(key) : null;
    if (!found) throw new HttpError(401, "Invalid or revoked connection key.");
    if (!perKey.allow(found.record.id)) throw new HttpError(429, "Too many requests for this key. Slow down and retry in a minute.");
    const client = await tenants.clientFor(found.record, found.ikToken);
    return { record: found.record, client };
  };

  const requireAdmin = (req: IncomingMessage) => {
    const t = bearer(req);
    if (!cfg.adminToken || !t || !safeEqual(t, cfg.adminToken)) throw new HttpError(401, "Admin token required.");
  };

  async function probeIkToken(token: string): Promise<void> {
    let res: Response;
    try {
      res = await doFetch(`${cfg.baseUrl}/docmeta/${TOKEN_PROBE_DOCID}/`, {
        method: "POST",
        headers: { Authorization: `Token ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch {
      throw new HttpError(502, "Could not reach Indian Kanoon to check the token. Try again shortly.");
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new HttpError(400, "Indian Kanoon rejected this API token.");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(502, "Indian Kanoon returned an unexpected response while checking the token.");
    }
    if (!res.ok || (body && typeof body === "object" && "errmsg" in body)) {
      const msg = body && typeof body === "object" && "errmsg" in body ? String((body as { errmsg: unknown }).errmsg) : `HTTP ${res.status}`;
      throw new HttpError(400, `Indian Kanoon token check failed: ${msg}`);
    }
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, pathKey?: string) {
    if (req.method !== "POST") {
      // Stateless server: no SSE stream to resume and no session to delete.
      return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, { Allow: "POST" });
    }
    const { client } = await authenticate(req, pathKey);
    const body = await readJson(req);
    const server = new McpServer({ name: "indiankanoon", version: VERSION }, { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } });
    registerTools(server, toolContext(client, req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  function openApi(req: IncomingMessage) {
    const tools = buildTools({ client: null as never, cfg, log, courtCopyLink: () => "" });
    const paths: Record<string, unknown> = {};
    for (const t of tools) {
      paths[`/api/v1/tools/${t.name}`] = {
        post: {
          operationId: t.name,
          summary: t.title,
          description: t.description,
          requestBody: { required: false, content: { "application/json": { schema: z.toJSONSchema(z.object(t.inputSchema), { io: "input" }) } } },
          responses: {
            "200": {
              description: "Tool output as compact text",
              content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" }, isError: { type: "boolean" } }, required: ["text", "isError"] } } },
            },
          },
        },
      };
    }
    return {
      openapi: "3.1.0",
      info: { title: "Indian Kanoon MCP REST API", version: VERSION, description: SERVER_INSTRUCTIONS },
      servers: [{ url: baseUrl(req) }],
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
      paths,
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname.replace(/\/+$/, "") || "/";

    if (p.startsWith("/mcp") || p.startsWith("/api") || p === "/openapi.json") setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (p === "/healthz") return send(res, 200, { ok: true, version: VERSION });

    if (p === "/" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(portal);
      return;
    }

    if (p === "/mcp") return handleMcp(req, res);
    const mcpKey = p.match(/^\/mcp\/([A-Za-z0-9_-]+)$/);
    if (mcpKey) return handleMcp(req, res, mcpKey[1]);

    if (p === "/openapi.json" && req.method === "GET") return send(res, 200, openApi(req));

    if (p === "/api/keys" && req.method === "POST") {
      const body = CreateKeyBody.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, body.error.issues.map((i) => i.message).join("; "));
      const b = body.data;
      const isAdmin = Boolean(b.admin_token && cfg.adminToken && safeEqual(b.admin_token, cfg.adminToken));
      if (b.admin_token && !isAdmin) throw new HttpError(401, "Wrong admin token.");
      if (!isAdmin && !signups.allow(clientIp(req))) throw new HttpError(429, "Too many keys created from this address. Try again later.");
      if (!b.ik_token) {
        if (!isAdmin) throw new HttpError(400, "An Indian Kanoon API token is required.");
        if (!cfg.apiToken) throw new HttpError(400, "The server has no Indian Kanoon token of its own; supply one.");
      } else if (!isAdmin && !cfg.publicSignup) {
        throw new HttpError(403, "Key creation is closed on this server.");
      }
      if (b.ik_token) await probeIkToken(b.ik_token);
      const { key, record } = keys.create({
        label: b.label,
        email: b.email,
        dailyBudgetInr: b.daily_budget_inr ?? cfg.keyDefaultBudgetInr,
        ikToken: b.ik_token ?? null,
      });
      log.info("key created", { id: record.id, house: record.usesHouseToken, admin: isAdmin });
      return send(res, 201, { key, ...publicKeyView(record), mcp_url: `${baseUrl(req)}/mcp`, connector_url: `${baseUrl(req)}/mcp/${key}` });
    }

    if (p === "/api/me" && req.method === "GET") {
      const { record, client } = await authenticate(req);
      return send(res, 200, { ...publicKeyView(record), usage: client.budget.snapshot() });
    }
    if (p === "/api/me/revoke" && req.method === "POST") {
      const { record } = await authenticate(req);
      keys.update(record.id, { disabled: true });
      tenants.forget(record.id);
      log.info("key revoked by owner", { id: record.id });
      return send(res, 200, { revoked: true, id: record.id });
    }

    if (p === "/api/admin/keys" && req.method === "GET") {
      requireAdmin(req);
      return send(res, 200, { keys: keys.list().map(publicKeyView), house_usage: tenants.house.snapshot() });
    }
    const adminKey = p.match(/^\/api\/admin\/keys\/([a-f0-9]{12})$/);
    if (adminKey && req.method === "PATCH") {
      requireAdmin(req);
      const body = AdminPatchBody.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, body.error.issues.map((i) => i.message).join("; "));
      const updated = keys.update(adminKey[1] as string, {
        disabled: body.data.disabled,
        dailyBudgetInr: body.data.daily_budget_inr,
        label: body.data.label,
      });
      if (!updated) throw new HttpError(404, "No such key.");
      tenants.forget(updated.id);
      return send(res, 200, publicKeyView(updated));
    }

    if (p === "/api/v1/tools" && req.method === "GET") {
      const tools = buildTools({ client: null as never, cfg, log, courtCopyLink: () => "" });
      return send(res, 200, {
        tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, input_schema: z.toJSONSchema(z.object(t.inputSchema), { io: "input" }) })),
      });
    }
    const toolCall = p.match(/^\/api\/v1\/tools\/([a-z_]+)$/);
    if (toolCall && req.method === "POST") {
      const { client } = await authenticate(req);
      const tool = buildTools(toolContext(client, req)).find((t) => t.name === toolCall[1]);
      if (!tool) throw new HttpError(404, `Unknown tool ${toolCall[1]}.`);
      const args = (await readJson(req)) ?? {};
      if (typeof args !== "object" || Array.isArray(args)) throw new HttpError(400, "Body must be a JSON object of tool arguments.");
      const out = await tool.handler(args as Record<string, unknown>);
      return send(res, out.isError ? 422 : 200, { text: out.content.map((c) => c.text).join("\n"), isError: Boolean(out.isError) });
    }

    const pkg = p.match(/^\/local\/indiankanoon-mcp(?:-(\d+\.\d+\.\d+))?\.tgz$/);
    if (pkg && (req.method === "GET" || req.method === "HEAD")) {
      if (pkg[1] && pkg[1] !== VERSION) throw new HttpError(404, `Version ${pkg[1]} is not available; current is ${VERSION}.`);
      const file = path.join(packageDir, `indiankanoon-mcp-${VERSION}.tgz`);
      const st = await fs.stat(file).catch(() => null);
      if (!st) throw new HttpError(404, "Local package is not available on this server.");
      res.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": String(st.size),
        "cache-control": pkg[1] ? "public, max-age=31536000, immutable" : "no-cache",
        "content-disposition": `attachment; filename="indiankanoon-mcp-${VERSION}.tgz"`,
      });
      if (req.method === "HEAD") return void res.end();
      createReadStream(file).pipe(res);
      return;
    }

    const dl = p.match(/^\/download\/(\d+\.[a-z]{2,4})$/);
    if (dl && req.method === "GET") {
      const name = dl[1] as string;
      if (!verifyDownload(cfg.secretKey, name, Number(url.searchParams.get("exp")), url.searchParams.get("sig") ?? "")) {
        throw new HttpError(403, "Download link is invalid or expired.");
      }
      const file = path.join(cfg.downloadDir, name);
      const st = await fs.stat(file).catch(() => null);
      if (!st) throw new HttpError(404, "File no longer available. Request the court copy again.");
      const type = name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
      res.writeHead(200, { "content-type": type, "content-length": String(st.size), "content-disposition": `attachment; filename="${name}"` });
      createReadStream(file).pipe(res);
      return;
    }

    throw new HttpError(404, "Not found.");
  }

  const server = createServer((req, res) => {
    const started = Date.now();
    res.on("finish", () => {
      const p = (req.url ?? "").split("?")[0]?.replace(/\/mcp\/ikm_[^/]+/, "/mcp/<key>");
      log.info("http", { method: req.method, path: p, status: res.statusCode, ms: Date.now() - started });
    });
    route(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) {
        const headers: Record<string, string> = e.status === 401 ? { "WWW-Authenticate": 'Bearer realm="indiankanoon"' } : {};
        return send(res, e.status, { error: e.message }, headers);
      }
      log.error("http request failed", { err: e instanceof Error ? e.stack : String(e) });
      send(res, 500, { error: "Internal server error." });
    });
  });
  server.requestTimeout = cfg.timeoutMs * (cfg.maxRetries + 2);
  server.headersTimeout = 30_000;

  return {
    server,
    keys,
    tenants,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          keys.close();
          resolve();
        });
      }),
  };
}
