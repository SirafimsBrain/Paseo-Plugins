import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The installer names the release it belongs to (0.24.21).
 *
 * A copy fetched from `…/obsidian-bridge@<tag>/obsidian-bridge-install.sh`
 * builds `obsidian-bridge@SCRIPT_VERSION`, so this value has to be the version
 * of the commit that carries it. The release workflow refuses a mismatched tag;
 * this test fails earlier, on the commit that forgot to bump one of the two.
 */

const root = path.resolve(__dirname, "..");
const installer = fs.readFileSync(path.join(root, "obsidian-bridge-install.sh"), "utf-8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as { version: string };

function scriptVersion(body: string): string | null {
  const match = /^SCRIPT_VERSION="([^"]+)"$/m.exec(body);
  return match?.[1] ?? null;
}

describe("installer release pin", () => {
  it("names the version in package.json", () => {
    expect(scriptVersion(installer)).toBe(pkg.version);
  });

  it("defaults to its own tag instead of main", () => {
    expect(installer).toContain('ref="obsidian-bridge@$SCRIPT_VERSION"');
    expect(installer).not.toContain('${ref:-main}');
  });
});
