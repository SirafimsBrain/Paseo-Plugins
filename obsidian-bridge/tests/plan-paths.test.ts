import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_ROOT,
  isPlanSystemPath,
  normalizePlanPath,
  resolvePlanPath,
  resolvePlanRoot,
  type PlanRoot,
} from "../server/plan/paths";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

/**
 * The planning boundary: `planRoot` is a directory inside the vault, and every
 * `plan_*` path is resolved by the same ladder as an `obsidian_*` path. These
 * tests use the real filesystem, because the point is what `realpath` and
 * `stat` do — a mocked boundary would prove nothing.
 */

const workspaces: TestWorkspace[] = [];

function workspace(notes: Record<string, string> = {}): TestWorkspace {
  const created = makeWorkspace(notes);
  workspaces.push(created);
  return created;
}

function planRootOf(settings: ReturnType<typeof runtimeSettings>): PlanRoot {
  const resolved = resolvePlanRoot(settings);
  if (!("root" in resolved)) throw new Error(`expected a planning root: ${resolved.error}`);
  return resolved.root;
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

describe("resolvePlanRoot", () => {
  it("reports an unconfigured vault instead of guessing a root", () => {
    const resolved = resolvePlanRoot(runtimeSettings(""));
    expect("reason" in resolved).toBe(true);
    if ("reason" in resolved) {
      expect(resolved.reason).toBe("not_configured");
      expect(resolved.error).toContain("Obsidian directory is not configured");
    }
  });

  it("treats an empty planRoot as the default directory", () => {
    const created = workspace({ "Workspaces/centurion/centurion.md": "# Centurion\n" });
    const resolved = resolvePlanRoot(runtimeSettings(created.vault, { planRoot: "  " }));
    expect("root" in resolved && resolved.root.relPath).toBe(DEFAULT_PLAN_ROOT);
  });

  it("creates a missing planning directory", () => {
    const created = workspace({ "A.md": "# A\n" });
    const resolved = resolvePlanRoot(runtimeSettings(created.vault, { planRoot: "  " }));
    expect("root" in resolved).toBe(true);
    if ("root" in resolved) {
      expect(resolved.root.relPath).toBe(DEFAULT_PLAN_ROOT);
      expect(fs.existsSync(path.join(created.vault, resolved.root.relPath))).toBe(true);
    }
  });

  it("resolves the default directory inside the vault", () => {
    const created = workspace({ "Workspaces/centurion/centurion.md": "# Centurion\n" });
    const root = planRootOf(runtimeSettings(created.vault));
    expect(root.relPath).toBe("Workspaces");
    expect(root.absolute).toBe(fs.realpathSync(path.join(created.vault, "Workspaces")));
    expect(root.vaultRoot).toBe(created.vault);
  });

  it("accepts a nested planning directory", () => {
    const created = workspace({ "Projects/Plans/one/one.md": "# One\n" });
    const root = planRootOf(runtimeSettings(created.vault, { planRoot: "Projects/Plans" }));
    expect(root.relPath).toBe("Projects/Plans");
    expect(fs.existsSync(root.absolute)).toBe(true);
  });

  it.each(["../outside", "/etc", ".obsidian/plans", "Workspaces/../../outside"])(
    "refuses '%s' as a planning directory",
    (planRoot) => {
      const created = workspace({ "Workspaces/centurion/centurion.md": "# Centurion\n" });
      const resolved = resolvePlanRoot(runtimeSettings(created.vault, { planRoot }));
      expect("reason" in resolved && resolved.reason).toBe("invalid");
    },
  );

  it("refuses a planning directory that is a file", () => {
    const created = workspace({ "Workspaces.md": "# Not a folder\n" });
    const resolved = resolvePlanRoot(runtimeSettings(created.vault, { planRoot: "Workspaces.md" }));
    expect("reason" in resolved && resolved.reason).toBe("missing");
  });
});

describe("resolvePlanPath", () => {
  it("returns the vault path of a node document", () => {
    const created = workspace({ "Workspaces/centurion/centurion.md": "# Centurion\n" });
    const root = planRootOf(runtimeSettings(created.vault));
    const resolved = resolvePlanPath(root, "centurion/centurion.md");
    if ("error" in resolved) throw new Error(resolved.error);
    expect(resolved.relPath).toBe("centurion/centurion.md");
    expect(resolved.vaultPath).toBe("Workspaces/centurion/centurion.md");
    expect(resolved.absolute).toBe(path.join(created.vault, "Workspaces/centurion/centurion.md"));
  });

  it("accepts a document that does not exist yet, but only inside the root", () => {
    const created = workspace({ "Workspaces/centurion/centurion.md": "# Centurion\n" });
    const root = planRootOf(runtimeSettings(created.vault));
    const resolved = resolvePlanPath(root, "centurion/backend/auth.md");
    if ("error" in resolved) throw new Error(resolved.error);
    expect(resolved.vaultPath).toBe("Workspaces/centurion/backend/auth.md");
  });

  it.each(["../centurion.md", "/etc/passwd", "", "   ", "a/../../b.md", ".obsidian/app.json"])(
    "refuses '%s'",
    (value) => {
      const created = workspace({ "Workspaces/centurion/centurion.md": "# Centurion\n" });
      const root = planRootOf(runtimeSettings(created.vault));
      const resolved = resolvePlanPath(root, value);
      expect("error" in resolved).toBe(true);
    },
  );

  it("refuses a symlink that leads out of the planning root", () => {
    const created = workspace({ "Workspaces/centurion/centurion.md": "# Centurion\n" });
    const outside = path.join(path.dirname(created.vault), "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.md"), "# Secret\n", "utf-8");
    fs.symlinkSync(path.join("..", "..", "outside"), path.join(created.vault, "Workspaces", "link"));

    const root = planRootOf(runtimeSettings(created.vault));
    const resolved = resolvePlanPath(root, "link/secret.md");
    expect("error" in resolved).toBe(true);
    // Either boundary catches it — the planning root's own check or the vault's
    // realpath check — and both are refusals of the same escape.
    if ("error" in resolved) expect(resolved.error).toMatch(/outside the (planning directory|configured vault)/);
  });

  it("refuses a symlinked planning directory that leads out of the vault", () => {
    const created = workspace({ "A.md": "# A\n" });
    const outside = path.join(path.dirname(created.vault), "outside-workspaces");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(created.vault, "Workspaces"));

    const resolved = resolvePlanRoot(runtimeSettings(created.vault));
    expect("reason" in resolved && resolved.reason).toBe("invalid");
  });
});

describe("path helpers", () => {
  it("normalizes a planning path without collapsing traversal silently", () => {
    expect(normalizePlanPath("./centurion//centurion.md")).toBe("centurion/centurion.md");
    expect(normalizePlanPath("centurion/../frontend")).toBeNull();
    expect(normalizePlanPath(".obsidian/app.json")).toBeNull();
    expect(normalizePlanPath("centurion/note\u0000.md")).toBeNull();
  });

  it("recognizes history and archive segments, and nothing that merely resembles them", () => {
    expect(isPlanSystemPath("Workspaces/centurion/__history/auth.v1.r2.md")).toBe(true);
    expect(isPlanSystemPath("Workspaces/_archive/old/old.md")).toBe(true);
    expect(isPlanSystemPath("Workspaces/centurion/__history-notes.md")).toBe(false);
    expect(isPlanSystemPath("Workspaces/centurion/centurion.md")).toBe(false);
  });
});
