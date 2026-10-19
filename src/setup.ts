import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * `indiankanoon-mcp setup`: installs the server on this machine and registers
 * it with the MCP clients found here (Claude Code, Claude Desktop, Codex,
 * Cursor). Each client then starts the server locally over stdio with the
 * user's own Indian Kanoon token.
 */

export type ClientId = "claude-code" | "claude-desktop" | "codex" | "cursor";

export const CLIENT_NAMES: Record<ClientId, string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex CLI",
  cursor: "Cursor",
};

export interface ServerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const SERVER_NAME = "indiankanoon";
/** Windows runs .cmd shims (claude, npm) only through a shell. */
const WIN_SHELL = process.platform === "win32";

export function claudeDesktopConfigPath(home = os.homedir(), platform = process.platform): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

/** Adds or replaces mcpServers.indiankanoon in a JSON config, keeping every other entry. */
export function mergeJsonConfig(existing: string | null, server: ServerCommand): string {
  let data: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    const parsed = JSON.parse(existing) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config file is not a JSON object");
    data = parsed as Record<string, unknown>;
  }
  const servers = (data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {}) as Record<string, unknown>;
  servers[SERVER_NAME] = { command: server.command, args: server.args, env: server.env };
  data.mcpServers = servers;
  return `${JSON.stringify(data, null, 2)}\n`;
}

const tomlString = (s: string) => JSON.stringify(s); // JSON escapes are valid TOML basic-string escapes

/** Adds or replaces the [mcp_servers.indiankanoon] table in a Codex config.toml. */
export function upsertCodexToml(existing: string | null, server: ServerCommand): string {
  const lines = (existing ?? "").split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) skipping = header[1]!.trim() === `mcp_servers.${SERVER_NAME}` || header[1]!.trim().startsWith(`mcp_servers.${SERVER_NAME}.`);
    if (!skipping) out.push(line);
  }
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  const env = Object.entries(server.env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(", ");
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
    `env = { ${env} }`,
  ];
  return `${out.length ? `${out.join("\n")}\n\n` : ""}${block.join("\n")}\n`;
}

