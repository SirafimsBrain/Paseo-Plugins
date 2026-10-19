/**
 * The plugin's README and the link from the repository root (PLAN.md stage J1).
 *
 * The acceptance of this stage is a *documentation* acceptance, and the repo's
 * rule is that a stage is only done when it is pinned by something that can
 * fail:
 *
 * 1. **The plugin README exists and is English** — the project rule says the
 *    per-plugin README and `__doc.md` are maintained in English only, while
 *    `PLAN.md` stays in the working language of the repository. A Cyrillic
 *    character in the wrong file is a rule violation, and the check is a
 *    regex.
 * 2. **The README is about *this* plugin** — it names every MCP tool the
 *    plugin actually exposes (the list comes from the code, not from a copy
 *    in the prose), the install command, the settings and the dashboard. A
 *    tool that is added later and forgotten in the README fails here.
 * 3. **The link from the root README works** — the repository README points
 *    at `./luck-planner/README.md`, the target exists, and every *relative*
 *    link in both READMEs resolves to a file on disk. A moved file or a
 *    renamed directory would otherwise leave a dead link in the project's
 *    front page.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "../shared/tools";

const ROOT = path.join(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.join(ROOT, "..");
const PLUGIN_README = path.join(ROOT, "README.md");
const PLUGIN_DOC = path.join(ROOT, "__doc.md");
const REPO_README = path.join(REPO_ROOT, "README.md");

/** Cyrillic (and the CJK range the plugin's documents must not use). */
const NON_LATIN = /[\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF]/;

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** The markdown links of a document that point at a local file. */
function localLinks(markdown: string): string[] {
  const links: string[] = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let match = pattern.exec(markdown);
  while (match !== null) {
    const target = match[1] ?? "";
    // Skip external links, anchors and mail addresses.
    if (
      !target.startsWith("http://") &&
      !target.startsWith("https://") &&
      !target.startsWith("#") &&
      !target.startsWith("mailto:") &&
      !target.startsWith("`")
    ) {
      links.push(target);
    }
    match = pattern.exec(markdown);
  }
  return links;
}

describe("J1: the plugin README", () => {
  it("exists and is not a stub", () => {
    expect(fs.existsSync(PLUGIN_README), "luck-planner/README.md").toBe(true);
    const text = read(PLUGIN_README);
    expect(text.length).toBeGreaterThan(2000);
    expect(text).toContain("# Luck Planner");
  });

  it("is written in English, like the technical document", () => {
    // The project rule: the README and __doc.md are English only; PLAN.md is
    // the Russian working plan and is not checked here.
    expect(NON_LATIN.test(read(PLUGIN_README))).toBe(false);
    expect(NON_LATIN.test(read(PLUGIN_DOC))).toBe(false);
  });

  it("names every MCP tool the plugin exposes", () => {
    const text = read(PLUGIN_README);
    for (const tool of MCP_TOOL_NAMES) {
      expect(text, tool).toContain(tool);
    }
  });

  it("documents the install, the dashboard and the settings", () => {
    const text = read(PLUGIN_README);
    expect(text).toContain(
      "paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:luck-planner",
    );
    expect(text).toContain("dashboard");
    expect(text).toContain("injectIntoAgents");
    expect(text).toContain("historyRetentionDays");
    // The two views and the fallback are the plugin's headline.
    expect(text).toContain("2D");
    expect(text).toContain("3D");
    expect(text).toContain("WebGL");
  });

  it("links only to files that exist", () => {
    for (const target of localLinks(read(PLUGIN_README))) {
      const file = path.resolve(ROOT, target.split("#")[0] ?? target);
      expect(fs.existsSync(file), `${target} (from luck-planner/README.md)`).toBe(true);
    }
  });
});

describe("J1: the link from the repository README", () => {
  it("lists the plugin in the Plugins section", () => {
    const text = read(REPO_README);
    const plugins = text.slice(
      text.indexOf("## Plugins"),
      text.indexOf("## Installation"),
    );
    expect(plugins).toContain("./luck-planner/README.md");
  });

  it("shows the install command and the build step", () => {
    const text = read(REPO_README);
    expect(text).toContain(
      "paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:luck-planner",
    );
    const table = text.slice(text.indexOf("| Plugin | Install-time"), text.indexOf("## Versioning"));
    expect(table).toContain("[luck-planner](./luck-planner/README.md)");
  });

  it("resolves every relative link of the repository README", () => {
    for (const target of localLinks(read(REPO_README))) {
      const file = path.resolve(REPO_ROOT, target.split("#")[0] ?? target);
      expect(fs.existsSync(file), `${target} (from README.md)`).toBe(true);
    }
  });
});
