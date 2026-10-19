import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A connection key issued by this server. The plain key is shown once and only its hash is stored. */
export interface KeyRecord {
  id: string;
  prefix: string;
  label: string;
  email: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  disabled: boolean;
  dailyBudgetInr: number;
  /** true: calls are paid with the server's own Indian Kanoon token. */
  usesHouseToken: boolean;
}

interface Row {
  id: string;
  prefix: string;
  label: string;
  email: string | null;
  created_at: string;
  last_used_at: string | null;
  disabled: number;
  daily_budget_inr: number;
  uses_house_token: number;
  ik_token_enc: string | null;
}

const KEY_PREFIX = "ikm_";

function toRecord(r: Row): KeyRecord {
  return {
    id: r.id,
    prefix: r.prefix,
    label: r.label,
    email: r.email,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    disabled: r.disabled === 1,
    dailyBudgetInr: r.daily_budget_inr,
    usesHouseToken: r.uses_house_token === 1,
  };
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function looksLikeKey(s: string | undefined | null): s is string {
  return typeof s === "string" && /^ikm_[A-Za-z0-9_-]{32,64}$/.test(s);
}

/** AES-256-GCM with a key derived from SECRET_KEY. Stored as base64(iv | tag | ciphertext). */
class Sealer {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHash("sha256").update(`indiankanoon-mcp:tokens:${secret}`).digest();
  }
  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  }
  open(sealed: string): string {
    const buf = Buffer.from(sealed, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  }
}

export class KeyStore {
  private readonly db: DatabaseSync;
  private readonly sealer: Sealer;
  private readonly touchAt = new Map<string, number>();

  constructor(dataDir: string, secret: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "keys.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        label TEXT NOT NULL,
        email TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        disabled INTEGER NOT NULL DEFAULT 0,
        daily_budget_inr REAL NOT NULL,
        uses_house_token INTEGER NOT NULL DEFAULT 0,
        ik_token_enc TEXT
      );
    `);
    this.sealer = new Sealer(secret);
  }

  create(opts: { label: string; email?: string | null; dailyBudgetInr: number; ikToken?: string | null }): { key: string; record: KeyRecord } {
    const key = `${KEY_PREFIX}${randomBytes(30).toString("base64url")}`;
    const id = randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    const usesHouse = !opts.ikToken;
    this.db
      .prepare(
        `INSERT INTO api_keys (id, key_hash, prefix, label, email, created_at, daily_budget_inr, uses_house_token, ik_token_enc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        hashKey(key),
        key.slice(0, 10),
        opts.label,
        opts.email ?? null,
        now,
        opts.dailyBudgetInr,
        usesHouse ? 1 : 0,
        opts.ikToken ? this.sealer.seal(opts.ikToken) : null,
      );
    return { key, record: this.get(id) as KeyRecord };
  }

  /** Resolves a presented key. Returns the record and the Indian Kanoon token to use (null = server token). */
  authenticate(key: string): { record: KeyRecord; ikToken: string | null } | null {
    if (!looksLikeKey(key)) return null;
    const row = this.db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(hashKey(key)) as Row | undefined;
    // Lookup by SHA-256 of a 240-bit random key: timing reveals nothing usable.
    if (!row || row.disabled === 1) return null;
    this.touch(row.id);
    return { record: toRecord(row), ikToken: row.ik_token_enc ? this.sealer.open(row.ik_token_enc) : null };
  }

  private touch(id: string): void {
    const now = Date.now();
    if ((this.touchAt.get(id) ?? 0) > now - 60_000) return;
    this.touchAt.set(id, now);
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date(now).toISOString(), id);
  }

  get(id: string): KeyRecord | null {
    const row = this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  list(): KeyRecord[] {
    return (this.db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all() as unknown as Row[]).map(toRecord);
  }

  update(id: string, patch: { disabled?: boolean; dailyBudgetInr?: number; label?: string }): KeyRecord | null {
    if (patch.disabled !== undefined) this.db.prepare("UPDATE api_keys SET disabled = ? WHERE id = ?").run(patch.disabled ? 1 : 0, id);
    if (patch.dailyBudgetInr !== undefined) this.db.prepare("UPDATE api_keys SET daily_budget_inr = ? WHERE id = ?").run(patch.dailyBudgetInr, id);
    if (patch.label !== undefined) this.db.prepare("UPDATE api_keys SET label = ? WHERE id = ?").run(patch.label, id);
    return this.get(id);
  }

  close(): void {
    this.db.close();
  }
}

/** Signed, expiring download links for court copies. */
export function signDownload(secret: string, name: string, expiresAt: number): string {
  return createHmac("sha256", `dl:${secret}`).update(`${name}|${expiresAt}`).digest("base64url");
}

export function verifyDownload(secret: string, name: string, expiresAt: number, sig: string): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = Buffer.from(signDownload(secret, name, expiresAt));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
