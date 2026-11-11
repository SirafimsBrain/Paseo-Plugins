import * as http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { renderDashboardHtml } from "../shared/dashboard";
import { loadCommands, loadHistory } from "./store";

/**
 * Loopback-only, read-only dashboard server (0.12.0).
 *
 * Design constraints, all deliberate:
 *
 * - binds `127.0.0.1` on an ephemeral port — nothing is reachable from the
 *   network, so there is no "expose my prompts to the LAN" switch to get wrong;
 * - a fresh per-process token is embedded in the URL and required on every
 *   request, because the library contains prompt text and the history contains
 *   arguments;
 * - GET/HEAD only, one route, no forms or actions — the page cannot mutate the
 *   store even with the token;
 * - strict response headers (`no-store`, a `default-src 'none'` CSP) so the page
 *   cannot load or leak anything else;
 * - the server is stopped by the plugin's own disposer.
 */

let server: http.Server | null = null;
let token = "";
let port = 0;
let starting: Promise<{ url: string | null; error: string | null }> | null = null;

function dashboardUrl(): string {
  return `http://127.0.0.1:${port}/?token=${token}`;
}

/** Constant-time comparison over fixed-size digests (length-independent). */
function tokenMatches(provided: string): boolean {
  if (token.length === 0) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(token));
}

function handler(request: http.IncomingMessage, response: http.ServerResponse): void {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  if (url.pathname !== "/") {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  if (!tokenMatches(url.searchParams.get("token") ?? "")) {
    response.writeHead(401, { "cache-control": "no-store" });
    response.end("Unauthorized");
    return;
  }
  const html = renderDashboardHtml({
    commands: loadCommands(),
    history: loadHistory(),
    now: new Date(),
  });
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(method === "HEAD" ? undefined : html);
}

/** Starts the dashboard on first use; later calls return the same URL. */
export async function ensureDashboard(): Promise<{ url: string | null; error: string | null }> {
  if (server) return { url: dashboardUrl(), error: null };
  if (starting) return starting;
  starting = new Promise((resolve) => {
    const secret = randomBytes(24).toString("hex");
    const created = http.createServer(handler);
    const fail = (error: unknown) => {
      starting = null;
      void created.close();
      resolve({
        url: null,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    created.once("error", fail);
    created.listen(0, "127.0.0.1", () => {
      const address = created.address();
      if (!address || typeof address === "string") {
        fail(new Error("The dashboard could not determine its port."));
        return;
      }
      created.off("error", fail);
      server = created;
      token = secret;
      port = address.port;
      starting = null;
      resolve({ url: dashboardUrl(), error: null });
    });
  });
  return starting;
}

/** Stops the server (plugin disposer / tests). */
export function stopDashboard(): void {
  const current = server;
  server = null;
  token = "";
  port = 0;
  starting = null;
  current?.close();
}