function writeWithBackup(file: string, content: string): string | null {
  mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.bak`;
    copyFileSync(file, backup);
  }
  writeFileSync(file, content, { mode: 0o600 });
  return backup;
}

function onPath(cmd: string): boolean {
  const r = spawnSync(WIN_SHELL ? "where" : "which", [cmd], { stdio: "ignore" });
  return r.status === 0;
}

export function detectClients(home = os.homedir()): ClientId[] {
  const found: ClientId[] = [];
  if (onPath("claude")) found.push("claude-code");
  if (existsSync(path.dirname(claudeDesktopConfigPath(home)))) found.push("claude-desktop");
  if (onPath("codex") || existsSync(path.join(home, ".codex"))) found.push("codex");
  if (existsSync(path.join(home, ".cursor"))) found.push("cursor");
  return found;
}

export function configureClient(id: ClientId, server: ServerCommand, home = os.homedir()): string {
  switch (id) {
    case "claude-code": {
      spawnSync("claude", ["mcp", "remove", SERVER_NAME, "-s", "user"], { stdio: "ignore", shell: WIN_SHELL });
      const envArgs = Object.entries(server.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const r = spawnSync("claude", ["mcp", "add", SERVER_NAME, "--scope", "user", ...envArgs, "--", server.command, ...server.args], { encoding: "utf8", shell: WIN_SHELL });
      if (r.status !== 0) throw new Error((r.stderr || r.stdout || "claude mcp add failed").trim());
      return "registered with `claude mcp add` (user scope)";
    }
    case "claude-desktop": {
      const file = claudeDesktopConfigPath(home);
      const backup = writeWithBackup(file, mergeJsonConfig(existsSync(file) ? readFileSync(file, "utf8") : null, server));
      return `updated ${file}${backup ? " (backup: .bak)" : ""}. Restart Claude Desktop.`;
    }
    case "codex": {
      const file = path.join(home, ".codex", "config.toml");
      const backup = writeWithBackup(file, upsertCodexToml(existsSync(file) ? readFileSync(file, "utf8") : null, server));
      return `updated ${file}${backup ? " (backup: .bak)" : ""}`;
    }
    case "cursor": {
      const file = path.join(home, ".cursor", "mcp.json");
      const backup = writeWithBackup(file, mergeJsonConfig(existsSync(file) ? readFileSync(file, "utf8") : null, server));
      return `updated ${file}${backup ? " (backup: .bak)" : ""}. Restart Cursor.`;
    }
  }
}

/** Root of the package this code runs from (the folder holding package.json). */
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Makes a durable copy of the server. A git checkout or global install is used
 * in place; a run from the npx cache (which npm may clear) is copied into
 * ~/.indiankanoon-mcp so clients keep working.
 */
export function installServer(installDir = path.join(os.homedir(), ".indiankanoon-mcp")): string {
  const root = packageRoot();
  if (existsSync(path.join(root, "node_modules", "@modelcontextprotocol", "sdk"))) return path.join(root, "dist", "index.js");
  const npm = WIN_SHELL ? "npm.cmd" : "npm";
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ikmcp-pack-"));
  try {
    const tgz = execFileSync(npm, ["pack", root, "--pack-destination", tmp, "--silent"], { encoding: "utf8", shell: WIN_SHELL }).trim().split("\n").pop()!;
    mkdirSync(installDir, { recursive: true });
    if (!existsSync(path.join(installDir, "package.json"))) writeFileSync(path.join(installDir, "package.json"), '{ "private": true }\n');
    execFileSync(npm, ["install", "--prefix", installDir, "--omit=dev", "--no-audit", "--no-fund", "--silent", path.join(tmp, tgz)], { stdio: "inherit", shell: WIN_SHELL });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return path.join(installDir, "node_modules", "indiankanoon-mcp", "dist", "index.js");
}

async function checkToken(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.indiankanoon.org/docmeta/91938676/", {
      method: "POST",
      headers: { Authorization: `Token ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) return "Indian Kanoon rejected this token.";
    if (!res.ok) return `Indian Kanoon returned HTTP ${res.status}.`;
    const body = JSON.parse(text) as { errmsg?: string };
    return body.errmsg ? `Indian Kanoon error: ${body.errmsg}` : null;
  } catch (e) {
    return `Could not reach Indian Kanoon: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function ask(question: string, opts: { hidden?: boolean; def?: string } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const suffix = opts.def ? ` [${opts.def}]` : "";
    if (opts.hidden) {
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        write(s.startsWith(question) ? s : s.replace(/[^\r\n]/g, "*"));
      };
    }
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      if (opts.hidden) process.stdout.write("\n");
      resolve(answer.trim() || opts.def || "");
    });
  });
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) out[k] = argv[++i]!;
    else out[k] = true;
  }
  return out;
}

const HELP = `Set up the Indian Kanoon MCP server on this computer.

Usage: indiankanoon-mcp setup [options]

  --token <token>      Indian Kanoon API token (or set IK_API_TOKEN; asked if missing)
  --budget <rupees>    Daily spend cap in INR (default 50; 0 = no cap)
  --clients <list>     Comma-separated: claude-code,claude-desktop,codex,cursor (default: all detected)
  --yes                Do not ask questions; use detected clients and defaults
  --skip-check         Do not verify the token (skips one Rs 0.02 call)
`;

export async function runSetup(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const interactive = !args.yes && process.stdin.isTTY;
  console.log("Indian Kanoon MCP: local setup\n");

  let token = String(args.token ?? process.env.IK_API_TOKEN ?? "").trim();
  if (!token && interactive) token = await ask("Indian Kanoon API token (from api.indiankanoon.org)", { hidden: true });
  if (!/^[A-Za-z0-9]{20,100}$/.test(token)) {
    console.error("A valid Indian Kanoon API token is required (--token or IK_API_TOKEN).");
    return 1;
  }
  if (!args["skip-check"]) {
    process.stdout.write("Checking token (one Rs 0.02 call)… ");
    const problem = await checkToken(token);
    if (problem) {
      console.log("failed");
      console.error(problem);
      return 1;
    }
    console.log("ok");
  }

  let budget = String(args.budget ?? "");
  if (!budget) budget = interactive ? await ask("Daily spend cap in Rs (0 = no cap)", { def: "50" }) : "50";
  if (!/^\d+(\.\d+)?$/.test(budget)) {
    console.error(`Invalid budget "${budget}".`);
    return 1;
  }

  const detected = detectClients();
  let clients: ClientId[];
  if (typeof args.clients === "string") {
    clients = args.clients.split(",").map((s) => s.trim()) as ClientId[];
    const bad = clients.filter((c) => !(c in CLIENT_NAMES));
    if (bad.length) {
      console.error(`Unknown client(s): ${bad.join(", ")}. Use: ${Object.keys(CLIENT_NAMES).join(", ")}`);
      return 1;
    }
  } else if (interactive) {
    console.log(`\nClients found: ${detected.length ? detected.map((c) => CLIENT_NAMES[c]).join(", ") : "none"}`);
    const answer = await ask("Configure which? (comma-separated ids, or 'all' for found ones)", { def: "all" });
    clients = answer === "all" ? detected : (answer.split(",").map((s) => s.trim()).filter(Boolean) as ClientId[]);
  } else {
    clients = detected;
  }

  console.log("\nInstalling server…");
  const script = installServer();
  const server: ServerCommand = {
    command: realpathSync(process.execPath),
    args: [script],
    env: { IK_API_TOKEN: token, IK_DAILY_BUDGET_INR: budget },
  };
  console.log(`Server: ${server.command} ${script}`);

  if (clients.length === 0) {
    console.log("\nNo clients selected. Add this server to any MCP client manually:");
    console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }, null, 2).replace(token, "<your token>"));
    return 0;
  }

  let failures = 0;
  console.log("");
  for (const id of clients) {
    try {
      console.log(`✔ ${CLIENT_NAMES[id]}: ${configureClient(id, server)}`);
    } catch (e) {
      failures++;
      console.log(`✖ ${CLIENT_NAMES[id]}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\nDone. Open a new session in your client and ask, for example:\n  "Find Supreme Court judgments on the right to privacy from 2017."`);
  console.log("Run this setup again to change the token or cap, or to update the server.");
  return failures ? 1 : 0;
}
