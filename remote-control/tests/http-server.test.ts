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

  // Stage 1.1.0: the token is traded for an HttpOnly cookie on the first page
  // request and dropped from the URL, so it stops living in browser history.
  it("trades the page token for a session cookie", async () => {
    const res = await fetch(`${base}/?token=${TOKEN}&workspaceId=w1`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?workspaceId=w1");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`rc_session=${TOKEN}`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=strict");
  });

  it("accepts the session cookie on api calls", async () => {
    const res = await fetch(`${base}/api/state`, {
      headers: { cookie: `other=1; rc_session=${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong cookie and does not redirect a wrong token", async () => {
    const withCookie = await fetch(`${base}/api/state`, {
      headers: { cookie: `rc_session=nope` },
    });
    expect(withCookie.status).toBe(401);
    const page = await fetch(`${base}/?token=nope`, { redirect: "manual" });
    expect(page.status).not.toBe(302);
  });
});
