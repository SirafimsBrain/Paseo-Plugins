import * as fs from "node:fs";
import * as path from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { paseoHome } from "./store";

/**
 * Lazy singleton `DaemonClient` for the schedule bridge.
 *
 * The SDK's `PaseoApi` (what `context.paseo` provides) does not expose the
 * daemon's `schedule/*` RPCs — they live on the lower-level `DaemonClient`,
 * exported via `@getpaseo/client/internal/daemon-client`. The plugin process
 * therefore opens its own websocket connection to the local daemon and calls
 * the same RPCs the native Schedules UI uses. The client reconnects on its
 * own; the singleton lives for the plugin process lifetime.
 */

interface DaemonListenConfig {
  daemon?: { listen?: unknown };
}

export function daemonWsUrl(): string {
  const configPath = path.join(paseoHome(), "config.json");
  let listen: string | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as DaemonListenConfig;
    const raw = parsed.daemon?.listen;
    if (typeof raw === "string" && raw.trim().length > 0) listen = raw.trim();
  } catch {
    // Missing or unreadable config — fall back to the default port below.
  }
  if (listen === null) return "ws://127.0.0.1:6767/ws";
  const match = listen.match(/^\[([^\]]+)\]:(\d{1,5})$/) ?? listen.match(/^(.+?):(\d{1,5})$/);
  const host = match?.[1] ?? "127.0.0.1";
  const port = match?.[2] ?? "6767";
  const ipv6 = host.includes(":");
  return `ws://${ipv6 ? `[${host}]` : host}:${port}/ws`;
}

let cached: DaemonClient | null = null;
let connecting: Promise<DaemonClient> | null = null;

/** Connects (or reuses) the schedule-bridge client. Throws with a readable message. */
export async function getDaemonClient(): Promise<DaemonClient> {
  if (cached) return cached;
  if (!connecting) {
    const client = new DaemonClient({
      url: daemonWsUrl(),
      // Stable per-process identity so reconnects resume the same session.
      clientId: `cid_plugin_command_center_schedule`,
      clientType: "cli",
      suppressSendErrors: true,
      reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 15000 },
    });
    connecting = client
      .connect()
      .then(() => {
        cached = client;
        return client;
      })
      .catch((error: unknown) => {
        connecting = null;
        // Allow a later retry after a transient daemon restart.
        void client.close().catch(() => undefined);
        throw error;
      });
  }
  return connecting;
}

/** Test hook: drops the cached connection without closing the socket. */
export function resetDaemonClientForTests(): void {
  cached = null;
  connecting = null;
}
