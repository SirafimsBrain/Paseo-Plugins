/**
 * Python `ddgs` subprocess backend (stage 2).
 *
 * The PyPI `ddgs` library is a USER-INSTALLED REQUIREMENT: this plugin
 * never installs Python packages. All the code does is discover a
 * Python interpreter that can `import ddgs` and then talk to it through
 * a child process (`python -c <script> …`, no shell, JSON on stdout).
 *
 * Discovery order (requirement: environment variables first, then the
 * well-known virtualenv directories):
 *
 *   1. `ddgsPythonPath` plugin setting (explicit override)
 *   2. `BUNNY_SEARCH_PYTHON` environment variable
 *   3. `VIRTUAL_ENV` environment variable
 *   4. `CONDA_PREFIX` environment variable
 *   5. `PATH` scan (`python3`, then `python`)
 *   6. Well-known directories: `~/.venv`, `~/venv`,
 *      `~/.virtualenvs/*`, `~/.local/share/virtualenvs/*`
 *
 * A candidate only counts when it both executes and passes
 * `import ddgs` — PATH order can surface a system Python without the
 * library (as on this machine: /usr/bin/python3 has no ddgs while
 * ~/venv does), so the walk continues to the next candidate.
 *
 * The interpreter path is cached for the process lifetime and dropped
 * once when a verified interpreter later fails to import the library
 * (e.g. the venv was removed), after which discovery runs again.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** One interpreter candidate: where it came from (for diagnostics). */
interface PythonCandidate {
  executable: string;
  source: string;
}

/** Result of a successful discovery. */
export interface ResolvedPython {
  executable: string;
  source: string;
}

/** Discovery failure with the full search trail for an actionable error. */
export interface PythonDiscoveryFailure {
  executable: null;
  searched: string[];
}

export type PythonDiscovery = ResolvedPython | PythonDiscoveryFailure;

/** Availability check outcome (python found + `import ddgs` works, or why not). */
export interface PythonAvailability {
  ok: boolean;
  resolved: ResolvedPython | null;
  error: string | null;
}

function isResolved(value: PythonDiscovery): value is ResolvedPython {
  return value.executable !== null;
}

/** Environment variables consulted during discovery, in priority order. */
function envCandidates(env: NodeJS.ProcessEnv): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];
  const push = (value: string | undefined, source: string): void => {
    if (value && value.trim().length > 0) {
      candidates.push({ executable: value.trim(), source });
    }
  };
  push(env.BUNNY_SEARCH_PYTHON, "BUNNY_SEARCH_PYTHON");
  const venvBin = process.platform === "win32" ? "Scripts" : "bin";
  const venvPython = process.platform === "win32" ? "python.exe" : "python";
  if (env.VIRTUAL_ENV) {
    push(path.join(env.VIRTUAL_ENV, venvBin, venvPython), "VIRTUAL_ENV");
  }
  if (env.CONDA_PREFIX) {
    push(path.join(env.CONDA_PREFIX, venvBin, venvPython), "CONDA_PREFIX");
  }
  return candidates;
}

/** Every python on PATH, in PATH order (the "environment variables" tier). */
function pathCandidates(env: NodeJS.ProcessEnv): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];
  const entries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names =
    process.platform === "win32"
      ? ["python3.exe", "python.exe"]
      : ["python3", "python"];
  for (const dir of entries) {
    for (const name of names) {
      const executable = path.join(dir, name);
      try {
        fs.accessSync(executable, fs.constants.X_OK);
        candidates.push({ executable, source: `PATH (${executable})` });
      } catch {
        // Not executable / not present — keep scanning.
      }
    }
  }
  return candidates;
}

/** Well-known virtualenv directories (the fallback tier). */
function dirCandidates(homeDir: string): PythonCandidate[] {
  const bin = process.platform === "win32" ? "Scripts" : "bin";
  const python = process.platform === "win32" ? "python.exe" : "python";
  const python3 = process.platform === "win32" ? "python3.exe" : "python3";
  const candidates: PythonCandidate[] = [];
  const add = (dir: string): void => {
    candidates.push({ executable: path.join(dir, python), source: dir });
    candidates.push({ executable: path.join(dir, python3), source: dir });
  };
  add(path.join(homeDir, ".venv", bin));
  add(path.join(homeDir, "venv", bin));
  for (const parent of [
    path.join(homeDir, ".virtualenvs"),
    path.join(homeDir, ".local", "share", "virtualenvs"),
  ]) {
    try {
      for (const entry of fs.readdirSync(parent)) {
        add(path.join(parent, entry, bin));
      }
    } catch {
      // Directory absent — the normal case.
    }
  }
  return candidates;
}

/** Ordered, de-duplicated candidate list for the given settings/environment. */
export function pythonCandidates(
  explicitPath: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];
  const explicit = explicitPath.trim();
  if (explicit.length > 0) {
    candidates.push({ executable: explicit, source: "settings (Python path)" });
  }
  candidates.push(...envCandidates(env), ...pathCandidates(env), ...dirCandidates(homeDir));
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.executable)) return false;
    seen.add(candidate.executable);
    return true;
  });
}

/** Runs `python -c <code>` and reports exit status + output. */
function runPythonCheck(
  executable: string,
  code: string,
  timeoutMs: number,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: { ok: boolean; stderr: string }): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, ["-c", code], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
    } catch (cause) {
      done({ ok: false, stderr: cause instanceof Error ? cause.message : String(cause) });
      return;
    }
    let stderr = "";
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.resume();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, stderr: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.on("error", (cause: Error) => {
      clearTimeout(timer);
      done({ ok: false, stderr: cause.message });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      done({ ok: code === 0, stderr });
    });
  });
}

