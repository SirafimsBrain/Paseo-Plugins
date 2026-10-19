import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { DashboardEndpoint } from "../server/http-lifecycle";
import { DEFAULT_DASHBOARD_HOST } from "../server/http-server";
import { LuckPlannerStore } from "../server/store";
import { dashboardStatus } from "../shared/rpc";

/**
 * Stage F1 acceptance (`PLAN.md`): the lifecycle wrapper that keeps the
 * dashboard HTTP server in step with the settings. The class is what makes
 * "change the port/token/enable flag without a daemon restart" safe — the
 * tests pin the debounce, the serialised restart, the pinned-vs-auto token,
 * the busy-port fallback and that `dispose` really frees the socket.
 */

let dir: string;
let store: LuckPlannerStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "luck-planner-endpoint-"));
  store = new LuckPlannerStore({ dbPath: path.join(dir, "luck.db") });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function endpoint(): DashboardEndpoint {
  return new DashboardEndpoint({
    store,
    version: "0.17.0-test",
    dashboardDir: path.join(dir, "dashboard"),
    // Stage H1: the change feed polls the audit trail. Tests turn the default
    // one-second cadence down so an assertion never waits a second per event;
    // the production default is asserted where it is defined.
    changePollMs: 25,
    log: () => {},
    logError: () => {},
  });
}

