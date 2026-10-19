#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Budget } from "./budget.js";
import { TieredCache } from "./cache.js";
import { IKClient } from "./client.js";
import { loadConfig } from "./config.js";
import { VERSION } from "./version.js";
import { createLogger } from "./logger.js";
import { registerTools, SERVER_INSTRUCTIONS } from "./tools.js";

const USAGE = `indiankanoon-mcp ${VERSION}

  indiankanoon-mcp            Run the MCP server (stdio; MCP_TRANSPORT=http for the hosted server)
  indiankanoon-mcp setup      Install on this computer and connect Claude Code, Claude Desktop, Codex, Cursor
  indiankanoon-mcp --version
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === "setup") {
    const { runSetup } = await import("./setup.js");
    process.exitCode = await runSetup(process.argv.slice(3));
    return;
  }

  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);
  const cache = new TieredCache(cfg.cacheDir, cfg.memCacheEntries, cfg.cacheMaxMb * 1024 * 1024, log);
  void cache.prune();

  if (cfg.transport === "http") {
    const { createHttpApp } = await import("./http.js"); // loads node:sqlite only in hosted mode
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
