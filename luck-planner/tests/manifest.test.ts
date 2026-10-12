import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = join(__dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "paseo-plugin.json"), "utf8"),
) as {
  id: string;
  description: string;
  requirements: { paseo: string };
};
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
};

/**
 * Stage A1 of PLAN.md: the scaffold must satisfy the SDK manifest contract
 * before any code lands. IDs must start with a lowercase letter and contain
 * only lowercase letters, numbers, or hyphens; an omitted or malformed
 * `requirements.paseo` range makes the daemon reject or silently mis-check
 * the plugin.
 */
describe("plugin manifest", () => {
  it("uses an SDK-valid plugin id", () => {
    expect(manifest.id).toBe("luck-planner");
    expect(manifest.id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("declares a Paseo requirement range", () => {
    expect(manifest.requirements.paseo).toMatch(
      /^(>=|\^|~)?\d+\.\d+\.\d+( <\d+\.\d+\.\d+)?$/,
    );
  });

  it("carries a description for Settings → Plugins", () => {
    expect(manifest.description.trim().length).toBeGreaterThan(0);
  });

  it("starts at the planned A1 version", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).toBe("0.1.0");
  });
});