/** SSE reader as `Response.body.getReader()` hands it over. */
interface SseReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/** Reads frames until `needle` shows up in the buffer (or the clock runs out). */
async function readUntil(
  reader: SseReader,
  needle: string,
  buffer: { text: string },
  timeoutMs = 3000,
): Promise<void> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (!buffer.text.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`timed out waiting for "${needle}"; got: ${buffer.text}`);
    }
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for "${needle}"`)), remaining),
      ),
    ]);
    if (result.done) break;
    if (result.value) buffer.text += decoder.decode(result.value, { stream: true });
  }
}

describe("DashboardEndpoint", () => {
  it("stays down while the setting is off", async () => {
    const ep = endpoint();
    try {
      ep.sync({ enabled: false, port: 0, accessToken: "" });
      await ep.settled();
      const status = ep.status();
      expect(status.enabled).toBe(false);
      expect(status.listening).toBe(false);
      expect(status.url).toBeNull();
    } finally {
      await ep.dispose();
    }
  });

  it("starts on an ephemeral port and reports a real status", async () => {
    const ep = endpoint();
    try {
      ep.sync({ enabled: true, port: 0, accessToken: "" });
      await ep.settled();
      const status = ep.status();
      expect(status.enabled).toBe(true);
      expect(status.listening).toBe(true);
      expect(status.host).toBe(DEFAULT_DASHBOARD_HOST);
      expect(status.boundPort).toBeGreaterThan(0);
      expect(status.error).toBeNull();
      // Empty setting → a generated token, never a well-known one.
      expect(status.token).toMatch(/^lp_[0-9a-f]+$/);
      expect(status.url).toContain("?token=");
    } finally {
      await ep.dispose();
    }
  });

  it("uses a pinned token verbatim", async () => {
    const ep = endpoint();
    try {
      ep.sync({ enabled: true, port: 0, accessToken: "  pinned-token  " });
      await ep.settled();
      expect(ep.status().token).toBe("pinned-token");
      const origin = new URL(ep.status().url!).origin;
      const ok = await fetch(`${origin}/api/tree?token=pinned-token&project=/p`);
      expect(ok.status).toBe(200);
      const denied = await fetch(`${origin}/api/tree?token=wrong&project=/p`);
      expect(denied.status).toBe(401);
    } finally {
      await ep.dispose();
    }
  });

  it("debounces a burst of syncs into a single listener", async () => {
    const ep = endpoint();
    try {
      // Typing a port one character at a time must not bind four sockets.
      for (const port of [8, 88, 889, 8899]) {
        ep.sync({ enabled: true, port, accessToken: "" });
      }
      await ep.settled();
      const status = ep.status();
      expect(status.listening).toBe(true);
      expect(status.port).toBe(8899);
      expect(ep.status().boundPort).toBeGreaterThan(0);
    } finally {
      await ep.dispose();
    }
  });

  it("falls back to an ephemeral port when the configured one is busy", async () => {
    const blocker = http.createServer((_req, res) => res.end("busy"));
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const busyPort = (blocker.address() as { port: number }).port;

    const ep = endpoint();
    try {
      ep.sync({ enabled: true, port: busyPort, accessToken: "" });
      await ep.settled();
      const status = ep.status();
      expect(status.listening).toBe(true);
      expect(status.portFallback).toBe(true);
      expect(status.boundPort).not.toBe(busyPort);
      expect(status.error).toBeNull();
    } finally {
      await ep.dispose();
    }
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it("restarts on a port change and releases the previous one", async () => {
    const ep = endpoint();
    try {
      ep.sync({ enabled: true, port: 0, accessToken: "" });
      await ep.settled();
      const first = ep.status().boundPort!;
      expect(first).toBeGreaterThan(0);

      // Restart on the exact first port; it must be free (proves the old
      // listener closed before the new one bound).
      ep.sync({ enabled: true, port: first, accessToken: "" });
      await ep.settled();
      const status = ep.status();
      expect(status.listening).toBe(true);
      expect(status.boundPort).toBe(first);
      expect(status.portFallback).toBe(false);
    } finally {
      await ep.dispose();
    }
  });

  it("stops the listener when the setting is turned off", async () => {
    const ep = endpoint();
    try {
      ep.sync({ enabled: true, port: 0, accessToken: "" });
      await ep.settled();
      expect(ep.status().listening).toBe(true);

      ep.sync({ enabled: false, port: 0, accessToken: "" });
      await ep.settled();
      expect(ep.status().listening).toBe(false);
      expect(ep.status().url).toBeNull();
    } finally {
      await ep.dispose();
    }
  });

  // ── Stage F2: the per-project address the client opens ──────────────────

  it("builds a project URL a browser can open, and none while down", async () => {
    const ep = endpoint();
    try {
      expect(ep.projectUrl("/projects/demo")).toBeNull();

      ep.sync({ enabled: true, port: 0, accessToken: "" });
      await ep.settled();

      const url = ep.projectUrl("/projects/Paseo plugins")!;
      const parsed = new URL(url);
      expect(parsed.origin).toBe(new URL(ep.status().url!).origin);
      expect(parsed.searchParams.get("token")).toBe(ep.status().token);
      // A path with a space must survive the round trip.
      expect(parsed.searchParams.get("project")).toBe("/projects/Paseo plugins");

      const page = await fetch(url);
      expect(page.status).toBe(200);
    } finally {
      await ep.dispose();
    }
  });

  // ── Stage H1: agent writes reach the dashboard without a refresh ─────────

  /**
   * The acceptance scenario of stage H1, and the reason the change feed polls
   * the shared audit trail instead of hooking `store.write`: the writer here is
   * a **second store instance on the same file** — exactly what an agent
   * process writing through the MCP server is — and it must show up on an open
   * SSE stream without anyone touching the endpoint.
   */
  it("pushes tree-changed to open streams when another connection writes", async () => {
    const ep = endpoint();
    const controller = new AbortController();
    try {
      ep.sync({ enabled: true, port: 0, accessToken: "" });
      await ep.settled();
      const status = ep.status();
      const origin = new URL(status.url!).origin;
      const projectKey = "/projects/live";

      const res = await fetch(
        `${origin}/api/events?token=${status.token}&project=${encodeURIComponent(projectKey)}`,
        { signal: controller.signal },
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader() as unknown as SseReader;
      const buffer = { text: "" };
      await readUntil(reader, "event: ready", buffer);
      // `ready` carries the cursor the stream resumes from, not an empty object.
      expect(buffer.text).toMatch(/"version":"0\.17\.0-test","watermark":\d+/);

      // The agent's process: its own connection to the same database file.
      const writer = new LuckPlannerStore({ dbPath: store.dbPath });
      const root = writer.createNode({
        projectKey,
        parentId: null,
        kind: "root",
        name: "Live project",
        actor: "agent:coder",
      });
      writer.close();

      await readUntil(reader, "event: tree-changed", buffer);
      expect(buffer.text).toContain(`"projectKey":"${projectKey}"`);
      expect(buffer.text).toContain(root.id);
      expect(buffer.text).toContain('"entityType":"node"');
    } finally {
      controller.abort();
      await ep.dispose();
    }
  });

  it("does not wake a stream opened for another project", async () => {
    const ep = endpoint();
    const controller = new AbortController();
    try {
      ep.sync({ enabled: true, port: 0, accessToken: "" });
      await ep.settled();
      const status = ep.status();
      const origin = new URL(status.url!).origin;
      const watching = "/projects/watched";

      const res = await fetch(
        `${origin}/api/events?token=${status.token}&project=${encodeURIComponent(watching)}`,
        { signal: controller.signal },
      );
      const reader = res.body!.getReader() as unknown as SseReader;
      const buffer = { text: "" };
      await readUntil(reader, "event: ready", buffer);

      // A daemon hosts many workspaces: a write in one project must not make
      // a tab open on another refetch.
      const writer = new LuckPlannerStore({ dbPath: store.dbPath });
      writer.createNode({
        projectKey: "/projects/other",
        parentId: null,
        kind: "root",
        name: "Other project",
        actor: "agent:coder",
      });
      writer.close();

      // Give the feed several ticks to (not) deliver, then prove the stream
      // still works by writing to the project it *is* watching.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(buffer.text).not.toContain("event: tree-changed");

      const mine = new LuckPlannerStore({ dbPath: store.dbPath });
      mine.createNode({
        projectKey: watching,
        parentId: null,
        kind: "root",
        name: "Watched project",
        actor: "agent:coder",
      });
      mine.close();
      await readUntil(reader, "event: tree-changed", buffer);
      expect(buffer.text).not.toContain("/projects/other");
    } finally {
      controller.abort();
      await ep.dispose();
    }
  });

  it("drops the project URL when the setting is turned off", async () => {
    const ep = endpoint();
    try {
      ep.sync({ enabled: true, port: 0, accessToken: "" });
      await ep.settled();
      expect(ep.projectUrl("/p")).not.toBeNull();

      ep.sync({ enabled: false, port: 0, accessToken: "" });
      await ep.settled();
      expect(ep.projectUrl("/p")).toBeNull();
    } finally {
      await ep.dispose();
    }
  });

  it("dispose frees the socket", async () => {
    const ep = endpoint();
    ep.sync({ enabled: true, port: 0, accessToken: "" });
    await ep.settled();
    const status = ep.status();
    const port = status.boundPort!;
    await ep.dispose();

    // The port is free again and further syncs are ignored.
    ep.sync({ enabled: true, port, accessToken: "" });
    await ep.settled();
    expect(ep.status().listening).toBe(false);

    const reuse = http.createServer((_req, res) => res.end("reuse"));
    await new Promise<void>((resolve, reject) => {
      reuse.once("error", reject);
      reuse.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => reuse.close(() => resolve()));
  });
});

// ── Plugin wiring: the endpoint really starts and stops with the plugin ──

interface SettingsValues {
  injectIntoAgents: boolean;
  mcpServerName: string;
  httpEnabled: boolean;
  httpPort: number;
  accessToken: string;
  historyRetentionDays: number;
}

/**
 * Minimal `PluginServerContext` for the wiring test: `registerSettings`
 * answers one ready doc, and hooks/handlers are accepted and discarded. The
 * dashboard is observed through its own log line, so no RPC is needed.
 */
function fakeServer(values: SettingsValues): PluginServerContext {
  const server = {
    registerSettings() {
      return {
        async read() {
          return { status: "ready" as const, revision: "1", values };
        },
        subscribe() {
          return () => {};
        },
      };
    },
    handle() {},
    before() {
      return () => {};
    },
    on() {
      return () => {};
    },
    registerProvider() {},
    registerUsageSource() {},
  };
  return server as unknown as PluginServerContext;
}

/**
 * Same fake, but keeps the RPC handlers so the F2 wiring test can call
 * `luck-planner.dashboard-status` exactly as the panel does.
 */
interface CapturingServer extends PluginServerContext {
  call<T>(name: string, input: unknown): Promise<T>;
}

function capturingServer(values: SettingsValues): CapturingServer {
  const handlers = new Map<string, (input: never, context: never) => unknown>();
  const server = {
    registerSettings() {
      return {
        async read() {
          return { status: "ready" as const, revision: "1", values };
        },
        subscribe() {
          return () => {};
        },
      };
    },
    handle(
      contract: { name: string },
      handler: (input: never, context: never) => unknown,
    ) {
      handlers.set(contract.name, handler);
    },
    before() {
      return () => {};
    },
    on() {
      return () => {};
    },
    registerProvider() {},
    registerUsageSource() {},
    async call<T>(name: string, input: unknown): Promise<T> {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No handler registered for ${name}`);
      // The SDK always hands a handler its context; this suite does not
      // exercise the daemon SDK, so the handle is absent — stage H2's
      // capture ignores it and the timeline feed simply stays unarmed.
      return (await handler(input as never, { paseo: undefined } as never)) as T;
    },
  };
  return server as unknown as CapturingServer;
}

