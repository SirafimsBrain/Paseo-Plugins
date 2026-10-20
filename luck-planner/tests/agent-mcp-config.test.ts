/**
 * The agent config registrations (PLAN.md stage D4).
 *
 * The plugin can register its MCP server in the agents' *own* config files,
 * which is the only registration that survives OpenCode's per-directory
 * eviction and the only one the terminal agents (Cline, Cursor, Codex CLI)
 * read at all. The rules every writer follows are asserted here, because they
 * are the ones that can destroy a user's file:
 *
 * - a **foreign** key, server, table and comment survive a registration and
 *   a removal;
 * - a file that **does not parse** is reported, never overwritten (a JSON
 *   config with `//` comments cannot be round-tripped by a JSON writer);
 * - the write is **atomic** and keeps the file's mode;
 * - registering twice changes nothing the second time;
 * - the status tells the truth: registered / registered with an older command
 *   / not registered / not installed on this machine.
 *
 * The tests point `HOME` and `XDG_CONFIG_HOME` at a temporary directory, so
 * they never touch the machine's real agent configs.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_MCP_SERVER_NAME,
  agentConfigCoversProvider,
  agentMcpStatuses,
  registerAgentMcp,
  unregisterAgentMcp,
} from "../server/agent-mcp-config";

let home = "";
let previousHome: string | undefined;
let previousXdg: string | undefined;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "luck-planner-agentcfg-"));
  previousHome = process.env.HOME;
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(home, { recursive: true, force: true });
});

/** The path of a target's config file inside the temporary home. */
function targetPath(id: string): string {
  const statuses = agentMcpStatuses();
  const row = statuses.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`unknown target ${id}`);
  return row.path;
}

describe("D4: the OpenCode and Kilo config files", () => {
  it("registers the server in the `mcp` object", () => {
    const outcome = registerAgentMcp("opencode");
    expect(outcome.error).toBeNull();
    const document = JSON.parse(readFileSync(targetPath("opencode"), "utf8")) as {
      mcp: Record<string, { type: string; command: string[]; enabled: boolean }>;
    };
    const entry = document.mcp[AGENT_MCP_SERVER_NAME];
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("local");
    expect(entry?.enabled).toBe(true);
    // The command is a node binary plus the published entry.
    expect(Array.isArray(entry?.command)).toBe(true);
    expect(entry?.command.length).toBeGreaterThanOrEqual(2);
    expect(entry?.command[0]).toMatch(/node/);
  });

  it("keeps every foreign key and every other server", () => {
    const file = targetPath("opencode");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          theme: "dark",
          mcp: { other: { type: "local", command: ["node", "other.js"] } },
        },
        null,
        2,
      ),
    );
    expect(registerAgentMcp("opencode").ok).toBe(true);
    const document = JSON.parse(readFileSync(file, "utf8")) as {
      theme: string;
      mcp: Record<string, unknown>;
    };
    expect(document.theme).toBe("dark");
    expect(document.mcp.other).toBeDefined();
    expect(document.mcp[AGENT_MCP_SERVER_NAME]).toBeDefined();
  });

  it("registers in Kilo's own file name", () => {
    expect(registerAgentMcp("kilo").ok).toBe(true);
    expect(targetPath("kilo")).toContain("kilo.jsonc");
  });

  it("removes only its own entry", () => {
    const file = targetPath("opencode");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ mcp: { other: { type: "local", command: ["node", "other.js"] } } }),
    );
    registerAgentMcp("opencode");
    expect(unregisterAgentMcp("opencode").ok).toBe(true);
    const document = JSON.parse(readFileSync(file, "utf8")) as {
      mcp: Record<string, unknown>;
    };
    expect(document.mcp[AGENT_MCP_SERVER_NAME]).toBeUndefined();
    expect(document.mcp.other).toBeDefined();
  });
});

