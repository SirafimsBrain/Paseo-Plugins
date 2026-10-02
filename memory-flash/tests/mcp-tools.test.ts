import { describe, expect, it, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../server/store";
import { MCP_TOOLS, dispatchMcpTool } from "../server/mcp-tools";

let dir: string;
let store: MemoryStore;
let context: { store: MemoryStore; defaultAgentId: string };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-flash-mcp-"));
  store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
  context = { store, defaultAgentId: "test-agent" };
});

afterAll(() => {
  try {
    store?.close();
  } catch {
    // ignore
  }
});

function call(name: string, args: Record<string, unknown>) {
  return dispatchMcpTool(name, args, context);
}

describe("MCP tool surface", () => {
  it("exposes the documented tool set", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(names).toContain("memory_save");
    expect(names).toContain("memory_search");
    expect(names).toContain("memory_get");
    expect(names).toContain("memory_update");
    expect(names).toContain("memory_delete");
    expect(names).toContain("memory_list_by_tag");
    expect(names).toContain("memory_handoff");
    expect(names).toContain("memory_stats");
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("memory_save defaults kind and applies the default agent id", () => {
    const result = call("memory_save", { title: "T", content: "C", tags: ["x"] });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as { saved: boolean; id: number };
    expect(payload.saved).toBe(true);
    const memory = store.getById(payload.id);
    expect(memory?.kind).toBe("note");
    expect(memory?.agentId).toBe("test-agent");
  });

  it("memory_save rejects empty content", () => {
    const result = call("memory_save", { title: "T", content: "" });
    expect(result.isError).toBe(true);
  });

  it("memory_search finds saved content", () => {
    call("memory_save", { title: "Login bug", content: "The login form loses focus on Safari.", tags: ["auth"] });
    const result = call("memory_search", { query: "Safari" });
    const payload = JSON.parse(result.content[0].text) as { matches: number };
    expect(payload.matches).toBe(1);
  });

  it("memory_search returns matches: 0 for empty database", () => {
    const result = call("memory_search", { query: "anything" });
    const payload = JSON.parse(result.content[0].text) as { matches: number };
    expect(payload.matches).toBe(0);
  });

  it("memory_update replaces content and bumps revision", () => {
    const save = JSON.parse(call("memory_save", { title: "v1", content: "one", tags: [] }).content[0].text) as { id: number };
    const result = call("memory_update", { id: save.id, title: "v2", content: "two", tags: ["b"] });
    const payload = JSON.parse(result.content[0].text) as { updated: boolean; revision: number };
    expect(payload.updated).toBe(true);
    expect(payload.revision).toBe(2);
  });

  it("memory_update on a missing id errors", () => {
    const result = call("memory_update", { id: 999, title: "x", content: "y" });
    expect(result.isError).toBe(true);
  });

  it("memory_delete removes the row", () => {
    const save = JSON.parse(call("memory_save", { title: "gone", content: "soon", tags: [] }).content[0].text) as { id: number };
    const result = call("memory_delete", { id: save.id });
    const payload = JSON.parse(result.content[0].text) as { deleted: boolean };
    expect(payload.deleted).toBe(true);
    expect(store.getById(save.id)).toBeNull();
  });

  it("memory_list_by_tag filters by tag and optional kinds", () => {
    call("memory_save", { title: "A", content: "a", tags: ["deploy"], kind: "procedure" });
    call("memory_save", { title: "B", content: "b", tags: ["deploy"], kind: "decision" });
    call("memory_save", { title: "C", content: "c", tags: ["auth"] });
    const all = call("memory_list_by_tag", { tag: "deploy" });
    expect((JSON.parse(all.content[0].text) as { matches: number }).matches).toBe(2);
    const filtered = call("memory_list_by_tag", { tag: "deploy", kinds: ["decision"] });
    const payload = JSON.parse(filtered.content[0].text) as { matches: number };
    expect(payload.matches).toBe(1);
    const lines = JSON.parse(filtered.content[0].text) as { memories: Array<{ line: string }> };
    expect(lines.memories[0].line).toContain("[decision]");
  });

  it("memory_list_by_tag rejects unknown kinds", () => {
    const result = call("memory_list_by_tag", { tag: "deploy", kinds: ["nope"] });
    expect(result.isError).toBe(true);
  });

  it("memory_handoff creates a handoff with the handoff tag", () => {
    const result = call("memory_handoff", { title: "State", content: "Done: X. Next: Y.", project: "paseo" });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as { id: number };
    const memory = store.getById(payload.id);
    expect(memory?.kind).toBe("handoff");
    expect(memory?.tags).toContain("handoff");
    expect(memory?.project).toBe("paseo");
  });

  it("unknown tool errors", () => {
    const result = call("memory_nope", {});
    expect(result.isError).toBe(true);
  });

  it("memory_stats reports totals", () => {
    call("memory_save", { title: "A", content: "a", tags: ["t"] });
    const result = call("memory_stats", {});
    const payload = JSON.parse(result.content[0].text) as { total: number };
    expect(payload.total).toBe(1);
  });
});
