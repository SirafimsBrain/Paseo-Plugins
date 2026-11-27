import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piProvider } from "../server/providers/pi";

/**
 * Pi keeps every session as one NDJSON transcript under
 * `~/.pi/agent/sessions/<--sanitized-cwd-->/<timestamp>_<id>.jsonl`, with the
 * session id in the first `session` entry rather than in the file name. Pi has
 * no session delete command, so this adapter edits the store directly and the
 * tests check that only the requested transcript disappears.
 */

const SESSION = "01935f0a-1111-7111-8111-111111111111";
const OTHER = "01935f0a-2222-7222-8222-222222222222";
const WORKDIR = "--tmp-workspace--";

let agentDir: string;
let binaryFound = true;
let cliCalls: string[][] = [];

vi.mock("../server/exec", () => ({
  resolveBinary: () => (binaryFound ? "/usr/bin/pi" : null),
  runCli: async (_file: string, args: string[]) => {
    cliCalls.push(args);
    // `pi --export <session file> <output>`: write the rendered transcript.
    if (args[0] === "--export" && args.length === 3) {
      fs.mkdirSync(path.dirname(args[2] as string), { recursive: true });
      fs.writeFileSync(args[2] as string, "<html>transcript</html>", "utf-8");
      return { ok: true, stdout: "", stderr: "", code: 0, error: null };
    }
    return { ok: false, stdout: "", stderr: "", code: 1, error: "unexpected args" };
  },
}));

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

function transcriptPath(id: string, dir = WORKDIR): string {
  return path.join(agentDir, "sessions", dir, `2026-11-26T18-09-00.000Z_${id}.jsonl`);
}

interface EntryOptions {
  cwd?: string;
  timestamp?: string;
  name?: string;
  prompt?: string;
}

function entries(id: string, options: EntryOptions = {}): string {
  const header = {
    type: "session",
    version: 3,
    id,
    timestamp: options.timestamp ?? "2026-11-26T18:09:00.000Z",
    cwd: options.cwd ?? "/tmp/workspace",
  };
  const user = {
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: options.timestamp ?? "2026-11-26T18:09:00.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: options.prompt ?? "Fix the parser" }],
    },
  };
  const lines = [JSON.stringify(header), JSON.stringify(user)];
  if (options.name !== undefined) {
    lines.push(
      JSON.stringify({
        type: "session_info",
        id: "b1",
        parentId: "a1",
        timestamp: "2026-11-26T18:10:00.000Z",
        name: options.name,
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeSession(id: string, options: EntryOptions = {}, dir = WORKDIR): string {
  const file = transcriptPath(id, dir);
  writeFile(file, entries(id, options));
  return file;
}

function exists(target: string): boolean {
  return fs.existsSync(target);
}

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-pi-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  binaryFound = true;
  cliCalls = [];
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("pi list", () => {
  it("reads the session header and the last session_info name", async () => {
    writeSession(SESSION, { name: "Parser rewrite" });
    writeSession(OTHER, { cwd: "/tmp/other", name: "Other" });

    const result = await piProvider.list();
    const session = result.sessions.find((entry) => entry.id === SESSION);

    expect(session).toBeDefined();
    expect(session?.title).toBe("Parser rewrite");
    expect(session?.cwd).toBe("/tmp/workspace");
    expect(session?.createdAt).toBe("2026-11-26T18:09:00.000Z");
    expect(session?.updatedAt).toBe(fs.statSync(transcriptPath(SESSION)).mtime.toISOString());
    expect(session?.sizeBytes).toBe(fs.statSync(transcriptPath(SESSION)).size);
    expect(session?.running).toBe(false);
    expect(result.detected).toBe(true);
    expect(result.deletable).toBe(true);
    expect(result.detail).toBe(path.join(agentDir, "sessions"));
    expect(result.storeBytes).toBeGreaterThan(0);
    expect(result.sessions).toHaveLength(2);
  });

  it("falls back to the first user message when the session has no name", async () => {
    writeSession(SESSION, { prompt: "Refactor the store adapter" });

    const result = await piProvider.list();
    expect(result.sessions[0]?.title).toBe("Refactor the store adapter");
  });

  it("scans a custom session directory, where transcripts sit at the top level", async () => {
    const customDir = path.join(agentDir, "custom-sessions");
    writeFile(
      path.join(customDir, `2026-11-26T18-09-00.000Z_${SESSION}.jsonl`),
      entries(SESSION),
    );
    process.env.PI_CODING_AGENT_SESSION_DIR = customDir;

    const result = await piProvider.list();
    expect(result.sessions.map((entry) => entry.id)).toEqual([SESSION]);
    expect(result.detail).toBe(customDir);
  });

  it("skips files that are not Pi transcripts", async () => {
    writeSession(SESSION);
    writeFile(path.join(agentDir, "sessions", WORKDIR, "notes.txt"), "not a session\n");
    writeFile(
      path.join(agentDir, "sessions", WORKDIR, "broken.jsonl"),
      `${JSON.stringify({ type: "message", id: "x" })}\n`,
    );

    const result = await piProvider.list();
    expect(result.sessions.map((entry) => entry.id)).toEqual([SESSION]);
  });

  it("reports an empty result when the store does not exist", async () => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    const result = await piProvider.list();
    expect(result.sessions).toEqual([]);
    expect(result.detected).toBe(false);
    expect(result.storeBytes).toBeNull();
  });
});

describe("pi delete", () => {
  it("removes only the requested transcript", async () => {
    const target = writeSession(SESSION);
    const other = writeSession(OTHER);

    const result = await piProvider.delete([SESSION]);

    expect(result.deleted).toEqual([SESSION]);
    expect(result.failures).toEqual([]);
    expect(exists(target)).toBe(false);
    expect(exists(other)).toBe(true);
  });

  it("reports a session whose transcript is already gone", async () => {
    writeSession(OTHER);
    const result = await piProvider.delete(["missing"]);
    expect(result.deleted).toEqual([]);
    expect(result.failures).toEqual([
      { id: "missing", error: "session transcript not found" },
    ]);
  });
});

describe("pi export", () => {
  it("renders the transcript as HTML through pi --export", async () => {
    const transcript = writeSession(SESSION);
    const outPath = path.join(agentDir, "out", "copy.html");

    const result = await piProvider.exportSession?.({ id: SESSION, outPath });

    expect(result?.ok).toBe(true);
    expect(piProvider.exportExtension).toBe("html");
    expect(cliCalls).toEqual([["--export", transcript, outPath]]);
    expect(fs.readFileSync(outPath, "utf-8")).toBe("<html>transcript</html>");
  });

  it("reports cannot export when the pi CLI is not installed", async () => {
    writeSession(SESSION);
    binaryFound = false;

    const result = await piProvider.exportSession?.({
      id: SESSION,
      outPath: path.join(agentDir, "out", "copy.html"),
    });

    expect(result).toEqual({ ok: false, error: 'CLI "pi" not found; cannot export' });
    expect(cliCalls).toEqual([]);
  });
});
