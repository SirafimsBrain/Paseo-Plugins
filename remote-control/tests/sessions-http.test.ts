// /api/sessions (stage 0.23.10): one list for Paseo terminals and the RDP/VNC
// windows the plugin spawned, with one kill route for both.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsoleHttpServer } from "../server/http-server";
import { ExternalSessionRegistry } from "../server/sessions";
import type { TerminalService } from "../server/terminals";

const TOKEN = "test-token";

let server: ConsoleHttpServer;
let base: string;
let sessions: ExternalSessionRegistry;
let killedTerminals: string[];
let alive: boolean;

beforeEach(async () => {
  alive = true;
  killedTerminals = [];
  sessions = new ExternalSessionRegistry({ isAlive: () => alive });
  const terminals = {
    list: async () => [
      {
        id: "term_1",
        kind: "ssh",
        name: "ssh desktop",
        workspaceId: "ws_1",
        connectionId: "conn_ssh",
        cwd: "/home/alice",
        startedAt: 5,
      },
    ],
    kill: async (id: string) => {
      killedTerminals.push(id);
      return id === "term_1";
    },
  } as unknown as TerminalService;
  server = new ConsoleHttpServer({ token: TOKEN, port: 0, terminals, sessions });
  await server.start();
  base = server.origin!;
});

afterEach(async () => {
  await server.stop();
});

describe("/api/sessions", () => {
  it("merges external windows and Paseo terminals into one list", async () => {
    const info = sessions.register({
      connection: { id: "conn_rdp", name: "rdp desktop", host: "10.0.0.7", port: 3389 },
      protocol: "rdp",
      pid: 42,
      binary: "xfreerdp3",
    });
    const res = await fetch(`${base}/api/sessions?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: any[] };
    expect(body.sessions).toHaveLength(2);
    const external = body.sessions.find((s) => s.id === info.id);
    expect(external).toMatchObject({
      kind: "rdp",
      name: "rdp desktop",
      target: "10.0.0.7:3389",
      pid: 42,
      binary: "xfreerdp3",
      workspaceId: null,
    });
    const terminal = body.sessions.find((s) => s.id === "term_1");
    expect(terminal).toMatchObject({ kind: "ssh", target: "/home/alice", pid: null });
  });

  it("kills an external window through the registry", async () => {
    const info = sessions.register({
      connection: { id: "conn_vnc", name: "vnc desktop", host: "10.0.0.7", port: 5900 },
      protocol: "vnc",
      pid: 43,
      binary: "vncviewer",
    });
    const res = await fetch(`${base}/api/sessions/${info.id}/kill?token=${TOKEN}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sessions.get(info.id)).toBeNull();
    expect(killedTerminals).toEqual([]);
  });

  it("falls back to the terminal service for Paseo sessions", async () => {
    const res = await fetch(`${base}/api/sessions/term_1/kill?token=${TOKEN}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(killedTerminals).toEqual(["term_1"]);
  });

  it("reports an unknown session as not found", async () => {
    const res = await fetch(`${base}/api/sessions/nope/kill?token=${TOKEN}`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("keeps the legacy terminals route working", async () => {
    const res = await fetch(`${base}/api/terminals?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { terminals: any[] };
    expect(body.terminals.map((t) => t.id)).toEqual(["term_1"]);
    const kill = await fetch(`${base}/api/terminals/term_1/kill?token=${TOKEN}`, { method: "POST" });
    expect(kill.status).toBe(200);
  });

  it("drops sessions whose window has exited", async () => {
    const info = sessions.register({
      connection: { id: "conn_rdp", name: "rdp desktop", host: "10.0.0.7", port: 3389 },
      protocol: "rdp",
      pid: 44,
      binary: "xfreerdp3",
    });
    alive = false;
    const res = await fetch(`${base}/api/sessions?token=${TOKEN}`);
    const body = (await res.json()) as { sessions: any[] };
    expect(body.sessions.some((s) => s.id === info.id)).toBe(false);
  });
});
