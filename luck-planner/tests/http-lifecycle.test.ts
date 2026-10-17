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
    log: () => {},
    logError: () => {},
  });
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
});
