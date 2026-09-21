import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliProvider } from "../server/providers/cli";
import type { ProviderSession } from "../server/providers/types";

const BINARY = "fake-agent-cli";

let binDir: string;
let storeDir: string;
let originalPath: string | undefined;

/** Writes an executable stub so `resolveBinary` can find it through PATH. */
function writeFakeCli(body: string, name = BINARY): string {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf-8");
  fs.chmodSync(file, 0o755);
  return file;
}

function row(id: string): ProviderSession {
  return {
    id,
    title: null,
    cwd: null,
    createdAt: null,
    updatedAt: null,
    sizeBytes: null,
    running: false,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    id: "fake",
    label: "Fake agent",
    binary: BINARY,
    storePath: () => path.join(storeDir, "store.db"),
    listArgs: () => ["list"],
    parseRow: (entry: Record<string, unknown>) =>
      typeof entry["id"] === "string" ? row(entry["id"] as string) : null,
    deleteArgs: (id: string) => ["delete", id],
    ...overrides,
  } as Parameters<typeof createCliProvider>[0];
}

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-cli-bin-"));
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-cli-store-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  fs.rmSync(binDir, { recursive: true, force: true });
  fs.rmSync(storeDir, { recursive: true, force: true });
});

describe("createCliProvider fallback behaviour", () => {
  it("reports the provider as undetected when the CLI is missing", async () => {
    const provider = createCliProvider(config());
    const result = await provider.list();

    expect(result.sessions).toEqual([]);
    expect(result.detected).toBe(false);
    expect(result.deletable).toBe(false);
    expect(result.error).toBeNull();
    expect(result.storeBytes).toBeNull();
    expect(result.detail).toContain(`CLI "${BINARY}" not found`);
  });

  it("uses the disk fallback when the CLI is missing", async () => {
    const provider = createCliProvider(
      config({
        fallbackList: async () => ({
          sessions: [row("from-disk")],
          detected: true,
          detail: "disk",
          deletable: false,
          storeBytes: 42,
          error: null,
        }),
      }),
    );

    const result = await provider.list();
    expect(result.sessions.map((session) => session.id)).toEqual(["from-disk"]);
    expect(result.detected).toBe(true);
    expect(result.deletable).toBe(false);
    expect(result.storeBytes).toBe(42);
  });

  it("fills the store size when the fallback does not know it", async () => {
    fs.writeFileSync(path.join(storeDir, "store.db"), "x".repeat(2048));
    const provider = createCliProvider(
      config({
        fallbackList: async () => ({
          sessions: [],
          detected: true,
          detail: "disk",
          deletable: false,
          storeBytes: null,
          error: null,
        }),
      }),
    );

    const result = await provider.list();
    expect(result.storeBytes).toBe(2048);
  });

  it("uses the disk fallback when the CLI fails", async () => {
    writeFakeCli('echo "boom" >&2\nexit 7');
    const provider = createCliProvider(
      config({
        fallbackList: async () => ({
          sessions: [row("from-disk")],
          detected: true,
          detail: "disk",
          deletable: false,
          storeBytes: null,
          error: null,
        }),
      }),
    );

    const result = await provider.list();
    expect(result.sessions.map((session) => session.id)).toEqual(["from-disk"]);
  });

  it("surfaces a CLI failure when there is no fallback", async () => {
    writeFakeCli('echo "boom" >&2\nexit 7');
    const provider = createCliProvider(config());
    const result = await provider.list();

    expect(result.sessions).toEqual([]);
    expect(result.detected).toBe(true);
    expect(result.deletable).toBe(false);
    expect(result.error).toBe(`${BINARY} failed: boom`);
  });
});

