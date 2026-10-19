import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "./logger.js";

/** Published per-request prices in INR (https://api.indiankanoon.org/pricing/). */
export const PRICE_INR = {
  search: 0.5, // per result page
  origdoc: 0.5,
  doc: 0.2,
  fragment: 0.05,
  meta: 0.02,
} as const;

export type Endpoint = keyof typeof PRICE_INR;

interface DayLedger {
  day: string; // YYYY-MM-DD in Asia/Kolkata
  spentInr: number;
  calls: Partial<Record<Endpoint, number>>;
}

export class BudgetExceededError extends Error {
  constructor(spent: number, cost: number, cap: number) {
    super(
      `Daily Indian Kanoon budget reached: spent Rs ${spent.toFixed(2)} of Rs ${cap.toFixed(2)}; ` +
        `this call needs Rs ${cost.toFixed(2)}. Cached results are still available; the cap resets at midnight IST.`,
    );
    this.name = "BudgetExceededError";
  }
}

function istDay(d = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Tracks estimated spend. Costs are reserved before a request (so concurrent
 * calls cannot overshoot the cap) and settled with the actual amount after.
 */
export class Budget {
  private ledger: DayLedger = { day: istDay(), spentInr: 0, calls: {} };
  private reserved = 0;
  private session = { spentInr: 0, calls: {} as Partial<Record<Endpoint, number>>, savedInr: 0 };
  private file: string | null;
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * @param parent optional shared budget that every reservation also counts
   *   against, e.g. one cap across all keys that use the server's own token.
   */
  constructor(
    dir: string | null,
    private readonly capInr: number,
    private readonly log: Logger,
    fileName = "ledger.json",
    private readonly parent?: Budget,
  ) {
    this.file = dir ? path.join(dir, fileName) : null;
  }

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8")) as DayLedger;
      if (data.day === istDay()) this.ledger = data;
    } catch {
      /* first run or unreadable ledger: start fresh */
    }
  }

  private rollover(): void {
    const today = istDay();
    if (this.ledger.day !== today) this.ledger = { day: today, spentInr: 0, calls: {} };
  }

  reserve(cost: number): void {
    this.rollover();
    if (this.capInr > 0 && this.ledger.spentInr + this.reserved + cost > this.capInr + 1e-9) {
      throw new BudgetExceededError(this.ledger.spentInr + this.reserved, cost, this.capInr);
    }
    this.parent?.reserve(cost);
    this.reserved += cost;
  }

  release(reservedCost: number): void {
    this.reserved = Math.max(0, this.reserved - reservedCost);
    this.parent?.release(reservedCost);
  }

  settle(endpoint: Endpoint, reservedCost: number, actualCost: number): void {
    this.reserved = Math.max(0, this.reserved - reservedCost);
    this.parent?.settle(endpoint, reservedCost, actualCost);
    this.rollover();
    this.ledger.spentInr = round(this.ledger.spentInr + actualCost);
    this.ledger.calls[endpoint] = (this.ledger.calls[endpoint] ?? 0) + 1;
    this.session.spentInr = round(this.session.spentInr + actualCost);
    this.session.calls[endpoint] = (this.session.calls[endpoint] ?? 0) + 1;
    this.persist();
  }

  recordSaving(cost: number): void {
    this.session.savedInr = round(this.session.savedInr + cost);
  }

  private persist(): void {
    if (!this.file) return;
    const file = this.file;
    const snapshot = JSON.stringify(this.ledger);
    this.writeChain = this.writeChain.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(tmp, snapshot);
        await fs.rename(tmp, file);
      } catch (err) {
        this.log.warn("ledger write failed", { err: String(err) });
      }
    });
  }

  snapshot() {
    this.rollover();
    return {
      today: { ...this.ledger, calls: { ...this.ledger.calls } },
      session: { ...this.session, calls: { ...this.session.calls } },
      capInr: this.capInr,
      remainingInr: this.capInr > 0 ? round(Math.max(0, this.capInr - this.ledger.spentInr)) : null,
    };
  }
}
