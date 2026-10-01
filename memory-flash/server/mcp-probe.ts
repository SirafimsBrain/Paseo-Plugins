import { spawn } from "node:child_process";

/**
 * Live spawn check for a registered stdio MCP server.
 *
 * File-based status (`clineMcpStatus` and friends) answers "is the
 * entry present in the config file" — not "does the registered
 * command actually work". The probe spawns the registered command
 * exactly the way the agent would, sends an MCP `initialize`
 * request and waits for a JSON-RPC response on stdout. A positive
 * result means the command resolves, the process boots and speaks
 * the MCP handshake — the prerequisite for the agent's own
 * connection. Nothing is written to the database: the handshake
 * alone does not call any tool.
 */

/** Default time budget for the handshake, in milliseconds. */
export const PROBE_TIMEOUT_MS = 4000;

export interface McpProbeOptions {
  /** Time budget for the handshake. */
  timeoutMs?: number;
  /** Environment for the spawned process (defaults to the current one). */
  env?: NodeJS.ProcessEnv;
}

/** Spawns `command args` and checks that it answers an MCP initialize request. */
export function probeMcpServer(
  command: string,
  args: string[],
  options: McpProbeOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.kill("SIGTERM");
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "ignore"],
        env: options.env ?? process.env,
      });
    } catch {
      finish(false);
      return;
    }
    let buffer = "";
    const stdout = child.stdout;
    if (!stdout) {
      finish(false);
      return;
    }
    stdout.setEncoding("utf-8");
    stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length === 0) continue;
        try {
          const message = JSON.parse(line) as {
            jsonrpc?: unknown;
            id?: unknown;
            result?: unknown;
          };
          if (message.jsonrpc === "2.0" && message.id === 1 && message.result != null) {
            finish(true);
            return;
          }
        } catch {
          // Not JSON-RPC — ignore and keep reading.
        }
      }
    });
    const stdin = child.stdin;
    // Swallow write errors on a child that failed to boot.
    stdin?.on("error", () => undefined);
    child.on("error", () => finish(false));
    child.on("exit", () => finish(false));
    stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    );
  });
}

/** Augments a file-based MCP status with the live spawn result. */
export async function withLiveSpawn<
  T extends { installed: boolean; command: string | null; args: string[] | null },
>(status: T, timeoutMs?: number): Promise<T & { live: boolean | null }> {
  const live =
    status.installed && status.command !== null && status.args !== null
      ? await probeMcpServer(status.command, status.args, { timeoutMs })
      : null;
  return { ...status, live };
}
