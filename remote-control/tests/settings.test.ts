// Stage 0.25.11 (G2): plugin settings — defaults, validation, persistence.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../server/store";
import { loadSettings, saveSettings, validateSettingsPatch } from "../server/settings";

let dir: string;
let store: Store;

const DEFAULTS = { storeDir: "/home/test/.paseo/pass-store" };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "remote-control-settings-"));
  store = new Store({ dbPath: path.join(dir, "store.db") });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("settings", () => {
  it("returns the documented defaults on an empty store", () => {
    expect(loadSettings(store, DEFAULTS)).toEqual({
      consolePort: 0,
      autoLockMinutes: 0,
      storeDir: DEFAULTS.storeDir,
      rdpBinary: "",
      vncBinary: "",
    });
  });

  it("round-trips every field through the store", () => {
    const next = saveSettings(store, {
      consolePort: 7788,
      autoLockMinutes: 15,
      storeDir: "/srv/pass",
      rdpBinary: "/usr/local/bin/xfreerdp3",
      vncBinary: "vncviewer",
    });
    expect(loadSettings(store, DEFAULTS)).toEqual(next);
  });

  it("ignores a corrupted stored value instead of crashing", () => {
    store.setSetting("consolePort", "not-a-number");
    store.setSetting("autoLockMinutes", "-3");
    expect(loadSettings(store, DEFAULTS).consolePort).toBe(0);
    expect(loadSettings(store, DEFAULTS).autoLockMinutes).toBe(0);
  });

  it("validates a patch and refuses unknown keys", () => {
    const current = loadSettings(store, DEFAULTS);
    expect(validateSettingsPatch(current, { consolePort: 8080 }).consolePort).toBe(8080);
    expect(() => validateSettingsPatch(current, { consolePort: 70000 })).toThrow(/between 0 and 65535/);
    expect(() => validateSettingsPatch(current, { consolePort: 1.5 })).toThrow(/integer/);
    expect(() => validateSettingsPatch(current, { autoLockMinutes: 1441 })).toThrow(/between 0 and 1440/);
    expect(() => validateSettingsPatch(current, { storeDir: "relative/pass" })).toThrow(/absolute path/);
    expect(() => validateSettingsPatch(current, { storeDir: "  " })).toThrow(/must not be empty/);
    expect(() => validateSettingsPatch(current, { rdpBinary: "a\nb" })).toThrow(/single path/);
    expect(() => validateSettingsPatch(current, { nope: true })).toThrow(/unknown setting/);
    expect(() => validateSettingsPatch(current, [])).toThrow(/must be an object/);
  });

  it("expands ~ in the store directory", () => {
    const current = loadSettings(store, DEFAULTS);
    expect(validateSettingsPatch(current, { storeDir: "~/pass-store" }).storeDir).toBe(
      path.join(os.homedir(), "pass-store"),
    );
  });

  it("leaves fields the patch does not mention alone", () => {
    const current = loadSettings(store, DEFAULTS);
    const next = validateSettingsPatch(current, { autoLockMinutes: 5 });
    expect(next.autoLockMinutes).toBe(5);
    expect(next.consolePort).toBe(current.consolePort);
    expect(next.storeDir).toBe(current.storeDir);
  });
});
