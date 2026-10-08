import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkSearchService, searchWeb } from "../server/providers";
import { resetPythonCache } from "../server/ddgs-python";
import type { RuntimeSettings } from "../shared/contracts";

/**
 * DDGS provider tests with a mocked `node:child_process.spawn`: the
 * Python subprocess is scripted (JSON stdout, stderr, exit codes, hang)
 * so no real interpreter, library or network is involved. Interpreter
 * ordering itself is covered by python-discovery.test.ts.
 */

interface SpawnCall {
  executable: string;
  args: string[];
}

const scripted = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  /** Whether the `import ddgs` probe succeeds (false = library missing). */
  importOk: true,
  /** Flip the import probes to failure after the first search spawn. */
  breakLibraryAfterFirstSearch: false,
  /** Internal: a search invocation has already happened. */
  searchStarted: false,
  /** Handler for the search invocation; default = valid empty result. */
  search: null as null | {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    hang?: boolean;
  },
}));

vi.mock("node:child_process", () => ({
  spawn: (executable: string, args: string[]) => {
    scripted.calls.push({ executable, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: string) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    const isImportProbe = args.length === 2 && args[1] === "import ddgs";
    const importOk =
      scripted.importOk &&
      !(scripted.breakLibraryAfterFirstSearch && scripted.searchStarted);
    const search = scripted.search;
    if (!isImportProbe) scripted.searchStarted = true;

    child.kill = () => {
      if (!isImportProbe && search?.hang) {
        setImmediate(() => child.emit("close", null));
      }
      return true;
    };

    setImmediate(() => {
      if (isImportProbe) {
        child.emit("close", importOk ? 0 : 1);
        return;
      }
      if (search?.hang) return; // waits for kill() from the timeout
      if (search?.stderr) child.stderr.write(search.stderr);
      if (search?.stdout) child.stdout.write(search.stdout);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", search?.exitCode ?? 0);
    });
    return child;
  },
}));

function settings(overrides: Partial<RuntimeSettings> = {}): RuntimeSettings {
  return {
    searchService: "ddgs",
    duckduckjsEngine: "auto",
    proxyUrl: "",
    ddgsPythonPath: "",
    searxngBaseUrl: "http://searxng.test/search",
    customBaseUrl: "",
    apiKey: "",
    timeoutMs: 5000,
    maxResults: 10,
    categories: "general,web",
    language: "",
    ...overrides,
  };
}

function searchInvocations(): SpawnCall[] {
  return scripted.calls.filter((call) => call.args.length > 2);
}

function importInvocations(): SpawnCall[] {
  return scripted.calls.filter((call) => call.args[1] === "import ddgs");
}

beforeEach(() => {
  scripted.calls.length = 0;
  scripted.importOk = true;
  scripted.breakLibraryAfterFirstSearch = false;
  scripted.searchStarted = false;
  scripted.search = null;
  resetPythonCache();
});

describe("ddgs provider", () => {
  it("runs the search subprocess and normalizes title/href/body results", async () => {
    scripted.search = {
      stdout: JSON.stringify([
        { title: "  First ", href: "https://example.com/1", body: " one  two " },
        { title: "Second", href: "https://example.com/2", body: "three" },
      ]),
    };
    const response = await searchWeb(
      { query: "cats & dogs", maxResults: 5, language: "ru" },
      settings({ proxyUrl: "http://127.0.0.1:8080" }),
    );
    expect(response.results).toEqual([
      { title: "First", url: "https://example.com/1", content: "one two" },
      { title: "Second", url: "https://example.com/2", content: "three" },
    ]);

    const search = searchInvocations()[0];
    expect(search).toBeDefined();
    const args = search?.args ?? [];
    // -c <script> query max_results region proxy timeout_seconds
    expect(args[2]).toBe("cats & dogs");
    expect(args[3]).toBe("5");
    expect(args[4]).toBe("ru-ru");
    expect(args[5]).toBe("http://127.0.0.1:8080");
    expect(args[6]).toBe("5"); // timeoutMs 5000 → 5 s
    // The availability probe ran first.
    expect(importInvocations().length).toBeGreaterThan(0);
  });

  it("clamps max_results into the 1–30 band", async () => {
    scripted.search = { stdout: "[]" };
    await searchWeb({ query: "cats", maxResults: 999 }, settings());
    expect(searchInvocations()[0]?.args[3]).toBe("30");
  });

  it("passes no region and no proxy when unset", async () => {
    scripted.search = { stdout: "[]" };
    await searchWeb({ query: "cats", maxResults: 10 }, settings());
    const args = searchInvocations()[0]?.args ?? [];
    expect(args[4]).toBe("");
    expect(args[5]).toBe("");
  });

  it("maps interpreter failures to a friendly error", async () => {
    scripted.search = {
      exitCode: 1,
      stderr: "Traceback (most recent call last):\n  ...\nValueError: backend refused the query\n",
    };
    await expect(
      searchWeb({ query: "cats", maxResults: 5 }, settings()),
    ).rejects.toThrow("DDGS Python search failed: ValueError: backend refused the query");
  });

  it("times out a hung interpreter with the configured timeout", async () => {
    scripted.search = { hang: true };
    await expect(
      searchWeb({ query: "cats", maxResults: 5 }, settings({ timeoutMs: 50 })),
    ).rejects.toThrow(/did not respond within the configured timeout/);
  });

  it("rejects unreadable stdout", async () => {
    scripted.search = { stdout: "not json at all" };
    await expect(
      searchWeb({ query: "cats", maxResults: 5 }, settings()),
    ).rejects.toThrow(/unreadable output/);
  });

  it("rediscovers the interpreter once when the library disappears", async () => {
    // Import probe succeeds initially; after the first search (which
    // fails with ModuleNotFoundError) every probe fails, so discovery
    // restarts and surfaces the actionable "install it yourself" error.
    scripted.importOk = true;
    scripted.breakLibraryAfterFirstSearch = true;
    scripted.search = {
      exitCode: 1,
      stderr: "ModuleNotFoundError: No module named 'ddgs'",
    };

    await expect(
      searchWeb({ query: "cats", maxResults: 5 }, settings()),
    ).rejects.toThrow(/pip install ddgs/);
    expect(importInvocations().length).toBeGreaterThanOrEqual(2);
  });

  it("check() reports a missing library with install instructions", async () => {
    scripted.importOk = false;
    const result = await checkSearchService(settings());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("pip install ddgs");
    expect(result.error).toContain("user requirement");
    expect(searchInvocations()).toHaveLength(0);
  });

  it("check() succeeds when the probe search returns results", async () => {
    scripted.search = {
      stdout: JSON.stringify([{ title: "Hit", href: "https://example.com/p", body: "p" }]),
    };
    await expect(checkSearchService(settings())).resolves.toMatchObject({ ok: true });
  });

  it("check() flags the answered-but-empty rate-limit signature", async () => {
    scripted.search = { stdout: "[]" };
    await expect(checkSearchService(settings())).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/rate-limiting/),
    });
  });
});
