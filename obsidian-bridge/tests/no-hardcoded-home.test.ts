import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * A developer's home directory must never leak into the shipped code: the
 * plugin runs on other machines, and the same bundle is installed by the
 * release workflow for every user. Home-relative locations are resolved at run
 * time instead — `os.homedir()`, `$HOME`/`$PASEO_HOME`/`$OBSIDIAN_BRIDGE_HOME`,
 * or a `~/…` value handed to `resolveVaultRoot`.
 *
 * The scan covers the three directories that end up in the plugin bundle and the
 * standalone MCP server. Tests, fixtures, documentation and the client's string
 * copy are not part of it, so a fixture may still name a synthetic home.
 */

const root = path.resolve(__dirname, "..");
const SOURCE_DIRS = ["server", "shared", "client"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]);

/**
 * `/home/<name>` with a literal name. A template (`/home/${user}`) or a value
 * that is only a comment placeholder for documentation is still a literal path
 * in the source, so it is reported as well — the fix is `~/…` or `os.homedir()`.
 */
const HARDCODED_HOME = /\/home\/([A-Za-z0-9._-]+)/g;

/** Matches with their 1-based line number, for a readable failure message. */
export function findHardcodedHome(text: string): Array<{ line: number; match: string }> {
  const found: Array<{ line: number; match: string }> = [];
  text.split("\n").forEach((content, index) => {
    for (const match of content.matchAll(HARDCODED_HOME)) {
      found.push({ line: index + 1, match: match[0] });
    }
  });
  return found;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...walk(full));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

describe("home paths", () => {
  it("detects a literal home path and leaves a resolved one alone", () => {
    expect(findHardcodedHome('const vault = "/home/alice/.obsidian/Main/Paseo";')).toEqual([
      { line: 1, match: "/home/alice" },
    ]);
    expect(findHardcodedHome("const vault = path.join(os.homedir(), '.obsidian');")).toEqual([]);
    expect(findHardcodedHome('resolveVaultRoot("~/.obsidian/Main/Paseo")')).toEqual([]);
    expect(findHardcodedHome('placeholder="~/.obsidian/Main/Paseo"')).toEqual([]);
    // `$HOME` in the installer and `/home` as part of another word are not hits.
    expect(findHardcodedHome('dir="${HOME}/.agents"')).toEqual([]);
    expect(findHardcodedHome("// see /homes/example")).toEqual([]);
  });

  it("keeps /home/<name> out of server, shared and client", () => {
    const offenders: string[] = [];
    for (const dir of SOURCE_DIRS) {
      const absolute = path.join(root, dir);
      if (!fs.existsSync(absolute)) continue;
      for (const file of walk(absolute)) {
        const text = fs.readFileSync(file, "utf-8");
        for (const hit of findHardcodedHome(text)) {
          offenders.push(`${path.relative(root, file)}:${hit.line}: ${hit.match}`);
        }
      }
    }
    // Resolve the home directory instead of naming one: `os.homedir()`,
    // `$HOME`, `$PASEO_HOME`, `$OBSIDIAN_BRIDGE_HOME`, or a `~/…` value.
    expect(offenders).toEqual([]);
  });
});
