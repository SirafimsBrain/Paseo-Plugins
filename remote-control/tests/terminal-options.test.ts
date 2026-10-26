import { describe, expect, it } from "vitest";
import { ghosttySettingsToTerminalOptions } from "../shared/terminal-options";
import type { GhosttySettings } from "../shared/ghostty-settings";

describe("ghostty settings → terminal options (stage B2)", () => {
  it("maps every supported field", () => {
    const settings: GhosttySettings = {
      fontFamily: "JetBrains Mono",
      fontSize: 13.5,
      scrollback: 5000,
      cursorBlink: false,
      cursorStyle: "bar",
      cursorColor: "#f5e0dc",
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      palette: ["0=#45475a", "1=#f38ba8", "15=#ffffff"],
    };
    const options = ghosttySettingsToTerminalOptions(settings);
    expect(options.fontFamily).toBe("JetBrains Mono");
    expect(options.fontSize).toBe(13.5);
    expect(options.scrollback).toBe(5000);
    expect(options.cursorBlink).toBe(false);
    expect(options.cursorStyle).toBe("bar");
    expect(options.theme?.background).toBe("#1e1e2e");
    expect(options.theme?.foreground).toBe("#cdd6f4");
    expect(options.theme?.cursor).toBe("#f5e0dc");
    expect(options.theme?.black).toBe("#45475a");
    expect(options.theme?.red).toBe("#f38ba8");
    expect(options.theme?.brightWhite).toBe("#ffffff");
  });

  it("yields an empty object for empty settings", () => {
    expect(ghosttySettingsToTerminalOptions({})).toEqual({});
  });

  it("ignores malformed palette entries", () => {
    const options = ghosttySettingsToTerminalOptions({
      palette: ["not-a-palette", "99=#fff", "2=#abc"],
    });
    expect(options.theme?.green).toBe("#abc");
    expect(options.theme?.black).toBeUndefined();
  });

  it("does not emit an empty theme", () => {
    expect(ghosttySettingsToTerminalOptions({ fontFamily: "mono" }).theme).toBeUndefined();
  });
});