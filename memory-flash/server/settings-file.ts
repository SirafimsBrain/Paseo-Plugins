import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryFlashSettings } from "../shared/settings";

/**
 * Reads the plugin's persisted settings for the MCP server process.
 *
 * The MCP server is spawned by agent providers (outside the plugin host), so
 * it cannot receive settings through the SDK. It therefore reads the same
 * JSON file the host writes for `registerSettings`:
 * `$PASEO_HOME/plugins/memory-flash/settings.json`. Missing or invalid files
 * fall back to the schema defaults.
 */

export interface ParsedSettings {
  mcpServerName: string;
  historyPerMemory: number;
  defaultAgentId: string;
}

const DEFAULTS: ParsedSettings = {
  mcpServerName: "memory-flash",
  historyPerMemory: 50,
  defaultAgentId: "",
};

function settingsFilePath(): string {
  const configured = process.env.PASEO_HOME;
  const home = configured && configured.trim().length > 0 ? configured : path.join(os.homedir(), ".paseo");
  return path.join(home, "plugins", "memory-flash", "settings.json");
}

export function parseSettingsFile(filePath: string = settingsFilePath()): ParsedSettings {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (typeof raw !== "object" || raw === null) return DEFAULTS;
    const record = raw as Record<string, unknown>;
    const values = (typeof record.values === "object" && record.values !== null ? record.values : record) as Record<string, unknown>;
    const mcpServerName =
      typeof values.mcpServerName === "string" && values.mcpServerName.trim().length > 0
        ? values.mcpServerName.trim().slice(0, 60)
        : DEFAULTS.mcpServerName;
    const historyPerMemory =
      typeof values.historyPerMemory === "number" && Number.isFinite(values.historyPerMemory)
        ? Math.max(10, Math.min(200, Math.trunc(values.historyPerMemory)))
        : DEFAULTS.historyPerMemory;
    const defaultAgentId =
      typeof values.defaultAgentId === "string" ? values.defaultAgentId.trim().slice(0, 120) : DEFAULTS.defaultAgentId;
    const parsed: MemoryFlashSettings = { injectIntoAgents: true, mcpServerName, historyPerMemory, defaultAgentId };
    return { mcpServerName: parsed.mcpServerName, historyPerMemory: parsed.historyPerMemory, defaultAgentId: parsed.defaultAgentId };
  } catch {
    return DEFAULTS;
  }
}
