import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { qwenProvider } from "../server/providers/qwen";

/**
 * Qwen Code has no delete command, so this adapter edits the store itself. The
 * tests build a store on disk and check that only the files of the requested
 * session disappear, because a mistake here destroys transcripts.
 */
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let qwenHome: string;

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

function transcriptPath(id: string): string {
  return path.join(qwenHome, "projects", "-tmp-workspace", "chats", `${id}.jsonl`);
}

function writeTranscript(id: string, prompt = "Fix the parser"): string {
  const first = {
    type: "user",
    cwd: "/tmp/workspace",
    timestamp: 1_700_000_000_000,
    message: { parts: [{ text: prompt }] },
  };
  const file = transcriptPath(id);
  writeFile(file, `${JSON.stringify(first)}\n${JSON.stringify({ type: "assistant" })}\n`);
  return file;
}

function writeSidecars(id: string): void {
  writeFile(path.join(qwenHome, "plans", `${id}.md`), "# plan\n");
  writeFile(path.join(qwenHome, "todos", `${id}.json`), "[]\n");
  writeFile(path.join(qwenHome, "file-history", id, "abcdef@v1"), "snapshot\n");
}

function writeRegistry(pid: number, sessionId: string): void {
  writeFile(path.join(qwenHome, "sessions", `${pid}.json`), JSON.stringify({ sessionId, pid }));
}

function exists(target: string): boolean {
  return fs.existsSync(target);
}

beforeEach(() => {
  qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-qwen-"));
  process.env.QWEN_HOME = qwenHome;
});

afterEach(() => {
  delete process.env.QWEN_HOME;
  fs.rmSync(qwenHome, { recursive: true, force: true });
});

describe("qwen list", () => {
  it("reads the transcript, its sidecars, and the store size", async () => {
    writeSidecars(SESSION);
    const transcript = writeTranscript(SESSION);

    const result = await qwenProvider.list();
    const session = result.sessions.find((entry) => entry.id === SESSION);

    expect(session).toBeDefined();
    expect(session?.title).toBe("Fix the parser");
    expect(session?.cwd).toBe("/tmp/workspace");
    expect(session?.createdAt).toBe("2023-11-14T22:13:20.000Z");
    expect(session?.running).toBe(false);
    expect(session?.updatedAt).toBe(fs.statSync(transcript).mtime.toISOString());
    // Transcript + plan + todo + the snapshot file inside file-history/<id>/.
    expect(session?.sizeBytes).toBe(
      fs.statSync(transcript).size +
        fs.statSync(path.join(qwenHome, "plans", `${SESSION}.md`)).size +
        fs.statSync(path.join(qwenHome, "todos", `${SESSION}.json`)).size +
        fs.statSync(path.join(qwenHome, "file-history", SESSION, "abcdef@v1")).size,
    );
    expect(result.detected).toBe(true);
    expect(result.deletable).toBe(true);
    expect(result.detail).toBe(path.join(qwenHome, "projects"));
    expect(result.storeBytes).toBeGreaterThan(0);
  });

  it("marks a session as running while its registry process is alive", async () => {
    writeTranscript(SESSION);
    writeRegistry(process.pid, SESSION);

    const result = await qwenProvider.list();
    expect(result.sessions[0]?.running).toBe(true);
  });

  it("ignores a registry entry whose process is gone", async () => {
    writeTranscript(SESSION);
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    writeRegistry(dead.pid ?? 0, SESSION);

    const result = await qwenProvider.list();
    expect(result.sessions[0]?.running).toBe(false);
  });

  it("reports an empty result when the store does not exist", async () => {
    const result = await qwenProvider.list();
    expect(result.sessions).toEqual([]);
    expect(result.detected).toBe(false);
  });
});

describe("qwen delete", () => {
  it("removes the transcript, every sidecar, and nothing else", async () => {
    writeTranscript(SESSION);
    writeSidecars(SESSION);
    writeTranscript(OTHER);
    writeSidecars(OTHER);
    writeRegistry(process.pid, SESSION);
    writeFile(path.join(qwenHome, "output-language.md"), "English\n");

    const result = await qwenProvider.delete([SESSION]);

    expect(result.deleted).toEqual([SESSION]);
    expect(result.failures).toEqual([]);
    expect(exists(transcriptPath(SESSION))).toBe(false);
    expect(exists(path.join(qwenHome, "plans", `${SESSION}.md`))).toBe(false);
    expect(exists(path.join(qwenHome, "todos", `${SESSION}.json`))).toBe(false);
    expect(exists(path.join(qwenHome, "file-history", SESSION))).toBe(false);
    // The runtime registry entry and the other session stay untouched.
    expect(exists(path.join(qwenHome, "sessions", `${process.pid}.json`))).toBe(true);
    expect(exists(transcriptPath(OTHER))).toBe(true);
    expect(exists(path.join(qwenHome, "file-history", OTHER))).toBe(true);
    expect(exists(path.join(qwenHome, "output-language.md"))).toBe(true);
  });

  it("reports a session whose transcript is already gone", async () => {
    const result = await qwenProvider.delete(["missing"]);
    expect(result.deleted).toEqual([]);
    expect(result.failures).toEqual([{ id: "missing", error: "transcript file not found" }]);
  });
});

describe("qwen export", () => {
  it("copies the transcript to the requested path", async () => {
    writeTranscript(SESSION);
    const outPath = path.join(qwenHome, "out", "copy.jsonl");

    const result = await qwenProvider.exportSession?.({ id: SESSION, outPath });

    expect(result?.ok).toBe(true);
    expect(qwenProvider.exportExtension).toBe("jsonl");
    expect(fs.readFileSync(outPath, "utf-8")).toBe(
      fs.readFileSync(transcriptPath(SESSION), "utf-8"),
    );
  });

  it("fails for a session that is not on disk", async () => {
    const result = await qwenProvider.exportSession?.({
      id: "missing",
      outPath: path.join(qwenHome, "out", "copy.jsonl"),
    });
    expect(result).toEqual({ ok: false, error: "transcript file not found" });
  });
});
