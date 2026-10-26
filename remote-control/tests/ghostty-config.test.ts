import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverGhosttyConfigPaths,
  findGhosttyConfigPath,
  mapGhosttySettings,
  parseGhosttyConfig,
  previewGhosttyImport,
} from "../server/ghostty-config";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-ghostty-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(relative: string, content: string): string {
  const full = path.join(tmp, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

describe("discovery", () => {
  it("returns null when no config exists", () => {
    expect(findGhosttyConfigPath({ homeDir: tmp, xdgConfigHome: path.join(tmp, "xdg") })).toBeNull();
  });

  it("finds the config under XDG_CONFIG_HOME first", () => {
    const xdg = path.join(tmp, "xdg");
    const configPath = writeFile("xdg/ghostty/config", "font-size = 14\n");
    // writeFile created under tmp/xdg/ghostty/config; align xdg root
    const xdgRoot = path.join(tmp, "xdg");
    fs.mkdirSync(path.join(xdgRoot, "ghostty"), { recursive: true });
    fs.writeFileSync(path.join(xdgRoot, "ghostty", "config"), "font-size = 14\n");
    const found = findGhosttyConfigPath({ homeDir: tmp, xdgConfigHome: xdgRoot });
    expect(found).toBe(path.join(xdgRoot, "ghostty", "config"));
  });

  it("falls back to ~/.config/ghostty/config", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".config", "ghostty"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "ghostty", "config"), "font-size = 12\n");
    const found = findGhosttyConfigPath({ homeDir: home });
    expect(found).toBe(path.join(home, ".config", "ghostty", "config"));
  });

  it("preview reports found=false when nothing is installed", () => {
    const preview = previewGhosttyImport({ homeDir: tmp, xdgConfigHome: path.join(tmp, "nope") });
    expect(preview.found).toBe(false);
    expect(preview.path).toBeNull();
    expect(preview.settings).toEqual({});
    expect(preview.ignored).toEqual([]);
  });
});

describe("parser", () => {
  it("parses comments, blank lines and both separators", () => {
    const file = writeFile("config", [
      "# top comment",
      "",
      "font-family = JetBrains Mono",
      "font-size=13",
      "  cursor-blink = true  ",
      "// trailing",
      "theme = catppuccin",
    ].join("\n"));
    const parsed = parseGhosttyConfig(file);
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries.map((e) => e.key)).toEqual([
      "font-family",
      "font-size",
      "cursor-blink",
      "theme",
    ]);
    expect(parsed.entries[1].value).toBe("13");
  });

  it("follows config-file includes (relative)", () => {
    writeFile("inc.conf", "background = #1e1e2e\n");
    const main = writeFile("config", "font-size = 11\nconfig-file = inc.conf\n");
    const parsed = parseGhosttyConfig(main);
    expect(parsed.entries.map((e) => e.key)).toEqual(["font-size", "background"]);
  });

  it("guards against include cycles", () => {
    writeFile("a.conf", "config-file = b.conf\n");
    writeFile("b.conf", "config-file = a.conf\n");
    const parsed = parseGhosttyConfig(path.join(tmp, "a.conf"));
    expect(parsed.errors.some((e) => /cycle/i.test(e))).toBe(true);
  });

  it("reports malformed lines as errors without dropping the rest", () => {
    const file = writeFile("config", "font-size = 12\nthis is not a pair\ntheme = x\n");
    const parsed = parseGhosttyConfig(file);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.entries.map((e) => e.key)).toEqual(["font-size", "theme"]);
  });
});

describe("mapper", () => {
  it("maps supported keys onto typed settings", () => {
    const entries = parseGhosttyConfig(
      writeFile("config", [
        "font-family = JetBrains Mono",
        "font-size = 13.5",
        "theme = catppuccin-mocha",
        "background = #1e1e2e",
        "foreground = #cdd6f4",
        "cursor-style = bar",
        "cursor-blink = false",
        "cursor-color = #f5e0dc",
        "scrollback-limit = 10000",
        "window-padding-x = 8",
        "window-padding-y = 4",
        "palette = 0=#45475a",
        "palette = 1=#f38ba8",
      ].join("\n")),
    ).entries;
    const { settings, ignored } = mapGhosttySettings(entries);
    expect(settings.fontFamily).toBe("JetBrains Mono");
    expect(settings.fontSize).toBe(13.5);
    expect(settings.theme).toBe("catppuccin-mocha");
    expect(settings.background).toBe("#1e1e2e");
    expect(settings.foreground).toBe("#cdd6f4");
    expect(settings.cursorStyle).toBe("bar");
    expect(settings.cursorBlink).toBe(false);
    expect(settings.cursorColor).toBe("#f5e0dc");
    expect(settings.scrollback).toBe(10000);
    expect(settings.windowPadding).toEqual({ left: 8, right: 8, top: 4, bottom: 4 });
    expect(settings.palette).toEqual(["0=#45475a", "1=#f38ba8"]);
    expect(ignored).toEqual([]);
  });

  it("puts unsupported keys into the ignored list (none lost)", () => {
    const entries = parseGhosttyConfig(
      writeFile("config", [
        "font-size = 12",
        "window-padding-color = cell",
        "window-padding-balance = true",
        "selection-word-chars = abc",
        "totally-unknown-key = 42",
      ].join("\n")),
    ).entries;
    const { settings, ignored } = mapGhosttySettings(entries);
    expect(settings.fontSize).toBe(12);
    expect(ignored).toContain("window-padding-color");
    expect(ignored).toContain("window-padding-balance");
    expect(ignored).toContain("selection-word-chars");
    expect(ignored).toContain("totally-unknown-key");
    // de-duplicated
    expect(new Set(ignored).size).toBe(ignored.length);
  });

  it("end-to-end preview reports found=true with settings+ignored", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".config", "ghostty"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".config", "ghostty", "config"),
      "font-size = 10\nmystery = 1\n",
    );
    const preview = previewGhosttyImport({ homeDir: home });
    expect(preview.found).toBe(true);
    expect(preview.settings.fontSize).toBe(10);
    expect(preview.ignored).toContain("mystery");
  });
});