import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  apiToken: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  concurrency: number;
  cacheDir: string;
  cacheMaxMb: number;
  memCacheEntries: number;
  ttl: {
    search: number;
    doc: number;
    meta: number;
    fragment: number;
    origdoc: number;
  };
  dailyBudgetInr: number; // 0 = unlimited
  maxPagesPerSearch: number;
  enableOrigdoc: boolean;
  downloadDir: string;
  logLevel: LogLevel;
  transport: "stdio" | "http";
  httpHost: string;
  httpPort: number;
  /** Encrypts stored Indian Kanoon tokens and signs download links (HTTP mode). */
  secretKey: string;
  /** Lets the owner create keys that use the server's own Indian Kanoon token. */
  adminToken: string;
  /** Anyone may create a key with their own Indian Kanoon token. */
  publicSignup: boolean;
  publicUrl: string;
  dataDir: string;
  /** Combined daily cap for every key that uses the server's own token. */
  houseDailyBudgetInr: number;
  /** Default daily cap for new keys. */
  keyDefaultBudgetInr: number;
  /** Serve cached documents to every key, whichever token fetched them. */
  shareCache: boolean;
  /** Requests per minute per key. */
  rateLimitPerMin: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const HOUR = 3600;
const DAY = 24 * HOUR;

function num(name: string, def: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`Invalid ${name}=${raw}: expected a number >= ${min}`);
  }
  return n;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return def;
  return ["1", "true", "yes", "on"].includes(raw);
}

function str(name: string, def: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? def : raw.trim();
}

export function loadConfig(): Config {
  const transport = str("MCP_TRANSPORT", "stdio");
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Invalid MCP_TRANSPORT=${transport}: expected stdio or http`);
  }

  const apiToken = str("IK_API_TOKEN", "");
  if (!apiToken && transport === "stdio") {
    throw new Error(
      "IK_API_TOKEN is not set. Generate a token at https://api.indiankanoon.org/ and set IK_API_TOKEN.",
    );
  }

  const cacheDir = path.resolve(
    str("IK_CACHE_DIR", path.join(os.homedir(), ".cache", "indiankanoon-mcp")),
  );

  const logLevel = str("LOG_LEVEL", "info") as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL=${logLevel}`);
  }

  const httpHost = str("MCP_HTTP_HOST", "127.0.0.1");
  const dataDir = path.resolve(str("DATA_DIR", cacheDir));
  let secretKey = str("SECRET_KEY", "");
  if (transport === "http") {
    if (!secretKey) secretKey = loadOrCreateSecret(dataDir);
    if (secretKey.length < 32) throw new Error("SECRET_KEY must be at least 32 random characters (e.g. `openssl rand -hex 32`).");
  }
  const adminToken = str("ADMIN_TOKEN", "");
  if (adminToken && adminToken.length < 24) throw new Error("ADMIN_TOKEN must be at least 24 characters.");

  return {
    apiToken,
    baseUrl: str("IK_BASE_URL", "https://api.indiankanoon.org").replace(/\/+$/, ""),
    timeoutMs: num("IK_TIMEOUT_MS", 30_000, 1000),
    maxRetries: num("IK_MAX_RETRIES", 3, 0),
    concurrency: num("IK_CONCURRENCY", 4, 1),
    cacheDir,
    cacheMaxMb: num("IK_CACHE_MAX_MB", 500, 0),
    memCacheEntries: num("IK_MEM_CACHE_ENTRIES", 200, 0),
    ttl: {
      search: num("IK_TTL_SEARCH_S", DAY),
      doc: num("IK_TTL_DOC_S", 30 * DAY),
      meta: num("IK_TTL_META_S", 7 * DAY),
      fragment: num("IK_TTL_FRAGMENT_S", 30 * DAY),
      origdoc: num("IK_TTL_ORIGDOC_S", 90 * DAY),
    },
    dailyBudgetInr: num("IK_DAILY_BUDGET_INR", 0),
    maxPagesPerSearch: Math.min(num("IK_MAX_PAGES_PER_SEARCH", 5, 1), 100),
    enableOrigdoc: bool("IK_ENABLE_ORIGDOC", true),
    downloadDir: path.resolve(str("IK_DOWNLOAD_DIR", path.join(cacheDir, "downloads"))),
    logLevel,
    transport,
    httpHost,
    httpPort: num("PORT", 3000, 1),
    secretKey,
    adminToken,
    publicSignup: bool("PUBLIC_SIGNUP", true),
    publicUrl: str("PUBLIC_URL", "").replace(/\/+$/, ""),
    dataDir,
    houseDailyBudgetInr: num("HOUSE_DAILY_BUDGET_INR", 200),
    keyDefaultBudgetInr: num("KEY_DEFAULT_BUDGET_INR", 50),
    shareCache: bool("IK_SHARE_CACHE", true),
    rateLimitPerMin: num("RATE_LIMIT_PER_MIN", 120, 1),
  };
}

/**
 * Without SECRET_KEY the server creates one in the data directory on first
 * start and reuses it afterwards. Losing this file makes stored Indian Kanoon
 * tokens unreadable, so the data directory must be on persistent storage.
 */
function loadOrCreateSecret(dataDir: string): string {
  const file = path.join(dataDir, "secret.key");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    mkdirSync(dataDir, { recursive: true });
    const secret = randomBytes(32).toString("hex");
    writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: "wx" });
    return secret;
  }
}
