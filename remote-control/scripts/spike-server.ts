// Stage A3 spike entry: starts the console HTTP server + WebSocket bridge
// outside the plugin daemon so the live workspace-browser check can be run
// on demand (`node scripts/spike-transport.mjs --port <port>`), and reused
// for the final live acceptance (stage G4).
//
// It is bundled on the fly by `scripts/spike-transport.mjs` (esbuild) and
// imported from the bundle; no daemon/plugin-SDK dependency is required
// because both `server/http-server.ts` and `server/transport.ts` are plain
// Node modules.

import * as crypto from "node:crypto";
import { ConsoleHttpServer } from "../server/http-server";
import { WebSocketTransport } from "../server/transport";

export interface SpikeServerHandle {
  url: string;
  token: string;
  stop: () => Promise<void>;
}

export async function startSpikeServer(
  options: { port?: number; host?: string; token?: string } = {},
): Promise<SpikeServerHandle> {
  const token = options.token ?? `rc_spike_${crypto.randomBytes(12).toString("hex")}`;
  const transport = new WebSocketTransport({ token, log: console.log });
  const server = new ConsoleHttpServer({
    token,
    port: options.port ?? 0,
    host: options.host,
    transport,
    version: "0.3.0-spike",
  });
  try {
    await server.start();
  } catch (cause) {
    transport.dispose();
    throw cause;
  }
  return {
    url: server.url ?? `http://127.0.0.1:${server.boundTcpPort}/?token=${encodeURIComponent(token)}`,
    token,
    stop: () => server.stop(),
  };
}