describe("D4: the Cline and Cursor config files", () => {
  it("writes Cline's transport shape", () => {
    expect(registerAgentMcp("cline").ok).toBe(true);
    const document = JSON.parse(readFileSync(targetPath("cline"), "utf8")) as {
      mcpServers: Record<string, { transport: { type: string; command: string; args: string[] } }>;
    };
    const entry = document.mcpServers[AGENT_MCP_SERVER_NAME];
    expect(entry?.transport.type).toBe("stdio");
    expect(typeof entry?.transport.command).toBe("string");
    expect(Array.isArray(entry?.transport.args)).toBe(true);
  });

  it("writes Cursor's flat shape", () => {
    expect(registerAgentMcp("cursor").ok).toBe(true);
    const document = JSON.parse(readFileSync(targetPath("cursor"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const entry = document.mcpServers[AGENT_MCP_SERVER_NAME];
    expect(typeof entry?.command).toBe("string");
    expect(Array.isArray(entry?.args)).toBe(true);
  });

  it("keeps the other servers of the file", () => {
    const file = targetPath("cursor");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { other: { command: "node", args: ["x.js"] } } }),
    );
    registerAgentMcp("cursor");
    const document = JSON.parse(readFileSync(file, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(document.mcpServers.other).toBeDefined();
  });
});

describe("D4: the Qwen Code config file", () => {
  it("writes the flat shape Qwen's own `qwen mcp add` writes", () => {
    expect(registerAgentMcp("qwen-code").ok).toBe(true);
    const document = JSON.parse(readFileSync(targetPath("qwen-code"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; timeout?: number; trust?: boolean }>;
    };
    const entry = document.mcpServers[AGENT_MCP_SERVER_NAME];
    expect(typeof entry?.command).toBe("string");
    expect(Array.isArray(entry?.args)).toBe(true);
    expect(entry?.command).toMatch(/node/);
    // The slow-start guard the OpenCode/Kilo entry carries.
    expect(entry?.timeout).toBeGreaterThanOrEqual(10000);
    // The user asked for the registration with a button — the agent must not
    // stop at an approval prompt in another window.
    expect(entry?.trust).toBe(true);
  });

  it("keeps every other setting of the file", () => {
    const file = targetPath("qwen-code");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          ui: { autoModeAcknowledged: true },
          modelProviders: { openai: [{ id: "some/model" }] },
          mcpServers: { other: { command: "node", args: ["x.js"] } },
        },
        null,
        2,
      ),
    );
    expect(registerAgentMcp("qwen-code").ok).toBe(true);
    const document = JSON.parse(readFileSync(file, "utf8")) as {
      ui: { autoModeAcknowledged: boolean };
      modelProviders: unknown;
      mcpServers: Record<string, unknown>;
    };
    expect(document.ui.autoModeAcknowledged).toBe(true);
    expect(document.modelProviders).toBeDefined();
    expect(document.mcpServers.other).toBeDefined();
    expect(document.mcpServers[AGENT_MCP_SERVER_NAME]).toBeDefined();
  });

  it("removes only its own entry", () => {
    const file = targetPath("qwen-code");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { other: { command: "node", args: ["x.js"] } } }),
    );
    registerAgentMcp("qwen-code");
    expect(unregisterAgentMcp("qwen-code").ok).toBe(true);
    const document = JSON.parse(readFileSync(file, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(document.mcpServers[AGENT_MCP_SERVER_NAME]).toBeUndefined();
    expect(document.mcpServers.other).toBeDefined();
  });

  it("covers the `qwen-code` provider, so the session injection yields to it", () => {
    expect(agentConfigCoversProvider("qwen-code").covered).toBe(false);
    expect(registerAgentMcp("qwen-code").ok).toBe(true);
    const cover = agentConfigCoversProvider("qwen-code");
    expect(cover.covered).toBe(true);
    expect(cover.path).toContain(path.join(".qwen", "settings.json"));
  });
});

describe("D4: the Codex CLI config file (TOML)", () => {
  it("adds its own table and keeps the rest of the file", () => {
    const file = targetPath("codex");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      ['# my own note', 'model = "gpt-5"', '', '[mcp_servers.other]', 'command = "node"', 'args = ["other.js"]', ''].join("\n"),
    );
    expect(registerAgentMcp("codex").ok).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# my own note");
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain("[mcp_servers.other]");
    expect(text).toContain(`[mcp_servers.${AGENT_MCP_SERVER_NAME}]`);
    expect(text).toContain("command = ");
    expect(text).toContain("args = [");
  });

  it("replaces only its own table on a second registration", () => {
    const file = targetPath("codex");
    expect(registerAgentMcp("codex").ok).toBe(true);
    const first = readFileSync(file, "utf8");
    expect(registerAgentMcp("codex").ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(first);
    // Exactly one table of ours.
    const occurrences = readFileSync(file, "utf8").split(`[mcp_servers.${AGENT_MCP_SERVER_NAME}]`).length - 1;
    expect(occurrences).toBe(1);
  });

  it("removes its own table and keeps the others", () => {
    const file = targetPath("codex");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '[mcp_servers.other]\ncommand = "node"\nargs = ["other.js"]\n');
    registerAgentMcp("codex");
    expect(unregisterAgentMcp("codex").ok).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(`[mcp_servers.${AGENT_MCP_SERVER_NAME}]`);
    expect(text).toContain("[mcp_servers.other]");
  });
});

