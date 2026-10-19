#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Budget } from "./budget.js";
import { TieredCache } from "./cache.js";
import { IKClient } from "./client.js";
import { loadConfig } from "./config.js";
import { createHttpApp, VERSION } from "./http.js";
import { createLogger } from "./logger.js";
import { registerTools, SERVER_INSTRUCTIONS } from "./tools.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);
  const cache = new TieredCache(cfg.cacheDir, cfg.memCacheEntries, cfg.cacheMaxMb * 1024 * 1024, log);
  void cache.prune();

  if (cfg.transport === "http") {
    const app = await createHttpApp({ cfg, cache, log });
    await new Promise<void>((resolve) => app.server.listen(cfg.httpPort, cfg.httpHost, resolve));
    log.info("http transport listening", {
      version: VERSION,
      host: cfg.httpHost,
      port: cfg.httpPort,
      publicSignup: cfg.publicSignup,
      admin: Boolean(cfg.adminToken),
      serverToken: Boolean(cfg.apiToken),
    });
    const shutdown = (sig: string) => {
      log.info("shutting down", { sig });
      void app.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    return;
  }

  const budget = new Budget(cfg.cacheDir, cfg.dailyBudgetInr, log);
  await budget.load();
  const client = new IKClient(cfg, cache, budget, log);
  const server = new McpServer({ name: "indiankanoon", version: VERSION }, { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } });
  registerTools(server, { client, cfg, log });
  await server.connect(new StdioServerTransport());
  log.info("stdio transport ready", { version: VERSION, cacheDir: cfg.cacheDir, dailyBudgetInr: cfg.dailyBudgetInr });
}

main().catch((err) => {
  process.stderr.write(`indiankanoon-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
