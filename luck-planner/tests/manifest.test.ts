import { existsSync, readFileSync } from "node:fs";
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
  build?: unknown;
  mcp?: { entry?: unknown };
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

  it("versions as MAJOR.MINOR.PATCH", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // Stage D2: the daemon runs `build` without a shell — each step must be
  // an argv array. A flat "npm run bundle" string fails manifest validation
  // ("expected array, received string" at build[0]) and the plugin shows as
  // failed (memory-flash lesson, __doc.md §6).
  it("declares build steps as non-empty string arrays", () => {
    expect(Array.isArray(manifest.build)).toBe(true);
    const steps = manifest.build as unknown[];
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(Array.isArray(step)).toBe(true);
      const argv = step as unknown[];
      expect(argv.length).toBeGreaterThan(0);
      for (const arg of argv) expect(typeof arg).toBe("string");
    }
    // The bundle step must exist — agents spawn dist/mcp-server.js.
    expect(steps).toContainEqual(["npm", "run", "bundle"]);
  });

  it("declares an MCP entry that the bundle step produces", () => {
    expect(manifest.mcp?.entry).toBe("dist/mcp-server.js");
    // `pretest` bundles before every suite; a raw `vitest run` on a fresh
    // checkout needs `npm run bundle` first (same precondition as the e2e
    // spawn test).
    expect(existsSync(join(root, "dist", "mcp-server.js"))).toBe(true);
  });
});
