import { Budget, PRICE_INR, type Endpoint } from "./budget.js";
import { TieredCache } from "./cache.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

export class IKApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "IKApiError";
  }
}

export interface SearchDoc {
  tid: number;
  title?: string;
  headline?: string;
  docsource?: string;
  docsize?: number;
  publishdate?: string;
  numcites?: number;
  numcitedby?: number;
  author?: string;
  citation?: string;
  [k: string]: unknown;
}

export interface SearchResponse {
  found?: string | number;
  docs?: SearchDoc[];
  categories?: unknown;
  encodedformInput?: string;
  [k: string]: unknown;
}

export interface CiteRef {
  tid: number;
  title?: string;
  [k: string]: unknown;
}

export interface DocResponse {
  tid?: number;
  title?: string;
  doc?: string;
  publishdate?: string;
  docsource?: string;
  numcites?: number;
  numcitedby?: number;
  citeList?: CiteRef[];
  citedbyList?: CiteRef[];
  [k: string]: unknown;
}

export interface FragmentResponse {
  tid?: number;
  title?: string;
  formInput?: string;
  headline?: string[] | string;
  [k: string]: unknown;
}

export interface OrigDocResponse {
  doc?: string; // base64
  "Content-Type"?: string;
  [k: string]: unknown;
}

export interface CallResult<T> {
  data: T;
  cached: boolean;
  costInr: number;
}