/** Waits for the `dashboard listening on <url>` line from `contribute`. */
async function waitForDashboardUrl(
  logs: string[],
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const line of logs) {
      const match = /\[luck-planner\] dashboard listening on (\S+)/.exec(line);
      if (match) return match[1];
    }
    if (Date.now() > deadline) {
      throw new Error(`dashboard never started; logs: ${logs.join(" | ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("plugin wiring (contribute)", () => {
  const originalHome = process.env.PASEO_HOME;

  it("starts the dashboard from the plugin lifecycle and frees the port on cleanup", async () => {
    process.env.PASEO_HOME = dir;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "));
    });

    const cleanup = contribute(
      fakeServer({
        injectIntoAgents: true,
        mcpServerName: "luck-planner",
        httpEnabled: true,
        httpPort: 0,
        accessToken: "",
        historyRetentionDays: 0,
      }),
    );

    let origin = "";
    try {
      const url = await waitForDashboardUrl(logs);
      const parsed = new URL(url);
      origin = parsed.origin;
      expect(parsed.hostname).toBe(DEFAULT_DASHBOARD_HOST);
      // `accessToken: ""` → an auto-generated, non-guessable token.
      const token = parsed.searchParams.get("token");
      expect(token).toMatch(/^lp_[0-9a-f]+$/);

      const health = await fetch(`${origin}/health`);
      expect(health.status).toBe(200);
      expect((await health.json()).server).toBe("luck-planner");

      const allowed = await fetch(`${origin}/api/tree?token=${token}&project=/p`);
      expect(allowed.status).toBe(200);

      const denied = await fetch(`${origin}/api/tree?token=wrong&project=/p`);
      expect(denied.status).toBe(401);
    } finally {
      await cleanup();
      spy.mockRestore();
      if (originalHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = originalHome;
    }

    // Cleanup awaited the socket close: the port no longer answers.
    await expect(fetch(`${origin}/health`)).rejects.toThrow();
  });

  // Stage F2: the client opens the dashboard through this RPC, so the URL it
  // answers has to be the *live* one — token included — and it has to work.
  it("answers dashboard-status with a working, tokenised project URL", async () => {
    process.env.PASEO_HOME = dir;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "));
    });

    const server = capturingServer({
      injectIntoAgents: true,
      mcpServerName: "luck-planner",
      httpEnabled: true,
      httpPort: 0,
      accessToken: "",
      historyRetentionDays: 0,
    });
    const cleanup = contribute(server);

    try {
      const logged = new URL(await waitForDashboardUrl(logs));
      const projectKey = "/projects/Paseo plugins"; // space + slashes: encoded

      const status = await server.call<{
        enabled: boolean;
        listening: boolean;
        url: string | null;
        port: number | null;
        portFallback: boolean;
        error: string | null;
      }>(dashboardStatus.name, { projectKey });

      expect(status.enabled).toBe(true);
      expect(status.listening).toBe(true);
      expect(status.port).toBe(Number(logged.port));
      expect(status.portFallback).toBe(false);
      expect(status.error).toBeNull();

      const url = new URL(status.url!);
      expect(url.origin).toBe(logged.origin);
      expect(url.searchParams.get("token")).toBe(logged.searchParams.get("token"));
      expect(url.searchParams.get("project")).toBe(projectKey);

      // The URL the client hands to the browser really serves the dashboard...
      const page = await fetch(status.url!);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("luck-planner dashboard");

      // ...and its token is the one the API accepts for that project.
      const api = await fetch(
        `${url.origin}/api/stats?token=${url.searchParams.get("token")}&project=${encodeURIComponent(projectKey)}`,
      );
      expect(api.status).toBe(200);
      expect((await api.json()).projectKey).toBe(projectKey);
    } finally {
      await cleanup();
      spy.mockRestore();
      if (originalHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = originalHome;
    }
  });
});
