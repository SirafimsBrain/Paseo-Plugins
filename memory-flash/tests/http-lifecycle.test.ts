import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../server/store";
import { HttpEndpoint, type HttpEndpointConfig } from "../server/http-lifecycle";

/**
 * Regression cover for the bind-address switch (0.5.2): changing the bind
 * address used to leave a stale listener behind, and the status line kept
 * reporting the old `127.0.0.1` address after a wildcard bind.
 */

let dir: string;
let store: MemoryStore;
let endpoint: HttpEndpoint;

function config(overrides: Partial<HttpEndpointConfig> = {}): HttpEndpointConfig {
  return {
    httpEnabled: true,
    httpHost: "127.0.0.1",
    httpPort: 0,
    defaultAgentId: "",
    serverName: "memory-flash",
    ...overrides,
  };
}

/** A TCP port that was free a moment ago; good enough for a serial test run. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** True when something accepts a TCP connection on `host:port`. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

/** First non-internal IPv4 of this machine, or null when there is none. */
function lanAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-lifecycle-"));
  store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
  endpoint = new HttpEndpoint({
    store,
    serverInfo: { name: "memory-flash", version: "0.1.1" },
  });
});

afterEach(async () => {
  await endpoint.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("HttpEndpoint bind address", () => {
  it("rebinds from loopback to the wildcard and reports both addresses", async () => {
    const port = await freePort();
    endpoint.sync(config({ httpHost: "127.0.0.1", httpPort: port }));
    await endpoint.settled();

    let status = endpoint.status();
    expect(status.listening).toBe(true);
    expect(status.error).toBeNull();
    expect(status.boundHost).toBe("127.0.0.1");
    expect(status.wildcard).toBe(false);
    expect(status.bindUrl).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(status.url).toBe(`http://127.0.0.1:${port}/mcp`);

    endpoint.sync(config({ httpHost: "0.0.0.0", httpPort: port }));
    await endpoint.settled();

    status = endpoint.status();
    expect(status.error).toBeNull();
    expect(status.listening).toBe(true);
    // The socket really moved to the wildcard — the status line must say so
    // instead of quietly keeping the old address.
    expect(status.boundHost).toBe("0.0.0.0");
    expect(status.wildcard).toBe(true);
    expect(status.bindUrl).toBe(`http://0.0.0.0:${port}/mcp`);
    // The copy URL stays dialable: no wildcard in it.
    expect(status.url).not.toContain("0.0.0.0");
    expect(status.url).toMatch(/^http:\/\/(127\.0\.0\.1|\d+\.\d+\.\d+\.\d+|\[[0-9a-f:]+\]):\d+\/mcp$/);
    const lan = lanAddress();
    if (lan !== null) {
      expect(status.url).toBe(`http://${lan}:${port}/mcp`);
      const health = await fetch(`http://${lan}:${port}/healthz`);
      expect(health.status).toBe(200);
    }
  });

  it("keeps exactly one listener when the port changes", async () => {
    const first = await freePort();
    endpoint.sync(config({ httpHost: "127.0.0.1", httpPort: first }));
    await endpoint.settled();
    expect(await accepts("127.0.0.1", first)).toBe(true);

    const second = await freePort();
    endpoint.sync(config({ httpHost: "127.0.0.1", httpPort: second }));
    await endpoint.settled();

    const status = endpoint.status();
    expect(status.boundPort).toBe(second);
    expect(await accepts("127.0.0.1", second)).toBe(true);
    // The old socket must be gone — a leaked listener used to survive here and
    // keep answering on a port the settings no longer mention.
    expect(await accepts("127.0.0.1", first)).toBe(false);
  });

  it("applies only the last value of a typed bind address", async () => {
    const port = await freePort();
    endpoint.sync(config({ httpHost: "127.0.0.1", httpPort: port }));
    await endpoint.settled();

    // Exactly what the settings screen produces while "0.0.0.0" is typed.
    for (const host of ["0", "0.", "0.0", "0.0.", "0.0.0", "0.0.0.", "0.0.0.0"]) {
      endpoint.sync(config({ httpHost: host, httpPort: port }));
    }
    await endpoint.settled();

    const status = endpoint.status();
    expect(status.error).toBeNull();
    expect(status.boundHost).toBe("0.0.0.0");
    expect(await accepts("127.0.0.1", port)).toBe(true);
  });

  it("serialises back-to-back changes instead of interleaving them", async () => {
    const first = await freePort();
    const second = await freePort();
    endpoint.sync(config({ httpHost: "127.0.0.1", httpPort: first }));
    await endpoint.settled();

    // Two changes inside one settle window, no await in between.
    endpoint.sync(config({ httpHost: "0.0.0.0", httpPort: first }));
    endpoint.sync(config({ httpHost: "0.0.0.0", httpPort: second }));
    await endpoint.settled();

    const status = endpoint.status();
    expect(status.boundHost).toBe("0.0.0.0");
    expect(status.boundPort).toBe(second);
    expect(await accepts("127.0.0.1", second)).toBe(true);
    expect(await accepts("127.0.0.1", first)).toBe(false);
  });

  it("reports a start failure and recovers on the next valid address", async () => {
    const port = await freePort();
    endpoint.sync(config({ httpHost: "127.0.0.1", httpPort: port }));
    await endpoint.settled();

    // `.invalid` never resolves, so the bind fails.
    endpoint.sync(config({ httpHost: "no-such-host.invalid", httpPort: port }));
    await endpoint.settled();
    expect(endpoint.status().error).not.toBeNull();
    expect(endpoint.status().listening).toBe(false);
    expect(await accepts("127.0.0.1", port)).toBe(false);

    endpoint.sync(config({ httpHost: "127.0.0.1", httpPort: port }));
    await endpoint.settled();
    const status = endpoint.status();
    expect(status.error).toBeNull();
    expect(status.listening).toBe(true);
    expect(await accepts("127.0.0.1", port)).toBe(true);
  });

  it("stops the endpoint when the setting is turned off", async () => {
    const port = await freePort();
    endpoint.sync(config({ httpHost: "127.0.0.1", httpPort: port }));
    await endpoint.settled();
    expect(await accepts("127.0.0.1", port)).toBe(true);

    endpoint.sync(config({ httpEnabled: false, httpPort: port }));
    await endpoint.settled();

    const status = endpoint.status();
    expect(status.enabled).toBe(false);
    expect(status.listening).toBe(false);
    expect(status.url).toBeNull();
    expect(await accepts("127.0.0.1", port)).toBe(false);
  });

  it("applies a new default agent id without a restart", async () => {
    const port = await freePort();
    endpoint.sync(config({ httpHost: "127.0.0.1", httpPort: port }));
    await endpoint.settled();

    const { secret } = store.generateApiKey({ label: "laptop" });
    const url = endpoint.status().url!;
    endpoint.sync(config({ httpHost: "127.0.0.1", httpPort: port, defaultAgentId: "agent-42" }));
    await endpoint.settled();

    // Same bound port → no restart, but the new default must be in effect.
    expect(endpoint.status().boundPort).toBe(port);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_save", arguments: { title: "t", content: "c" } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.content[0].text).toContain('"saved": true');
    expect(store.getById(1)?.agentId).toBe("agent-42");
  });

  it("stops the socket on dispose and ignores later syncs", async () => {
    const port = await freePort();
    endpoint.sync(config({ httpHost: "127.0.0.1", httpPort: port }));
    await endpoint.settled();

    await endpoint.dispose();
    expect(await accepts("127.0.0.1", port)).toBe(false);

    endpoint.sync(config({ httpHost: "0.0.0.0", httpPort: port }));
    await endpoint.settled();
    expect(endpoint.status().listening).toBe(false);
    expect(await accepts("127.0.0.1", port)).toBe(false);
  });
});
