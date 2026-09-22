import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import contribute from "../index.server";
import { clearHistoryStore, loadCommands, loadHistory } from "../server/store";
import type { CommandDefinition } from "../shared/commands";

const homes: string[] = [];
let currentHome = "";

beforeEach(() => {
  currentHome = mkdtempSync(path.join(tmpdir(), "cc-rpc-"));
  homes.push(currentHome);
  process.env.PASEO_HOME = currentHome;
});

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

type Handler = (input: never, ctx: { paseo: unknown }) => unknown;
const handlers = new Map<string, Handler>();

function fakeServer(): never {
  return {
    handle(rpc: { name: string }, handler: Handler) {
      handlers.set(rpc.name, handler);
    },
  } as never;
}

function call(name: string, input: unknown, paseo: unknown = {}): unknown {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`No handler registered for ${name}`);
  return handler(input as never, { paseo });
}

function command(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    id: "cmd_1",
    name: "Review",
    type: "prompt",
    template: "Review {{input:pr}}",
    variables: [],
    scope: "global",
    provider: "claude/opus-4.6",
    favorite: false,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    useCount: 3,
    ...overrides,
  };
}

describe("command-center RPC handlers", () => {
  beforeEach(() => {
    handlers.clear();
    contribute(fakeServer());
  });

  it("list returns an empty library on a fresh home", () => {
    expect(call("command-center.list", {})).toEqual({ commands: [] });
  });

  it("save creates, lists and sorts by name", () => {
    call("command-center.save", { command: command({ id: "b", name: "Beta" }) });
    call("command-center.save", { command: command({ id: "a", name: "Alpha" }) });
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(loadCommands()).toHaveLength(2);
  });

  it("save preserves the server-side useCount of an existing command", () => {
    call("command-center.save", { command: command() });
    call("command-center.save", { command: command({ useCount: 999 }) });
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands.find((entry) => entry.id === "cmd_1")?.useCount).toBe(3);
  });

  it("run increments the stored useCount of the command", async () => {
    call("command-center.save", { command: command() });
    const paseo = {
      workspaces: { list: async () => ({ entries: [] }) },
      agents: {
        list: async () => ({ entries: [] }),
        create: async () => ({ id: "ag_count" }),
      },
    };
    await call("command-center.run", { commandId: "cmd_1", values: { pr: "#1" }, newWorktree: false }, paseo);
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands.find((entry) => entry.id === "cmd_1")?.useCount).toBe(4);
  });

  it("save reports validation failures instead of writing a bad record", () => {
    const result = call("command-center.save", {
      command: command({ template: "" }),
    }) as { saved: boolean; error: string | null };
    expect(result.saved).toBe(false);
    expect(result.error).toBeTruthy();
    expect(loadCommands()).toEqual([]);
  });

  it("save supports delete+save in one atomic-ish call", () => {
    call("command-center.save", { command: command() });
    call("command-center.save", {
      command: command({ id: "cmd_2", name: "Deploy" }),
      deleteId: "cmd_1",
    });
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands.map((entry) => entry.id)).toEqual(["cmd_2"]);
  });

  it("delete removes only the targeted command", () => {
    call("command-center.save", { command: command() });
    call("command-center.save", { command: command({ id: "cmd_2" }) });
    call("command-center.delete", { id: "cmd_1" });
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands.map((entry) => entry.id)).toEqual(["cmd_2"]);
  });

  it("favorite toggles an existing command and reports unknown ids", () => {
    call("command-center.save", { command: command() });
    expect(call("command-center.favorite", { id: "cmd_1", favorite: true })).toEqual({ ok: true });
    expect(call("command-center.favorite", { id: "nope", favorite: true })).toEqual({ ok: false });
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands[0]?.favorite).toBe(true);
  });

  it("history list/clear round-trips through the store", () => {
    clearHistoryStore();
    const listed = call("command-center.history", {}) as { entries: unknown[] };
    expect(listed.entries).toEqual([]);
  });

  it("run reports unknown commands as a failed run", async () => {
    const result = (await call("command-center.run", {
      commandId: "missing",
      values: {},
    })) as { ok: boolean; error: string | null };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown command");
  });

  it("run executes a prompt against the paseo api", async () => {
    call("command-center.save", { command: command() });
    const created: Record<string, unknown>[] = [];
    const paseo = {
      workspaces: { list: async () => ({ entries: [] }) },
      agents: {
        list: async () => ({ entries: [] }),
        create: async (request: Record<string, unknown>) => {
          created.push(request);
          return { id: "ag_new" };
        },
      },
    };
    const result = (await call(
      "command-center.run",
      { commandId: "cmd_1", values: { pr: "#7" }, newWorktree: false },
      paseo,
    )) as { ok: boolean; agentId: string | null };
    expect(result.ok).toBe(true);
    expect(result.agentId).toBe("ag_new");
    expect(created[0]).toMatchObject({ prompt: "Review #7" });
  });
});
