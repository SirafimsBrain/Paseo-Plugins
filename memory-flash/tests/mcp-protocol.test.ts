import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSettingsFile } from "../server/settings-file";

describe("parseSettingsFile", () => {
  it("returns defaults for a missing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-settings-"));
    const parsed = parseSettingsFile(path.join(dir, "missing.json"));
    expect(parsed).toEqual({ mcpServerName: "memory-flash", historyPerMemory: 50, defaultAgentId: "" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads values nested under `values` (host settings layout)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-settings-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ revision: "r1", values: { mcpServerName: "my-memory", historyPerMemory: 25, defaultAgentId: "kilo" } }),
    );
    const parsed = parseSettingsFile(file);
    expect(parsed.mcpServerName).toBe("my-memory");
    expect(parsed.historyPerMemory).toBe(25);
    expect(parsed.defaultAgentId).toBe("kilo");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("clamps out-of-range numbers and falls back on garbage", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-settings-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ values: { historyPerMemory: 9999 } }));
    expect(parseSettingsFile(file).historyPerMemory).toBe(200);
    fs.writeFileSync(file, "{ not json");
    expect(parseSettingsFile(file).mcpServerName).toBe("memory-flash");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
