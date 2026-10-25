import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsoleHttpServer } from "../server/http-server";

const TOKEN = "test-token";
let dir: string;
let server: ConsoleHttpServer;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "remote-control-http-"));
  server = new ConsoleHttpServer({ token: TOKEN, port: 0 });
  await server.start();
  base = server.origin!;
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("console http server", () => {
  it("health is public", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; server?: string };
    expect(body.ok).toBe(true);
    expect(body.server).toBe("remote-control");
  });

  it("api requires token", async () => {
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(401);
  });

  it("api works with token", async () => {
    const res = await fetch(`${base}/api/state?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });
});