/** Citation lists are capped at 50 by the API. Always ask for the maximum: same price, and one cache entry serves every later request. */
const MAX_CITES = 50;

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class IKClient {
  private readonly sem: Semaphore;
  private readonly inflight = new Map<string, Promise<CallResult<unknown>>>();
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly cfg: Pick<Config, "apiToken" | "baseUrl" | "timeoutMs" | "maxRetries" | "concurrency" | "ttl" | "maxPagesPerSearch"> & {
      /** Prefix for cache keys; set per key when cached documents must not be shared between keys. */
      cacheNamespace?: string;
    },
    readonly cache: TieredCache,
    readonly budget: Budget,
    private readonly log: Logger,
    fetchImpl?: FetchLike,
  ) {
    this.sem = new Semaphore(cfg.concurrency);
    this.fetchImpl = fetchImpl ?? ((u, i) => fetch(u, i));
  }

  search(formInput: string, pagenum = 0, maxpages = 1, withCites = false) {
    const pages = Math.max(1, Math.min(Math.floor(maxpages), this.cfg.maxPagesPerSearch));
    const params: Record<string, string> = {
      formInput,
      pagenum: String(Math.max(0, Math.floor(pagenum))),
      maxpages: String(pages),
    };
    if (withCites) params.maxcites = String(MAX_CITES);
    return this.call<SearchResponse>("search", "/search/", params, this.cfg.ttl.search, pages, (d) =>
      Math.max(1, Math.min(pages, Math.ceil((d.docs?.length ?? 0) / 10))),
    );
  }

  doc(docid: number) {
    return this.call<DocResponse>("doc", `/doc/${docid}/`, {
      maxcites: String(MAX_CITES),
      maxcitedby: String(MAX_CITES),
    }, this.cfg.ttl.doc);
  }

  meta(docid: number) {
    return this.call<DocResponse>("meta", `/docmeta/${docid}/`, {
      maxcites: String(MAX_CITES),
      maxcitedby: String(MAX_CITES),
    }, this.cfg.ttl.meta);
  }

  fragment(docid: number, formInput: string) {
    return this.call<FragmentResponse>("fragment", `/docfragment/${docid}/`, { formInput }, this.cfg.ttl.fragment);
  }

  origdoc(docid: number) {
    return this.call<OrigDocResponse>("origdoc", `/origdoc/${docid}/`, {}, this.cfg.ttl.origdoc);
  }

  /** Cached document lookup without spending money; used to reuse a fetched judgment for metadata. */
  async peekDoc(docid: number): Promise<DocResponse | undefined> {
    const url = this.buildUrl(`/doc/${docid}/`, { maxcites: String(MAX_CITES), maxcitedby: String(MAX_CITES) });
    return this.cache.get<DocResponse>(TieredCache.keyFor(`${this.cfg.cacheNamespace ?? ""}doc ${url}`));
  }

  private buildUrl(pathname: string, params: Record<string, string>): string {
    const qs = new URLSearchParams(params).toString();
    return `${this.cfg.baseUrl}${pathname}${qs ? `?${qs}` : ""}`;
  }

  private async call<T>(
    endpoint: Endpoint,
    pathname: string,
    params: Record<string, string>,
    ttl: number,
    units = 1,
    actualUnits?: (data: T) => number,
  ): Promise<CallResult<T>> {
    const url = this.buildUrl(pathname, params);
    const key = TieredCache.keyFor(`${this.cfg.cacheNamespace ?? ""}${endpoint} ${url}`);
    const unitPrice = PRICE_INR[endpoint];

    const cached = await this.cache.get<T>(key);
    if (cached !== undefined) {
      const saved = unitPrice * (actualUnits ? actualUnits(cached) : 1);
      this.budget.recordSaving(saved);
      this.log.debug("cache hit", { endpoint, pathname });
      return { data: cached, cached: true, costInr: 0 };
    }

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<CallResult<T>>;

    const p = (async (): Promise<CallResult<T>> => {
      const reserved = unitPrice * units;
      this.budget.reserve(reserved);
      let settled = false;
      try {
        const data = await this.sem.run(() => this.fetchWithRetry<T>(endpoint, url));
        const cost = unitPrice * (actualUnits ? actualUnits(data) : 1);
        this.budget.settle(endpoint, reserved, cost);
        settled = true;
        await this.cache.set(key, data, ttl);
        return { data, cached: false, costInr: cost };
      } finally {
        if (!settled) this.budget.release(reserved);
      }
    })();

    this.inflight.set(key, p as Promise<CallResult<unknown>>);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async fetchWithRetry<T>(endpoint: Endpoint, url: string): Promise<T> {
    let attempt = 0;
    for (;;) {
      const started = Date.now();
      try {
        const data = await this.fetchOnce<T>(url);
        this.log.info("ik request", { endpoint, ms: Date.now() - started, attempt });
        return data;
      } catch (err) {
        const e = err instanceof IKApiError ? err : new IKApiError(describeNetworkError(err), undefined, true);
        const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
        if (!e.retryable || attempt >= this.cfg.maxRetries) {
          this.log.warn("ik request failed", { endpoint, status: e.status, attempt, err: e.message });
          throw e;
        }
        const backoff = retryAfterMs ?? Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
        this.log.warn("ik request retry", { endpoint, status: e.status, attempt, waitMs: Math.round(backoff) });
        attempt++;
        await sleep(backoff);
      }
    }
  }

  private async fetchOnce<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.cfg.apiToken}`,
        Accept: "application/json",
        "User-Agent": "indiankanoon-mcp/1.0",
      },
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      throw new IKApiError(
        `Indian Kanoon rejected the API token (HTTP ${res.status}). Check IK_API_TOKEN and account credit.`,
        res.status,
      );
    }
    if (res.status === 429 || res.status >= 500) {
      const err = new IKApiError(`Indian Kanoon HTTP ${res.status}: ${snippet(text)}`, res.status, true);
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) Object.assign(err, { retryAfterMs: Math.min(ra, 30) * 1000 });
      throw err;
    }
    if (res.status === 404) throw new IKApiError("Document not found on Indian Kanoon (HTTP 404).", 404);
    if (!res.ok) throw new IKApiError(`Indian Kanoon HTTP ${res.status}: ${snippet(text)}`, res.status);

    // Cloudflare-style plain-text failures arrive with HTTP 200 in some cases.
    if (/^\s*error code:/i.test(text)) throw new IKApiError(`Indian Kanoon upstream error: ${snippet(text)}`, res.status, true);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new IKApiError(`Indian Kanoon returned non-JSON response: ${snippet(text)}`, res.status, true);
    }
    if (body && typeof body === "object" && "errmsg" in body) {
      const msg = String((body as { errmsg: unknown }).errmsg);
      throw new IKApiError(`Indian Kanoon error: ${msg}`, res.status, false);
    }
    return body as T;
  }
}

function snippet(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "Request to Indian Kanoon timed out.";
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return `Network error contacting Indian Kanoon${cause ? ` (${cause})` : ""}: ${err.message}`;
  }
  return `Network error contacting Indian Kanoon: ${String(err)}`;
}
