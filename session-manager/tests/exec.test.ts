import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonLoose, resolveBinary, runCli } from "../server/exec";

describe("parseJsonLoose", () => {
  it("returns parsed JSON when the output is clean", () => {
    expect(parseJsonLoose('[{"id":"a"}]')).toEqual([{ id: "a" }]);
    expect(parseJsonLoose('{"id":"a"}')).toEqual({ id: "a" });
  });

  it("returns null for empty or non-JSON output", () => {
    expect(parseJsonLoose("")).toBeNull();
    expect(parseJsonLoose("   \n  ")).toBeNull();
    expect(parseJsonLoose("no payload here")).toBeNull();
  });

  it("recovers the payload from a kilo-style banner with box drawing characters", () => {
    const stdout = [
      "INFO  2026-09-21T18:16:25 +44ms service=default version=7.7.5 command=list",
      "██  ██ ██\u{1FBBA}\u{1FB8F}   ██  ██   ██\u{1FBBA}\u{1FB8F}     ████ ██     ██\u{1FBBA}\u{1FB8F}",
      "██  ██ ██████ \u{1FB81}\u{1FBAC}████ \u{1FB81}\u{1FBAC}██~~   \u{1FB81}\u{1FBAC}████ \u{1FB81}\u{1FBAC}████ ██████",
      "~~  ~~ ~~~~~~   ~~~~   ~~       ~~~~   ~~~~ ~~~~~~",
      '[{"id":"ses_1","title":"First"}]',
    ].join("\n");

    expect(parseJsonLoose(stdout)).toEqual([{ id: "ses_1", title: "First" }]);
  });

  it("ignores a banner that contains unbalanced braces of its own", () => {
    const stdout = 'loading config { "theme": "dark" \n[{"sessionId":"s1"}]\npretty-print { done }';
    expect(parseJsonLoose(stdout)).toEqual([{ sessionId: "s1" }]);
  });

  it("keeps brackets that appear inside JSON strings", () => {
    const payload = [{ id: "a", title: "half ] and } inside" }];
    expect(parseJsonLoose(`banner\n${JSON.stringify(payload)}\ntrailer`)).toEqual(payload);
  });

  it("returns the first payload that parses when a log line has braces", () => {
    const stdout = "{ not json }\n[{\"id\":\"real\"}]\n";
    expect(parseJsonLoose(stdout)).toEqual([{ id: "real" }]);
  });

  it("returns null when the payload is truncated", () => {
    expect(parseJsonLoose('[{"id":"a"')).toBeNull();
    expect(parseJsonLoose('log line\n{"id":"a"')).toBeNull();
  });
});

describe("resolveBinary", () => {
  it("does not find a binary that is not on PATH", () => {
    expect(resolveBinary("definitely-not-installed-agent-cli")).toBeNull();
  });

  it("resolves an executable found through PATH", () => {
    // `node` is running this suite, so it must be resolvable the same way.
    expect(resolveBinary("node")).not.toBeNull();
  });
});

describe("runCli", () => {
  it("reports stdout, the exit code, and no error on success", async () => {
    const result = await runCli(process.execPath, ["-e", "process.stdout.write('ok')"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("ok");
    expect(result.code).toBe(0);
    expect(result.error).toBeNull();
  });

  it("reports the failing exit code and the tail of stderr", async () => {
    const result = await runCli(process.execPath, [
      "-e",
      "process.stderr.write('first\\nlast line'); process.exit(3)",
    ]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.error).toBe("first last line");
  });

  it("runs the executable with the given cwd", async () => {
    const cwd = path.dirname(process.execPath);
    const result = await runCli(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
      cwd,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