describe("createCliProvider CLI parsing", () => {
  it("parses rows from output wrapped in a banner and skips unknown rows", async () => {
    writeFakeCli(
      [
        'echo "INFO version=7.7.5 command=list"',
        "echo '\u2588\u2588 \u2588\u2588 logo line'",
        "echo '[{\"id\":\"a\"},{\"nope\":1},{\"id\":\"b\"}]'",
      ].join("\n"),
    );
    const provider = createCliProvider(config());
    const result = await provider.list();

    expect(result.sessions.map((session) => session.id)).toEqual(["a", "b"]);
    expect(result.detected).toBe(true);
    expect(result.deletable).toBe(true);
    expect(result.error).toBeNull();
    expect(result.detail).toBe(path.join(binDir, BINARY));
  });

  it("applies enrich to every parsed row", async () => {
    writeFakeCli(`echo '[{"id":"a"}]'`);
    const provider = createCliProvider(
      config({
        enrich: (session: ProviderSession) => ({ ...session, sizeBytes: 7 }),
      }),
    );

    const result = await provider.list();
    expect(result.sessions[0]?.sizeBytes).toBe(7);
  });

  it("reports unexpected output instead of pretending the store is empty", async () => {
    writeFakeCli("echo 'not json at all'");
    const provider = createCliProvider(config());
    const result = await provider.list();

    expect(result.sessions).toEqual([]);
    expect(result.deletable).toBe(true);
    expect(result.error).toBe(`${BINARY} returned unexpected output`);
  });

  it("refuses to delete through a missing CLI", async () => {
    const provider = createCliProvider(config());
    const result = await provider.delete(["a", "b"]);

    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]?.error).toContain("not found");
  });

  it("reports per-id delete results from the CLI", async () => {
    writeFakeCli(
      [
        'if [ "$1" = "delete" ] && [ "$2" = "bad" ]; then',
        '  echo "cannot delete bad" >&2',
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
    );
    const provider = createCliProvider(config());
    const result = await provider.delete(["good", "bad"]);

    expect(result.deleted).toEqual(["good"]);
    expect(result.failures).toEqual([{ id: "bad", error: "cannot delete bad" }]);
  });
});

describe("createCliProvider export", () => {
  it("has no exportSession when the config declares none", () => {
    expect(createCliProvider(config()).exportSession).toBeUndefined();
  });

  it("writes the stdout of the CLI to the export path", async () => {
    writeFakeCli(`echo '{"exported":true}'`);
    const provider = createCliProvider(
      config({ export: { kind: "stdout", extension: "json", args: () => ["export"] } }),
    );
    const outPath = path.join(storeDir, "session.json");

    const result = await provider.exportSession?.({ id: "a", outPath });

    expect(result).toEqual({ ok: true, bytes: 18 });
    expect(fs.readFileSync(outPath, "utf-8")).toBe('{"exported":true}\n');
    expect(provider.exportExtension).toBe("json");
  });

  it("relies on the CLI to write the file when the export kind is file", async () => {
    writeFakeCli(
      ['if [ "$1" = "export" ]; then', '  printf "<html></html>" > "$4"', "fi"].join("\n"),
    );
    const provider = createCliProvider(
      config({
        export: {
          kind: "file",
          extension: "html",
          args: (id: string, outPath: string) => ["export", id, "--output", outPath],
        },
      }),
    );
    const outPath = path.join(storeDir, "session.html");

    const result = await provider.exportSession?.({ id: "a", outPath });

    expect(result).toEqual({ ok: true, bytes: 13 });
    expect(fs.readFileSync(outPath, "utf-8")).toBe("<html></html>");
  });

  it("fails when a file export produced nothing", async () => {
    writeFakeCli("exit 0");
    const provider = createCliProvider(
      config({ export: { kind: "file", extension: "html", args: () => ["export"] } }),
    );

    const result = await provider.exportSession?.({
      id: "a",
      outPath: path.join(storeDir, "missing.html"),
    });

    expect(result).toEqual({ ok: false, error: `${BINARY} did not write the export file` });
  });

  it("fails when the CLI is missing at export time", async () => {
    const provider = createCliProvider(
      config({ export: { kind: "stdout", extension: "json", args: () => ["export"] } }),
    );

    const result = await provider.exportSession?.({
      id: "a",
      outPath: path.join(storeDir, "session.json"),
    });

    expect(result?.ok).toBe(false);
  });
});
