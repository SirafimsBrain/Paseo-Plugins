import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The installer's command-line contract, exercised as a user's shell runs it.
 *
 * These cases do not build the bundle: `--dry-run`, `--help`, argument
 * validation and `--uninstall` are enough to catch the exit-status and safety
 * regressions that a full install would hide behind a long npm step.
 */

const root = path.resolve(__dirname, "..");
const installer = path.join(root, "obsidian-bridge-install.sh");
const homes: string[] = [];

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ob-installer-"));
  homes.push(home);
  return home;
}

function run(args: string[], home: string, cwd = root) {
  return spawnSync("bash", [installer, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, HOME: home, OBSIDIAN_BRIDGE_HOME: undefined },
  });
}

function makeInstall(home: string): string {
  const dir = path.join(home, ".agents", "obsidian-bridge-mcp");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "mcp-server.js"), "// test\n", "utf-8");
  fs.writeFileSync(path.join(dir, "install.json"), JSON.stringify({ version: "0.0.0" }) + "\n", "utf-8");
  return dir;
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("standalone installer", () => {
  it("prints help and exits successfully", () => {
    const result = run(["--help"], tempHome());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--with-planning-skills");
  });

  it("exits successfully from --dry-run and changes nothing", () => {
    const home = tempHome();
    const result = run(["--source", root, "--dry-run"], home);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Plan: build the bundle");
    expect(fs.existsSync(path.join(home, ".agents", "obsidian-bridge-mcp"))).toBe(false);
  });

  it("resolves a relative --dir before printing the client block", () => {
    const home = tempHome();
    const cwd = fs.mkdtempSync(path.join(home, "cwd-"));
    const result = run(["--source", root, "--dry-run", "--dir", "relative-install"], home, cwd);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(path.join(cwd, "relative-install"));
  });

  it("rejects --source together with --ref and --with-semantic", () => {
    const home = tempHome();
    expect(run(["--source", root, "--ref", "main", "--dry-run"], home).status).not.toBe(0);
    const semantic = run(["--source", root, "--with-semantic", "--dry-run"], home);
    expect(semantic.status).not.toBe(0);
    expect(semantic.stderr).toContain("semantic search is built by the Paseo plugin");
  });

  it("accepts --no-semantic for scripts written for 0.23.x–0.24.x", () => {
    const result = run(["--source", root, "--no-semantic", "--dry-run"], tempHome());
    expect(result.status).toBe(0);
  });

  it("keeps the skills root recorded by the first install", () => {
    const home = tempHome();
    const dir = makeInstall(home);
    const custom = path.join(home, "custom-skills");
    fs.writeFileSync(
      path.join(dir, "install.json"),
      JSON.stringify({ version: "0.0.0", skillsDir: custom }) + "\n",
      "utf-8",
    );

    // An update without --skills-dir must reuse the recorded root instead of
    // installing a second copy into ~/.agents/skills.
    const update = run(["--source", root, "--dry-run"], home);
    expect(update.status).toBe(0);
    expect(update.stdout).toContain(`install skills into ${custom}`);

    // An explicit --skills-dir still wins.
    const override = path.join(home, "other-skills");
    const explicit = run(["--source", root, "--dry-run", "--skills-dir", override], home);
    expect(explicit.stdout).toContain(`install skills into ${override}`);
  });

  it("uninstalls the skills of the recorded root", () => {
    const home = tempHome();
    const dir = makeInstall(home);
    const custom = path.join(home, "custom-skills");
    fs.mkdirSync(path.join(custom, "obsidian-bridge"), { recursive: true });
    fs.writeFileSync(
      path.join(custom, "obsidian-bridge", "SKILL.md"),
      "---\ninstalled-by: obsidian-bridge\n---\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(dir, "installed-skills.txt"), "obsidian-bridge\n", "utf-8");
    fs.writeFileSync(
      path.join(dir, "install.json"),
      JSON.stringify({ version: "0.0.0", skillsDir: custom }) + "\n",
      "utf-8",
    );

    const result = run(["--uninstall"], home);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(custom, "obsidian-bridge"))).toBe(false);
  });

  it("uninstalls an installation and exits successfully", () => {
    const home = tempHome();
    const dir = makeInstall(home);
    const result = run(["--uninstall"], home);
    expect(result.status).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses to delete a directory that is not an installation", () => {
    const home = tempHome();
    const dir = path.join(home, "not-an-install");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "important.txt"), "keep\n", "utf-8");
    const result = run(["--uninstall", "--dir", dir], home);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has no install.json");
    expect(fs.readFileSync(path.join(dir, "important.txt"), "utf-8")).toBe("keep\n");
  });

  it("records and removes only the skills it installed", () => {
    const home = tempHome();
    const dir = makeInstall(home);
    const skills = path.join(home, ".agents", "skills");
    const ours = path.join(skills, "obsidian-bridge");
    const foreign = path.join(skills, "obsidian-planning-create");
    fs.mkdirSync(ours, { recursive: true });
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(
      path.join(ours, "SKILL.md"),
      "---\nname: obsidian-bridge\n---\n\n<!-- installed-by: obsidian-bridge -->\n",
      "utf-8",
    );
    // A pre-existing directory without the marker belongs to another tool.
    fs.writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: foreign\n---\n", "utf-8");
    fs.writeFileSync(path.join(dir, "installed-skills.txt"), "obsidian-bridge obsidian-planning-create\n", "utf-8");
    const result = run(["--uninstall"], home);
    expect(result.status).toBe(0);
    expect(fs.existsSync(ours)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
  });
});
