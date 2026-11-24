import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeAgentIntegration, removeSavedMcpEntries } from "../server/agent-integration-remove";
import { installAgentSkill } from "../server/agent-skill";
import { pluginDataDir } from "../server/paths";

/**
 * 0.26.22: the settings screen can remove what the plugin wrote into the
 * agents' configuration. Removal follows ownership (the launch path into the
 * plugin's data directory), not just the current name, so an entry left by a
 * renamed server or skill is still found.
 */

let home = "";
const previous = {
  HOME: process.env.HOME,
  PASEO_HOME: process.env.PASEO_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "obb-remove-"));
  process.env.HOME = home;
  process.env.PASEO_HOME = path.join(home, "paseo");
  process.env.XDG_CONFIG_HOME = path.join(home, "xdg");
  delete process.env.KIMI_CODE_HOME;
});

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function ownedEntry(): { type: string; command: string[] } {
  return { type: "local", command: ["node", path.join(pluginDataDir(), "mcp-server.js")] };
}

function writeJson(file: string, document: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(document), "utf-8");
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function opencodeFile(): string {
  return path.join(home, "xdg", "opencode", "opencode.json");
}

function kiloFile(): string {
  return path.join(home, "xdg", "kilo", "kilo.json");
}

function clineFile(): string {
  return path.join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
}

const FOREIGN_OPENCODE = { type: "local", command: ["node", "/opt/memory/server.js"] };

function seedConfigFiles(): void {
  writeJson(opencodeFile(), {
    theme: "dark",
    mcp: {
      "obsidian-bridge": ownedEntry(),
      "renamed-obsidian": ownedEntry(),
      memory: FOREIGN_OPENCODE,
    },
  });
  writeJson(kiloFile(), {
    mcp: {
      "old-plugin-name": { type: "local", command: ["node", path.join(pluginDataDir(), "mcp-server.js")] },
      other: FOREIGN_OPENCODE,
    },
  });
  fs.mkdirSync(path.join(home, ".cline"), { recursive: true });
  writeJson(clineFile(), {
    mcpServers: {
      "obsidian-bridge": {
        transport: { type: "stdio", command: "node", args: [path.join(pluginDataDir(), "mcp-server.js")] },
      },
      memory: { transport: { type: "stdio", command: "node", args: ["/opt/memory/server.js"] } },
    },
  });
}

function agentRecordFile(): string {
  return path.join(process.env.PASEO_HOME as string, "agents", "workspace-one", "ag-1.json");
}

function seedAgentRecord(): void {
  writeJson(agentRecordFile(), {
    id: "ag-1",
    config: {
      provider: "opencode",
      model: "keep-me",
      mcpServers: {
        "obsidian-bridge": {
          type: "stdio",
          command: "node",
          args: [path.join(pluginDataDir(), "mcp-server.js")],
        },
        memory: { type: "stdio", command: "node", args: ["/opt/memory/server.js"] },
      },
    },
  });
}

function seedSkills(): void {
  const root = path.join(home, ".agents", "skills");
  fs.mkdirSync(root, { recursive: true });
  expect(installAgentSkill().ok).toBe(true);
  // A skill the plugin installed before it was renamed: the directory name is
  // unknown to this version, the marker in SKILL.md is not.
  const renamed = path.join(root, "obsidian-old-skill");
  fs.mkdirSync(renamed, { recursive: true });
  fs.writeFileSync(
    path.join(renamed, "SKILL.md"),
    "---\nname: obsidian-old-skill\ndescription: x\n---\n\n<!-- installed-by: obsidian-bridge -->\n",
    "utf-8",
  );
  const foreign = path.join(root, "other-skill");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "SKILL.md"), "another plugin's instructions", "utf-8");
}

describe("remove agent integration", () => {
  it("removes every registration the plugin wrote and preserves foreign ones", () => {
    seedConfigFiles();
    seedSkills();
    seedAgentRecord();

    const result = removeAgentIntegration();
    expect(result.errors).toEqual([]);
    expect(result.removed.length).toBeGreaterThanOrEqual(5);

    const opencode = readJson(opencodeFile());
    expect(opencode.theme).toBe("dark");
    expect(Object.keys(opencode.mcp)).toEqual(["memory"]);
    expect(opencode.mcp.memory).toEqual(FOREIGN_OPENCODE);

    const kilo = readJson(kiloFile());
    expect(Object.keys(kilo.mcp)).toEqual(["other"]);

    const cline = readJson(clineFile());
    expect(Object.keys(cline.mcpServers)).toEqual(["memory"]);

    const saved = readJson(agentRecordFile());
    expect(saved.config.model).toBe("keep-me");
    expect(Object.keys(saved.config.mcpServers)).toEqual(["memory"]);

    const skillsRoot = path.join(home, ".agents", "skills");
    expect(fs.existsSync(path.join(skillsRoot, "obsidian-bridge"))).toBe(false);
    expect(fs.existsSync(path.join(skillsRoot, "obsidian-old-skill"))).toBe(false);
    expect(fs.existsSync(path.join(skillsRoot, "obsidian-planning-create"))).toBe(false);
    expect(fs.readFileSync(path.join(skillsRoot, "other-skill", "SKILL.md"), "utf-8")).toBe(
      "another plugin's instructions",
    );
  });

  it("is idempotent and reports nothing when there is no integration", () => {
    seedConfigFiles();
    seedSkills();
    seedAgentRecord();
    expect(removeAgentIntegration().removed.length).toBeGreaterThan(0);

    const second = removeAgentIntegration();
    expect(second).toEqual({ removed: [], errors: [] });
  });

  it("keeps a record that is not valid JSON instead of rewriting it", () => {
    fs.mkdirSync(path.dirname(agentRecordFile()), { recursive: true });
    fs.writeFileSync(agentRecordFile(), "{ not json", "utf-8");

    expect(removeSavedMcpEntries("obsidian-bridge")).toEqual({ removed: [], errors: [] });
    expect(fs.readFileSync(agentRecordFile(), "utf-8")).toBe("{ not json");
  });
});
