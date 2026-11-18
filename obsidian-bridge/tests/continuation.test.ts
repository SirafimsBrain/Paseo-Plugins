import { afterEach, describe, expect, it } from "vitest";
import { normalizeTruncation } from "../server/continuation";
import { indexPathFor } from "../server/paths";
import { scanVault } from "../server/scan";
import { BridgeStore } from "../server/store";
import { dispatchTool, mcpInstructions } from "../server/mcp-tools";
import { resolveRoleDirs } from "../server/dirs";
import type { Continuation } from "../shared/continuation";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

const workspaces: TestWorkspace[] = [];

function indexed(notes: Record<string, string>) {
  const created = makeWorkspace(notes);
  workspaces.push(created);
  const settings = runtimeSettings(created.vault);
  const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
  scanVault({ root: created.vault, store, settings, force: true });
  store.close();
  return { settings };
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

const continuation: Continuation = {
  call: { tool: "obsidian_search", arguments: { query: "x" } },
  reason: "max_results",
  omitted: 2,
  hint: "2 hits were not shown.",
};

describe("truncation protocol", () => {
  it("teaches the continuation call in the initialize instructions", () => {
    const instructions = mcpInstructions(resolveRoleDirs(runtimeSettings("/tmp/vault")));
    expect(instructions).toContain("`obsidian_continue`");
    expect(instructions).toContain("[TRUNCATED]");
    expect(instructions).toContain("Do not switch to `shell`");
  });

  it("prints the exact next call into the text channel at the transport boundary", () => {
    const normalized = normalizeTruncation({
      text: "{\"truncated\":true}",
      structuredContent: { truncated: true, continuation },
    });
    expect(normalized.text).toContain("obsidian_continue");
    expect(normalized.text).toContain("obsidian_search");
    expect(normalizeTruncation(normalized).text).toBe(normalized.text);
  });

  it("continues a budget-cut search with the same query and a higher offset", async () => {
    const long = `alpha beta gamma ${"filler ".repeat(120)}`;
    const { settings } = indexed({
      "a.md": `# Alpha\n\n${long}\n`,
      "b.md": `# Beta\n\n${long}\n`,
      "c.md": `# Gamma\n\n${long}\n`,
    });
    const first = await dispatchTool(
      "obsidian_search",
      { query: "alpha beta gamma", budget_chars: 500 },
      settings,
    );
    const structured = first.structuredContent as {
      truncated: boolean;
      continuation: Continuation | null;
    };
    expect(structured.truncated).toBe(true);
    expect(structured.continuation?.call.tool).toBe("obsidian_search");
    expect(first.text).toContain("[TRUNCATED]");

    const next = await dispatchTool("obsidian_continue", { continuation: structured.continuation }, settings);
    expect(next.isError).toBeUndefined();
    const nextStructured = next.structuredContent as { hits: Array<{ path: string }> };
    expect(nextStructured.hits.every((hit) => hit.path !== "a.md")).toBe(true);
  });

  it("continues a character window of a long note", async () => {
    const body = "x".repeat(120);
    const { settings } = indexed({ "long.md": `# Long\n\n${body}\n` });
    const first = await dispatchTool(
      "obsidian_read",
      { path: "long.md", max_chars: 20 },
      settings,
    );
    const structured = first.structuredContent as {
      content: string;
      truncated: boolean;
      continuation: Continuation | null;
    };
    expect(structured.content).toHaveLength(20);
    expect(structured.truncated).toBe(true);
    expect(structured.continuation?.call.tool).toBe("obsidian_read");

    const next = await dispatchTool("obsidian_continue", { continuation: structured.continuation }, settings);
    const nextStructured = next.structuredContent as { content: string };
    expect(nextStructured.content).toHaveLength(20);
    expect(nextStructured.content).not.toBe(structured.content);
  });

  it("continues a truncated note listing", async () => {
    const { settings } = indexed({ "a.md": "# A\n", "b.md": "# B\n", "c.md": "# C\n" });
    const first = await dispatchTool("obsidian_list", { limit: 1 }, settings);
    const structured = first.structuredContent as {
      truncated: boolean;
      continuation: Continuation | null;
    };
    expect(structured.truncated).toBe(true);
    expect(structured.continuation?.call.arguments.offset).toBe(1);
    const next = await dispatchTool("obsidian_continue", { continuation: structured.continuation }, settings);
    expect(next.isError).toBeUndefined();
  });

  it("refuses a malformed continuation or a tool that is not a continuation target", async () => {
    const { settings } = indexed({ "a.md": "# A\n" });
    const malformed = await dispatchTool("obsidian_continue", {}, settings);
    expect(malformed.isError).toBe(true);
    const wrongTool = await dispatchTool(
      "obsidian_continue",
      {
        continuation: {
          ...continuation,
          call: { tool: "obsidian_continue", arguments: {} },
        },
      },
      settings,
    );
    expect(wrongTool.isError).toBe(true);
  });
});
