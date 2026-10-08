import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkDdgsAvailability,
  pythonCandidates,
  resetPythonCache,
} from "../server/ddgs-python";

/**
 * Interpreter discovery tests. Fully hermetic: fake `python` files are
 * tiny shell scripts that exit 0 ("has ddgs") or 1 ("no ddgs"), so no
 * real Python, network or installed library is involved.
 */

const isPosix = process.platform !== "win32";
const describePosix = isPosix ? describe : describe.skip;

const cleanup: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunny-python-"));
  cleanup.push(dir);
  return dir;
}

/** Creates an executable fake interpreter with the given exit code. */
function fakePython(filePath: string, exitCode: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

afterEach(() => {
  resetPythonCache();
  while (cleanup.length > 0) {
    fs.rmSync(cleanup.pop() as string, { recursive: true, force: true });
  }
});

describePosix("pythonCandidates ordering", () => {
  it("puts the explicit setting first, then env vars, PATH and home directories", () => {
    const bin = tempDir();
    fakePython(path.join(bin, "python3"), 0);
    const home = tempDir();
    fakePython(path.join(home, "venv", "bin", "python"), 0);
    const env = {
      PATH: bin,
      BUNNY_SEARCH_PYTHON: "/env/python",
      VIRTUAL_ENV: "/venv-root",
      CONDA_PREFIX: "/conda-root",
    };

    const sources = pythonCandidates("/explicit/python", env, home).map(
      (candidate) => candidate.source,
    );
    expect(sources[0]).toBe("settings (Python path)");
    expect(sources[1]).toBe("BUNNY_SEARCH_PYTHON");
    expect(sources[2]).toBe("VIRTUAL_ENV");
    expect(sources[3]).toBe("CONDA_PREFIX");
    expect(sources[4]).toContain("PATH");
    expect(sources[sources.length - 1]).toContain(path.join(home, "venv"));
  });

  it("falls back to ~/.venv and ~/.virtualenvs entries", () => {
    const home = tempDir();
    fakePython(path.join(home, ".venv", "bin", "python3"), 0);
    fakePython(path.join(home, ".virtualenvs", "proj", "bin", "python"), 0);
    const sources = pythonCandidates("", { PATH: "" }, home).map((c) => c.source);
    expect(sources.some((source) => source.includes(path.join(home, ".venv")))).toBe(true);
    expect(
      sources.some((source) => source.includes(path.join(home, ".virtualenvs", "proj"))),
    ).toBe(true);
  });

  it("deduplicates identical executables", () => {
    const env = { PATH: "", BUNNY_SEARCH_PYTHON: "/same/python" };
    const candidates = pythonCandidates("/same/python", env, "/nowhere");
    const samePath = candidates.filter(
      (candidate) => candidate.executable === "/same/python",
    );
    expect(samePath).toHaveLength(1);
    // The setting and the environment variable collapsed into one entry.
    expect(samePath[0]?.source).toBe("settings (Python path)");
  });
});

describePosix("checkDdgsAvailability", () => {
  beforeEach(() => {
    resetPythonCache();
  });

  it("skips interpreters without ddgs and keeps searching (PATH before dirs)", () => {
    // PATH python has NO ddgs (exit 1) — like this machine's /usr/bin/python3;
    // the home venv python does (exit 0) and must win anyway.
    const bin = tempDir();
    fakePython(path.join(bin, "python3"), 1);
    const home = tempDir();
    fakePython(path.join(home, "venv", "bin", "python"), 0);

    return checkDdgsAvailability("", { PATH: bin }, home).then((result) => {
      expect(result.ok).toBe(true);
      expect(result.resolved?.executable).toBe(
        path.join(home, "venv", "bin", "python"),
      );
      expect(result.resolved?.source).toContain(path.join(home, "venv"));
    });
  });

  it("reports an actionable error listing every searched interpreter", () => {
    const home = tempDir();
    fakePython(path.join(home, "venv", "bin", "python"), 1);
    const bin = tempDir();
    fakePython(path.join(bin, "python3"), 1);

    return checkDdgsAvailability("/missing/python", { PATH: bin }, home).then((result) => {
      expect(result.ok).toBe(false);
      expect(result.resolved).toBeNull();
      expect(result.error).toContain("pip install ddgs");
      expect(result.error).toContain("user requirement");
      expect(result.error).toContain("/missing/python");
      expect(result.error).toContain(path.join(home, "venv", "bin", "python"));
    });
  });

  it("fails when a candidate does not execute at all", () => {
    const home = tempDir();
    return checkDdgsAvailability("/nonexistent/python", { PATH: "" }, home).then((result) => {
      expect(result.ok).toBe(false);
      expect(result.error).toContain("/nonexistent/python");
    });
  });

  it("caches a successful resolution for the process lifetime", async () => {
    const home = tempDir();
    fakePython(path.join(home, "venv", "bin", "python"), 0);
    const first = await checkDdgsAvailability("", { PATH: "" }, home);
    expect(first.ok).toBe(true);
    // Remove the interpreter — a cached resolution must still succeed.
    fs.rmSync(path.join(home, "venv", "bin", "python"));
    const second = await checkDdgsAvailability("", { PATH: "" }, home);
    expect(second.ok).toBe(true);
    expect(second.resolved?.executable).toBe(first.resolved?.executable);
    // After an explicit reset the (now missing) interpreter is rediscovered.
    resetPythonCache();
    const third = await checkDdgsAvailability("", { PATH: "" }, home);
    expect(third.ok).toBe(false);
  });
});
