import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Logger } from "./logger.js";

interface Entry {
  expiresAt: number; // epoch ms
  value: unknown;
}

export interface CacheStats {
  memHits: number;
  diskHits: number;
  misses: number;
  writes: number;
}

/**
 * Two-tier cache: small in-memory LRU in front of a gzip-compressed disk store.
 * Indian Kanoon bills every request, and judgments never change once
 * published, so a long-lived disk cache is the single biggest cost saver.
 */
export class TieredCache {
  private mem = new Map<string, Entry>();
  private writesSincePrune = 0;
  readonly stats: CacheStats = { memHits: 0, diskHits: 0, misses: 0, writes: 0 };

  constructor(
    private readonly dir: string | null,
    private readonly memEntries: number,
    private readonly maxBytes: number,
    private readonly log: Logger,
  ) {}

  static keyFor(parts: string): string {
    return createHash("sha256").update(parts).digest("hex");
  }

  private filePath(key: string): string {
    return path.join(this.dir as string, key.slice(0, 2), `${key}.json.gz`);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const now = Date.now();
    const hit = this.mem.get(key);
    if (hit) {
      if (hit.expiresAt > now) {
        // refresh LRU position
        this.mem.delete(key);
        this.mem.set(key, hit);
        this.stats.memHits++;
        return hit.value as T;
      }
      this.mem.delete(key);
    }

    if (this.dir) {
      try {
        const buf = await fs.readFile(this.filePath(key));
        const entry = JSON.parse(gunzipSync(buf).toString("utf8")) as Entry;
        if (entry.expiresAt > now) {
          this.remember(key, entry);
          this.stats.diskHits++;
          return entry.value as T;
        }
        await fs.rm(this.filePath(key), { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          this.log.warn("cache read failed", { err: String(err) });
        }
      }
    }

    this.stats.misses++;
    return undefined;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    const entry: Entry = { expiresAt: Date.now() + ttlSeconds * 1000, value };
    this.remember(key, entry);
    this.stats.writes++;
    if (!this.dir) return;

    const file = this.filePath(key);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, gzipSync(JSON.stringify(entry)));
      await fs.rename(tmp, file); // atomic replace
    } catch (err) {
      this.log.warn("cache write failed", { err: String(err) });
      await fs.rm(tmp, { force: true }).catch(() => {});
    }

    if (++this.writesSincePrune >= 50) {
      this.writesSincePrune = 0;
      void this.prune();
    }
  }

  private remember(key: string, entry: Entry): void {
    if (this.memEntries <= 0) return;
    this.mem.delete(key);
    this.mem.set(key, entry);
    while (this.mem.size > this.memEntries) {
      const oldest = this.mem.keys().next().value as string;
      this.mem.delete(oldest);
    }
  }

  /** Remove expired files, then the least recently written ones until under the size cap. */
  async prune(): Promise<void> {
    if (!this.dir || this.maxBytes <= 0) return;
    try {
      const files: { file: string; size: number; mtime: number }[] = [];
      const shards = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => []);
      for (const shard of shards) {
        if (!shard.isDirectory() || shard.name.length !== 2) continue;
        const shardDir = path.join(this.dir, shard.name);
        for (const name of await fs.readdir(shardDir)) {
          const file = path.join(shardDir, name);
          const st = await fs.stat(file).catch(() => null);
          if (st) files.push({ file, size: st.size, mtime: st.mtimeMs });
        }
      }
      let total = files.reduce((s, f) => s + f.size, 0);
      if (total <= this.maxBytes) return;
      files.sort((a, b) => a.mtime - b.mtime);
      for (const f of files) {
        if (total <= this.maxBytes * 0.9) break;
        await fs.rm(f.file, { force: true });
        total -= f.size;
      }
      this.log.info("cache pruned", { bytes: total });
    } catch (err) {
      this.log.warn("cache prune failed", { err: String(err) });
    }
  }
}
