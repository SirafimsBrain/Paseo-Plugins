import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { exists, homeDir } from "./util";

/**
 * Extra search locations for agent CLIs. The Paseo daemon is usually started
 * from the desktop session, whose PATH frequently misses version managers, so
 * PATH alone is not enough to find `cline`, `opencode`, `kilo`, or `qwen`.
 */
function extraBinDirs(): string[] {
  const home = homeDir();
  const dirs = [
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".volta", "bin"),
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, "AppData", "Local", "pnpm"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    ...nvmBinDirs(home),
  ];
  return dirs;
}

function nvmBinDirs(home: string): string[] {
  const root = path.join(home, ".nvm", "versions", "node");
  try {
    return fs
      .readdirSync(root)
      .map((version) => path.join(root, version, "bin"))
      .reverse();
  } catch {
    return [];
  }
}

export function searchPath(): string[] {
  const fromEnv = (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of [...fromEnv, ...extraBinDirs()]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    result.push(dir);
  }
  return result;
}

/** Resolves an executable name against PATH plus well-known install locations. */
export function resolveBinary(name: string): string | null {
  const names =
    process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
  for (const dir of searchPath()) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (exists(full)) return full;
    }
  }
  return null;
}

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  error: string | null;
}

/** Runs a resolved binary without a shell, with a hard timeout and bounded output. */
export function runCli(
  file: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeoutMs ?? 45_000,
        cwd: options.cwd,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", CI: "1" },
      },
      (error, stdout, stderr) => {
        const out = stdout ?? "";
        const err = stderr ?? "";
        if (!error) {
          resolve({ ok: true, stdout: out, stderr: err, code: 0, error: null });
          return;
        }
        const code = typeof (error as { code?: unknown }).code === "number"
          ? ((error as { code: number }).code)
          : null;
        const message = error instanceof Error ? error.message : String(error);
        const detail = err.trim().split("\n").slice(-3).join(" ").trim();
        resolve({
          ok: false,
          stdout: out,
          stderr: err,
          code,
          error: detail.length > 0 ? detail : message,
        });
      },
    );
  });
}

/**
 * Parses JSON from CLI stdout that may be wrapped in banners or log lines.
 * Returns null when no JSON payload can be recovered.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to brace matching.
  }
  const starts = [trimmed.indexOf("["), trimmed.indexOf("{")].filter((index) => index >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const open = trimmed[start];
  const close = open === "[" ? "]" : "}";
  const end = trimmed.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}
