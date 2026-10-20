import { describe, expect, it } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stage D2 acceptance (PLAN.md): a real spawn of the built
 * `dist/mcp-server.js` — initialize handshake, tools/list and tools/call
 * over stdio — plus the determinism of `scripts/bundle.mjs`. The bundle is
 * produced by `pretest` (and by the plugin's build step), and the determinism
 * test rebuilds it into *temp* roots, never into `dist/`: parallel test files
 * read the built dashboard graph, and the chunk sweep of a rebuild inside the
 * shared directory used to unlink files under them. Instead of re-creating
 * the artifact, the test asserts that the committed one **is** a fresh build,
 * so a stale `dist/` fails loudly rather than being silently patched.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SERVER_BUNDLE = path.join(ROOT, "dist", "mcp-server.js");
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
) as { version: string };

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (cause: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function startServer(home: string, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [SERVER_BUNDLE], {
    env: {
      ...process.env,
      PASEO_HOME: home,
      LUCK_PLANNER_AGENT_ID: "e2e-agent",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let unparsedStdoutLines = 0;
  const received: Array<Record<string, unknown>> = [];
  const pending = new Map<number, Pending>();
  let nextId = 1;
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // stdout carries the protocol and nothing else — a non-JSON line
        // is a purity violation, recorded and asserted below.
        unparsedStdoutLines += 1;
        continue;
      }
      received.push(message);
      const id = message.id as number | undefined;
      if (id !== undefined && pending.has(id)) {
        const entry = pending.get(id) as Pending;
        clearTimeout(entry.timer);
        pending.delete(id);
        if (message.error) {
          entry.reject(
            new Error(String((message.error as { message: string }).message)),
          );
        } else {
          entry.resolve(message.result as Record<string, unknown>);
        }
      }
    }
  });
  child.stderr.on("data", () => {
    // stderr carries diagnostics (ready line, tool failures) — never asserted.
  });

  const request = (
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`,
      );
    });
  };

  /** Fire-and-forget notification — the server must not answer it. */
  const notify = (method: string): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  };

  /** Raw stdin write — used to feed a non-JSON line to the parser. */
  const writeRaw = (data: string): void => {
    child.stdin.write(data);
  };

  return {
    request,
    notify,
    writeRaw,
    received,
    unparsed: () => unparsedStdoutLines,
    stop: () => {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

describe("MCP server end-to-end (real process)", () => {
  it("reports the mcpServerName setting from LUCK_PLANNER_SERVER_NAME", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "luck-e2e-name-"));
    const server = startServer(home, { LUCK_PLANNER_SERVER_NAME: "custom-luck" });
    try {
      const init = await server.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0.0.1" },
      });
      const info = init.serverInfo as { name: string; version: string };
      // Stage D3: the injected config carries the setting through env.
      expect(info.name).toBe("custom-luck");
      expect(info.version).toBe(PKG_VERSION.version);
      // stdout stayed protocol-only during the override handshake.
      expect(server.unparsed()).toBe(0);
    } finally {
      server.stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  it("rebuilds the bundle deterministically, without touching the committed artifact", () => {
    // The build goes to temp roots (see `scripts/bundle.mjs --outdir`): a
    // rebuild of the shared `dist/` here would race the parallel test files
    // that read `dist/dashboard/assets/chunk-*.js`.
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "luck-planner-mcp-a-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "luck-planner-mcp-b-"));
    try {
      const build = (outRoot: string): string => {
        execFileSync(
          process.execPath,
          [path.join(ROOT, "scripts", "bundle.mjs"), "--outdir", outRoot],
          { cwd: ROOT, stdio: "pipe" },
        );
        return createHash("sha256")
          .update(fs.readFileSync(path.join(outRoot, "dist", "mcp-server.js")))
          .digest("hex");
      };
      const digestA = build(first);
      const digestB = build(second);
      expect(digestB).toBe(digestA);
      // The committed bundle is that very build — which is what makes the
      // spawn below (and on a fresh clone) meaningful.
      expect(
        createHash("sha256").update(fs.readFileSync(SERVER_BUNDLE)).digest("hex"),
      ).toBe(digestA);
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  }, 120000);

  it("handshakes, lists the documented tools and round-trips a goal", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "luck-e2e-"));
    const server = startServer(home);
    try {
      const init = await server.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0.0.1" },
      });
      const info = init.serverInfo as { name: string; version: string };
      expect(info.name).toBe("luck-planner");
      // Drift guard: what agents see must be the released plugin version.
      expect(info.version).toBe(PKG_VERSION.version);
      expect(init.protocolVersion).toBe("2024-11-05");

      // A notification gets no response; ordering guarantees the next
      // request's answer comes after it was processed.
      server.notify("notifications/initialized");
      const ping = await server.request("ping");
      expect(ping).toEqual({});

      const tools = await server.request("tools/list");
      const toolNames = (tools.tools as Array<{ name: string }>).map(
        (tool) => tool.name,
      );
      expect(toolNames).toEqual([
        "luck_tree_get_context",
        "luck_tree_search",
        "luck_tree_upsert_leaf",
        "luck_tree_upsert_node",
        "luck_tree_move_node",
        "luck_tree_archive_node",
        "luck_tree_add_bee",
        "luck_tree_report_bug",
        "luck_tree_set_goal",
        "luck_tree_update_growth",
        "luck_tree_history",
      ]);

      // Round trip: create a draft, propose it, read the audit trail.
      const projectKey = "/tmp/luck-e2e-project";
      const created = await server.request("tools/call", {
        name: "luck_tree_set_goal",
        arguments: {
          projectKey,
          action: "create",
          formalText: "Automate dunning for failed charges",
          plan: [
            {
              id: "step-1",
              title: "retry with backoff",
              description: "",
            },
          ],
        },
      });
      const createdPayload = JSON.parse(
        (created.content as Array<{ text: string }>)[0].text,
      ) as { goal: { id: string; status: string; createdBy: string | null } };
      expect(createdPayload.goal.status).toBe("draft");
      // Actor comes from the launch environment (LUCK_PLANNER_AGENT_ID).
      expect(createdPayload.goal.createdBy).toBe("e2e-agent");

      const proposed = await server.request("tools/call", {
        name: "luck_tree_set_goal",
        arguments: {
          projectKey,
          action: "propose",
          goalId: createdPayload.goal.id,
        },
      });
      const proposedPayload = JSON.parse(
        (proposed.content as Array<{ text: string }>)[0].text,
      ) as { goal: { status: string } };
      expect(proposedPayload.goal.status).toBe("proposed");

      const history = await server.request("tools/call", {
        name: "luck_tree_history",
        arguments: { projectKey, entityId: createdPayload.goal.id },
      });
      const historyPayload = JSON.parse(
        (history.content as Array<{ text: string }>)[0].text,
      ) as { entries: Array<{ action: string; actor: string | null }> };
      expect(historyPayload.entries.map((entry) => entry.action)).toEqual([
        "create",
        "status",
      ]);
      expect(historyPayload.entries[0].actor).toBe("e2e-agent");

      // Errors stay inside the protocol: unknown tool and invalid input are
      // isError results, unknown methods are JSON-RPC errors.
      const unknownTool = await server.request("tools/call", {
        name: "luck_tree_nope",
        arguments: {},
      });
      expect(unknownTool.isError).toBe(true);

      const invalidInput = await server.request("tools/call", {
        name: "luck_tree_search",
        arguments: { query: "x" },
      });
      expect(invalidInput.isError).toBe(true);
      expect((invalidInput.content as Array<{ text: string }>)[0].text).toContain(
        "Invalid input",
      );

      await expect(server.request("nope/method")).rejects.toThrow(
        "Method not found",
      );

      // Parse errors answer with -32700 and keep the stream healthy: the
      // ping below still resolves, so the response ordering held.
      const receivedBefore = server.received.length;
      server.writeRaw("{not json at all}\n");
      await server.request("ping");
      const garbageResponses = server.received
        .slice(receivedBefore)
        .filter(
          (message) =>
            (message.error as { code?: number } | undefined)?.code === -32700,
        );
      expect(garbageResponses).toHaveLength(1);

      // The database really exists under $PASEO_HOME.
      expect(
        fs.existsSync(
          path.join(home, "plugins", "luck-planner", "luck-planner.db"),
        ),
      ).toBe(true);
      // stdout carried the protocol and nothing else.
      expect(server.unparsed()).toBe(0);
    } finally {
      server.stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
