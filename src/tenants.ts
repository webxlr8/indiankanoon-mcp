import path from "node:path";
import { Budget } from "./budget.js";
import type { TieredCache } from "./cache.js";
import { IKClient, type FetchLike } from "./client.js";
import type { Config } from "./config.js";
import type { KeyRecord } from "./keys.js";
import type { Logger } from "./logger.js";

interface Entry {
  client: IKClient;
  token: string;
  cap: number;
}

/**
 * One IKClient per connection key, each with its own daily budget ledger.
 * Keys that use the server's own Indian Kanoon token also count against one
 * shared "house" budget, so the owner's total spend stays capped.
 */
export class Tenants {
  private readonly entries = new Map<string, Entry>();
  private readonly ledgerDir: string;
  readonly house: Budget;

  constructor(
    private readonly cfg: Config,
    private readonly cache: TieredCache,
    private readonly log: Logger,
    private readonly fetchImpl?: FetchLike,
  ) {
    this.ledgerDir = path.join(cfg.dataDir, "ledgers");
    this.house = new Budget(this.ledgerDir, cfg.houseDailyBudgetInr, log, "house.json");
  }

  async init(): Promise<void> {
    await this.house.load();
  }

  async clientFor(record: KeyRecord, ikToken: string | null): Promise<IKClient> {
    const token = ikToken ?? this.cfg.apiToken;
    if (!token) throw new Error("This key uses the server's Indian Kanoon token, but the server has none configured.");
    const hit = this.entries.get(record.id);
    if (hit && hit.token === token && hit.cap === record.dailyBudgetInr) {
      this.entries.delete(record.id);
      this.entries.set(record.id, hit);
      return hit.client;
    }
    const budget = new Budget(this.ledgerDir, record.dailyBudgetInr, this.log, `${record.id}.json`, ikToken ? undefined : this.house);
    await budget.load();
    const client = new IKClient(
      { ...this.cfg, apiToken: token, cacheNamespace: this.cfg.shareCache ? undefined : `${record.id}:` },
      this.cache,
      budget,
      this.log,
      this.fetchImpl,
    );
    this.entries.set(record.id, { client, token, cap: record.dailyBudgetInr });
    while (this.entries.size > 500) this.entries.delete(this.entries.keys().next().value as string);
    return client;
  }

  forget(id: string): void {
    this.entries.delete(id);
  }
}
