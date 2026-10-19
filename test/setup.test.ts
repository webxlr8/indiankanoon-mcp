import { describe, expect, it } from "vitest";
import { mergeJsonConfig, upsertCodexToml, type ServerCommand } from "../src/setup.js";

const server: ServerCommand = { command: "/usr/bin/node", args: ["/opt/ik/dist/index.js"], env: { IK_API_TOKEN: "tok", IK_DAILY_BUDGET_INR: "50" } };

describe("mergeJsonConfig", () => {
  it("adds the server and keeps other entries", () => {
    const out = JSON.parse(mergeJsonConfig(JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }), server));
    expect(out.theme).toBe("dark");
    expect(out.mcpServers.other).toEqual({ command: "x" });
    expect(out.mcpServers.indiankanoon).toEqual(server);
  });
  it("creates a config from nothing and rejects non-object JSON", () => {
    expect(JSON.parse(mergeJsonConfig(null, server)).mcpServers.indiankanoon.command).toBe("/usr/bin/node");
    expect(() => mergeJsonConfig("[]", server)).toThrow();
  });
});

describe("upsertCodexToml", () => {
  it("appends the table and keeps the rest", () => {
    const out = upsertCodexToml('model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n', server);
    expect(out).toContain('model = "o4"');
    expect(out).toContain('[mcp_servers.other]\ncommand = "x"');
    expect(out).toContain('[mcp_servers.indiankanoon]\ncommand = "/usr/bin/node"\nargs = ["/opt/ik/dist/index.js"]\nenv = { IK_API_TOKEN = "tok", IK_DAILY_BUDGET_INR = "50" }');
  });
  it("replaces an existing table instead of duplicating it", () => {
    const first = upsertCodexToml('[mcp_servers.indiankanoon]\ncommand = "old"\nargs = []\n\n[profiles.x]\nmodel = "y"\n', server);
    expect(first.match(/\[mcp_servers\.indiankanoon\]/g)).toHaveLength(1);
    expect(first).not.toContain('"old"');
    expect(first).toContain('[profiles.x]\nmodel = "y"');
    expect(upsertCodexToml(first, server)).toBe(first);
  });
});