/** Process-lifetime cache of the verified interpreter. */
let cached: ResolvedPython | null = null;
/** Set after a cache hit failed to import the library (forces re-discovery). */
let reimportFailure = false;

/** Drops the cached interpreter (tests, or after a failed re-import). */
export function resetPythonCache(): void {
  cached = null;
  reimportFailure = false;
}

const IMPORT_CHECK = "import ddgs";

function failure(searched: string[]): PythonDiscoveryFailure {
  return { executable: null, searched };
}

async function discover(
  explicitPath: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  timeoutMs: number,
): Promise<PythonDiscovery> {
  if (cached && !reimportFailure) return cached;
  const searched: string[] = [];
  for (const candidate of pythonCandidates(explicitPath, env, homeDir)) {
    searched.push(`${candidate.source}: ${candidate.executable}`);
    const probe = await runPythonCheck(candidate.executable, IMPORT_CHECK, timeoutMs);
    if (probe.ok) {
      cached = { executable: candidate.executable, source: candidate.source };
      reimportFailure = false;
      return cached;
    }
  }
  return failure(searched);
}

/**
 * Verifies that an interpreter with the `ddgs` library exists.
 * This is the plugin's only "installation check" — it never installs.
 */
export async function checkDdgsAvailability(
  explicitPath: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): Promise<PythonAvailability> {
  const resolved = await discover(explicitPath, env, homeDir, 15_000);
  if (isResolved(resolved)) return { ok: true, resolved, error: null };
  const detail = resolved.searched.length
    ? `Searched:\n${resolved.searched.map((line) => `  - ${line}`).join("\n")}`
    : "No interpreter candidates found.";
  return {
    ok: false,
    resolved: null,
    error:
      "Python with the 'ddgs' library was not found. The ddgs library is a " +
      "user requirement — install it yourself (e.g. `pip install ddgs`) or set " +
      "the Python path in Bunny Search settings / BUNNY_SEARCH_PYTHON. " +
      detail,
  };
}

/** One text-search round trip through the interpreter. */
export interface DdgsSearchCall {
  query: string;
  maxResults: number;
  /** Region ("ru-ru", …) or "" for the library default. */
  region: string;
  /** http(s)/socks5 proxy URL or "" for direct. */
  proxy: string;
  timeoutMs: number;
}

export interface DdgsRawResult {
  title?: unknown;
  href?: unknown;
  body?: unknown;
}

/**
 * The inline script executed with `python -c`. Arguments after the
 * script arrive as sys.argv[1..]: query, max_results, region, proxy,
 * timeout(seconds). Prints a JSON array on stdout; errors go to stderr
 * with a non-zero exit code.
 */
const SEARCH_SCRIPT = [
  "import json, sys",
  "from ddgs import DDGS",
  "query, mx, region, proxy, timeout = (sys.argv[1], int(sys.argv[2]),",
  "                                    sys.argv[3], sys.argv[4], float(sys.argv[5]))",
  "kwargs = {}",
  "if proxy:",
  "    kwargs['proxy'] = proxy",
  "client = DDGS(timeout=timeout, **kwargs)",
  "text_kwargs = {'max_results': mx}",
  "if region:",
  "    text_kwargs['region'] = region",
  "print(json.dumps(client.text(query, **text_kwargs), ensure_ascii=False))",
].join("\n");

function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/**
 * Runs a text search in the discovered interpreter.
 * On an import failure after a previously successful verification the
 * cache is dropped and discovery runs once more (the venv may have
 * been replaced) before the error is surfaced.
 */
export async function ddgsTextSearch(
  call: DdgsSearchCall,
  explicitPath: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): Promise<DdgsRawResult[]> {
  const attempt = async (): Promise<DdgsRawResult[]> =>
    runSearchOnce(call, explicitPath, env, homeDir);
  try {
    return await attempt();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/No module named 'ddgs'|ModuleNotFoundError/.test(message)) {
      // The verified interpreter lost the library — rediscover once.
      resetPythonCache();
      return attempt();
    }
    throw cause;
  }
}

async function runSearchOnce(
  call: DdgsSearchCall,
  explicitPath: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Promise<DdgsRawResult[]> {
  const discovered = await discover(explicitPath, env, homeDir, 15_000);
  if (!isResolved(discovered)) {
    const availability = await checkDdgsAvailability(explicitPath, env, homeDir);
    throw new Error(availability.error ?? "Python with ddgs was not found.");
  }
  const timeoutSeconds = Math.max(1, Math.ceil(call.timeoutMs / 1000));
  const args = [
    "-c",
    SEARCH_SCRIPT,
    call.query,
    String(Math.max(1, Math.min(100, Math.trunc(call.maxResults) || 10))),
    call.region,
    call.proxy,
    String(timeoutSeconds),
  ];

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(discovered.executable, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...env, PYTHONIOENCODING: "utf-8" },
        });
      } catch (cause) {
        resolve({
          code: null,
          stdout: "",
          stderr: cause instanceof Error ? cause.message : String(cause),
          timedOut: false,
        });
        return;
      }
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, call.timeoutMs);
      child.on("error", (cause: Error) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: cause.message, timedOut });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    },
  );

  if (result.timedOut) {
    throw new Error(
      `DDGS Python did not respond within the configured timeout (${call.timeoutMs} ms).`,
    );
  }
  if (result.code !== 0) {
    const detail = lastMeaningfulLine(result.stderr) || `exit code ${String(result.code)}`;
    throw new Error(`DDGS Python search failed: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `DDGS Python returned unreadable output: ${
        result.stdout.trim().slice(0, 200) || "(empty)"
      }`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("DDGS Python returned an unexpected payload (expected a JSON array).");
  }
  return parsed.filter(
    (entry): entry is DdgsRawResult => typeof entry === "object" && entry !== null,
  );
}
