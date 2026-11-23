import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_MCP_SERVER_NAME,
  agentConfigCoversProvider,
  configStatus,
  registerConfig,
  unregisterConfig,
} from "../server/opencode-mcp";

/**
 * Agent config-file registration: the path that actually delivers the server
 * to OpenCode (Paseo 0.15.x refuses custom MCP servers on a shared service and
 * does not surface attached tools to OpenCode).
 */

const previousXdg = process.env.XDG_CONFIG_HOME;
const previousPaseo = process.env.PASEO_HOME;
let root = "";

const opencode = {
  label: "OpenCode",
  configDir: () => path.join(root, "opencode"),
  fileNames: ["opencode.json", "opencode.jsonc"],
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "obb-opencode-"));
  process.env.XDG_CONFIG_HOME = root;
  // The launch command is resolved from the daemon config, and `upToDate` also
  // requires the entry to exist on disk. Both are host state: on a developer
  // machine `~/.paseo/config.json` points at a real checkout and the test passed
  // by accident, while a clean runner has no Paseo home at all (it failed
  // there). A temporary home with a real bundle makes the case self-contained.
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(path.join(checkout, "dist"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "dist", "mcp-server.js"), "// test bundle\n", "utf-8");
  const home = path.join(root, "paseo-home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ plugins: { "obsidian-bridge": { path: checkout } } }),
    "utf-8",
  );
  process.env.PASEO_HOME = home;
});

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  if (previousPaseo === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousPaseo;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("agent config registration", () => {
  it("creates the entry and reports it as installed", () => {
    expect(registerConfig(opencode).ok).toBe(true);
    const file = path.join(root, "opencode", "opencode.json");
    const document = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(document.mcp[CONFIG_MCP_SERVER_NAME]).toMatchObject({
      type: "local",
      enabled: true,
    });
    expect(document.mcp[CONFIG_MCP_SERVER_NAME].command[0]).toMatch(/node$/);
    const status = configStatus(opencode);
    expect(status).toMatchObject({ installed: true, upToDate: true, detected: true });
  });

  it("preserves foreign keys and foreign servers", () => {
    const file = path.join(root, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ theme: "dark", mcp: { "memory-flash": { type: "local", command: ["node", "x.js"] } } }),
      "utf-8",
    );
    registerConfig(opencode);
    const document = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(document.theme).toBe("dark");
    expect(Object.keys(document.mcp).sort()).toEqual(["memory-flash", CONFIG_MCP_SERVER_NAME].sort());
  });

  it("refreshes an entry that points at an old install", () => {
    const file = path.join(root, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ mcp: { [CONFIG_MCP_SERVER_NAME]: { type: "local", command: ["node", "/old.js"] } } }),
      "utf-8",
    );
    expect(configStatus(opencode).upToDate).toBe(false);
    registerConfig(opencode);
    expect(configStatus(opencode).upToDate).toBe(true);
  });

  it("removes only its own entry and keeps the rest", () => {
    const file = path.join(root, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcp: { other: { type: "local", command: ["node"] } } }), "utf-8");
    registerConfig(opencode);
    expect(unregisterConfig(opencode).ok).toBe(true);
    const document = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(document.mcp).toEqual({ other: { type: "local", command: ["node"] } });
    expect(configStatus(opencode).installed).toBe(false);
  });

  it("leaves a commented config file untouched and reports why", () => {
    const file = path.join(root, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = '{\n  // hand-written comment\n  "theme": "dark"\n}\n';
    fs.writeFileSync(file, body, "utf-8");
    const result = registerConfig(opencode);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be parsed/);
    expect(fs.readFileSync(file, "utf-8")).toBe(body);
  });

  it("treats an absent config as untouched by unregister", () => {
    expect(unregisterConfig(opencode).ok).toBe(true);
    expect(fs.existsSync(path.join(root, "opencode"))).toBe(false);
  });

  it("does not claim providers it never registers", () => {
    expect(agentConfigCoversProvider("codex")).toEqual({ covered: false, path: null });
    expect(agentConfigCoversProvider("qwen-code")).toEqual({ covered: false, path: null });
  });
});