describe("D4: a file that cannot be parsed is never overwritten", () => {
  it("reports the problem and leaves the file alone", () => {
    const file = targetPath("opencode");
    mkdirSync(path.dirname(file), { recursive: true });
    const original = '{\n  // a hand-written comment\n  "theme": "dark"\n}\n';
    writeFileSync(file, original);
    const outcome = registerAgentMcp("opencode");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("cannot be parsed");
    expect(readFileSync(file, "utf8")).toBe(original);
  });
});

describe("D4: the status tells the truth", () => {
  it("reports nothing registered before the first registration", () => {
    const row = agentMcpStatuses().find((candidate) => candidate.id === "opencode");
    expect(row?.installed).toBe(false);
    expect(row?.upToDate).toBeNull();
  });

  it("reports a current registration after it", () => {
    expect(registerAgentMcp("opencode").ok).toBe(true);
    const row = agentMcpStatuses().find((candidate) => candidate.id === "opencode");
    expect(row?.installed).toBe(true);
    expect(row?.upToDate).toBe(true);
    expect(row?.command).toMatch(/node/);
    expect(row?.args?.length).toBeGreaterThanOrEqual(1);
  });

  it("reports an agent that is not installed on this machine", () => {
    const row = agentMcpStatuses().find((candidate) => candidate.id === "cursor");
    expect(row?.detected).toBe(false);
  });
});

describe("D4: the session injection yields to a config-file registration", () => {
  it("covers the provider once the file carries a current entry", () => {
    expect(agentConfigCoversProvider("opencode").covered).toBe(false);
    expect(registerAgentMcp("opencode").ok).toBe(true);
    const cover = agentConfigCoversProvider("opencode");
    expect(cover.covered).toBe(true);
    expect(cover.path).toContain("opencode");
  });

  it("knows nothing about an unknown provider", () => {
    expect(agentConfigCoversProvider("someone-else")).toEqual({
      covered: false,
      path: null,
    });
  });
});

describe("D4: the writes are atomic", () => {
  it("leaves no staging file behind", () => {
    const file = targetPath("opencode");
    expect(registerAgentMcp("opencode").ok).toBe(true);
    const dir = path.dirname(file);
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("keeps the file's mode", () => {
    const file = targetPath("cursor");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{}\n");
    chmodSync(file, 0o600);
    expect(registerAgentMcp("cursor").ok).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("D4: every target is offered", () => {
  it("knows the six agents", () => {
    expect(agentMcpStatuses().map((row) => row.id)).toEqual([
      "opencode",
      "kilo",
      "cline",
      "cursor",
      "qwen-code",
      "codex",
    ]);
  });

  it("gives every target a path and a label", () => {
    for (const row of agentMcpStatuses()) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(path.isAbsolute(row.path)).toBe(true);
    }
  });
});

describe("D4: the registration is written where the agent reads it", () => {
  it("uses the XDG config directory for OpenCode and Kilo", () => {
    registerAgentMcp("opencode");
    expect(existsSync(path.join(home, ".config", "opencode", "opencode.json"))).toBe(true);
  });

  it("uses the home directory for Cline, Cursor, Qwen Code and Codex", () => {
    registerAgentMcp("cline");
    registerAgentMcp("cursor");
    registerAgentMcp("qwen-code");
    registerAgentMcp("codex");
    expect(existsSync(path.join(home, ".cline", "data", "settings", "cline_mcp_settings.json"))).toBe(true);
    expect(existsSync(path.join(home, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(path.join(home, ".qwen", "settings.json"))).toBe(true);
    expect(existsSync(path.join(home, ".codex", "config.toml"))).toBe(true);
  });
});
