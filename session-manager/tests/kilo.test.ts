import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kiloProvider } from "../server/providers/kilo";

/**
 * Kilo prints a per-session `status` object in `session list --format json`.
 * Since 0.6.0 the adapter maps it to `running` (`idle` is the only value known
 * to mean "nothing is using this session"), so the delete guard refuses a busy
 * session instead of deleting it — before this the flag was hard-coded `false`
 * and any Kilo session could be deleted while a runtime still held it.
 */

let binDir: string;
let dataHome: string;
let originalPath: string | undefined;

/** A stub `kilo` that prints the rows below for `session list`. */
function writeFakeKilo(rows: unknown[]): void {
  const file = path.join(binDir, "kilo");
  fs.writeFileSync(file, `#!/bin/sh\necho '${JSON.stringify(rows)}'\n`, "utf-8");
  fs.chmodSync(file, 0o755);
}

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-kilo-bin-"));
  dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-kilo-data-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.XDG_DATA_HOME = dataHome;
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.XDG_DATA_HOME;
  fs.rmSync(binDir, { recursive: true, force: true });
  fs.rmSync(dataHome, { recursive: true, force: true });
});

describe("kilo running status", () => {
  it("treats an idle session as not running", async () => {
    writeFakeKilo([{ id: "ses_idle", status: { type: "idle" } }]);
    const result = await kiloProvider.list();
    expect(result.sessions[0]?.running).toBe(false);
  });

  it("treats any other status as running", async () => {
    writeFakeKilo([{ id: "ses_busy", status: { type: "busy" } }]);
    const result = await kiloProvider.list();
    expect(result.sessions[0]?.running).toBe(true);
  });

  it("keeps a session without a status field deletable", async () => {
    writeFakeKilo([{ id: "ses_plain" }]);
    const result = await kiloProvider.list();
    expect(result.sessions[0]?.running).toBe(false);
  });
});
