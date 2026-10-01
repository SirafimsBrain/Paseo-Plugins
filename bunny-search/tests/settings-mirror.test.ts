import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSettingsMirror } from "../server/settings-mirror";
import { parseSettingsFile } from "../server/settings-file";

/**
 * The host writes the mirror (`writeSettingsMirror`), the
 * spawned MCP server process reads it back
 * (`parseSettingsFile`). These tests cover the round-trip
 * that keeps agents on the user's configuration.
 */

const directories: string[] = [];

function tempSettingsFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunny-mirror-"));
  directories.push(dir);
  return path.join(dir, "settings.json");
}

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("settings mirror round-trip", () => {
  it("writes a file the MCP server reads back", () => {
    const filePath = tempSettingsFile();
    writeSettingsMirror(
      {
        injectIntoAgents: true,
        mcpServerName: "bunny-search",
        searchService: "searxng",
        searxngBaseUrl: "http://omnirouter/search",
        customBaseUrl: "",
        apiKey: "secret",
        timeoutMs: 15000,
        maxResults: 20,
        categories: "general,web",
        language: "ru",
        searchUiUrl: "http://omnirouter",
      },
      filePath,
      "2026-10-01T00:00:00.000Z",
    );
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw.revision).toBe("2026-10-01T00:00:00.000Z");

    const settings = parseSettingsFile(filePath);
    expect(settings.searxngBaseUrl).toBe("http://omnirouter/search");
    expect(settings.timeoutMs).toBe(15000);
    expect(settings.maxResults).toBe(20);
    expect(settings.language).toBe("ru");
    expect(settings.apiKey).toBe("secret");
  });

  it("creates missing parent directories", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunny-mirror-"));
    directories.push(dir);
    const filePath = path.join(dir, "nested", "bunny-search", "settings.json");
    writeSettingsMirror({ searchService: "duckduckgo" }, filePath);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(parseSettingsFile(filePath).searchService).toBe("duckduckgo");
  });

  it("replaces the previous mirror atomically", () => {
    const filePath = tempSettingsFile();
    writeSettingsMirror({ searxngBaseUrl: "http://first/search" }, filePath);
    writeSettingsMirror({ searxngBaseUrl: "http://second/search" }, filePath);
    expect(parseSettingsFile(filePath).searxngBaseUrl).toBe("http://second/search");
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
  });
});
