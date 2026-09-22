import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendHistory,
  clearHistoryStore,
  loadCommands,
  loadHistory,
  saveCommands,
} from "../server/store";
import type { CommandDefinition, HistoryEntry } from "../shared/commands";

const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "cc-store-"));
  homes.push(home);
  return home;
}

beforeEach(() => {
  process.env.PASEO_HOME = freshHome();
});

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function command(id: string): CommandDefinition {
  return {
    id,
    name: `Command ${id}`,
    type: "prompt",
    template: "Hello {{input:who}}",
    variables: [],
    scope: "global",
    provider: "claude/opus-4.6",
    favorite: false,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    useCount: 0,
  };
}

describe("command store", () => {
  it("returns an empty list when nothing was saved yet", () => {
    expect(loadCommands()).toEqual([]);
  });

  it("round-trips commands through commands.json", () => {
    saveCommands([command("a"), command("b")]);
    expect(loadCommands().map((entry) => entry.id)).toEqual(["a", "b"]);
    const raw = JSON.parse(
      readFileSync(path.join(process.env.PASEO_HOME!, "plugins", "command-center", "commands.json"), "utf-8"),
    ) as CommandDefinition[];
    expect(raw).toHaveLength(2);
  });

  it("treats a corrupted file as empty instead of throwing", () => {
    const root = path.join(process.env.PASEO_HOME!, "plugins", "command-center");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "commands.json"), "{not json", "utf-8");
    expect(loadCommands()).toEqual([]);
  });
});

describe("history store", () => {
  const entry = (id: string): HistoryEntry => ({
    id,
    commandId: "a",
    commandName: "A",
    rendered: "r",
    targetWorkspaceId: null,
    targetAgentId: null,
    kind: "new-agent",
    ok: true,
    error: null,
    at: "2026-09-22T00:00:00.000Z",
  });

  it("prepends new entries and keeps the list bounded", () => {
    let entries: HistoryEntry[] = [];
    for (let index = 0; index < 60; index += 1) {
      entries = appendHistory(entries, entry(`h${index}`), 50);
    }
    expect(loadHistory()).toHaveLength(50);
    expect(loadHistory()[0]!.id).toBe("h59");
  });

  it("clear removes the file", () => {
    appendHistory([], entry("h1"));
    clearHistoryStore();
    expect(loadHistory()).toEqual([]);
  });
});
