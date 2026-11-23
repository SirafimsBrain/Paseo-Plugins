import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bridgeDataDir,
  bridgeHome,
  indexPathFor,
  isStandaloneBridge,
  pluginDataDir,
  settingsMirrorPath,
} from "../server/paths";

/**
 * A standalone installation chooses its root through `OBSIDIAN_BRIDGE_HOME`
 * (0.23.18). Everything this module places on disk follows it, and an install
 * without the variable keeps the Paseo locations unchanged.
 */

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("standalone bridge home", () => {
  it("moves the settings, data and index under OBSIDIAN_BRIDGE_HOME", () => {
    const home = tempDir("ob-standalone-");
    vi.stubEnv("OBSIDIAN_BRIDGE_HOME", home);

    expect(isStandaloneBridge()).toBe(true);
    expect(bridgeHome()).toBe(path.resolve(home));
    expect(settingsMirrorPath()).toBe(path.join(path.resolve(home), "settings.json"));
    expect(bridgeDataDir()).toBe(path.join(path.resolve(home), "data"));
    expect(indexPathFor("/vault/notes")).toContain(path.join(path.resolve(home), "data", "vaults"));
  });

  it("keeps the Paseo locations when the variable is unset", () => {
    const paseo = tempDir("ob-paseo-");
    vi.stubEnv("PASEO_HOME", paseo);
    vi.stubEnv("OBSIDIAN_BRIDGE_HOME", "");

    expect(isStandaloneBridge()).toBe(false);
    expect(bridgeHome()).toBe(pluginDataDir());
    expect(bridgeDataDir()).toBe(pluginDataDir());
    expect(settingsMirrorPath()).toBe(path.join(paseo, "plugins", "obsidian-bridge", "settings.json"));
    expect(indexPathFor("/vault/notes")).toContain(path.join(paseo, "plugins", "obsidian-bridge"));
  });
});
