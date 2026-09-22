import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  commandSchema,
  fullModelRef,
  historyEntrySchema,
  isFullModelRef,
  normalizeProviderModels,
  resolveModelRef,
  runResultSchema,
  type ProviderWithModels,
} from "../shared/commands";

describe("commandSchema", () => {
  it("fills defaults for type, scope, variables, favorite and useCount", () => {
    const parsed = commandSchema.parse({
      id: "cmd_x",
      name: "X",
      template: "Do it",
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
    });
    expect(parsed).toMatchObject({
      type: "prompt",
      scope: "global",
      variables: [],
      favorite: false,
      useCount: 0,
    });
  });

  it("accepts provider and terminalName for typed commands", () => {
    const parsed = commandSchema.parse({
      id: "cmd_s",
      name: "Status",
      type: "shell",
      template: "git status",
      terminalName: "Git status",
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
    });
    expect(parsed.terminalName).toBe("Git status");
    expect(parsed.type).toBe("shell");
  });

  it("rejects an unknown command type", () => {
    expect(() =>
      commandSchema.parse({
        id: "cmd_bad",
        name: "Bad",
        type: "workflow",
        template: "…",
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z",
      }),
    ).toThrow(z.ZodError);
  });

  it("rejects an empty template", () => {
    expect(() =>
      commandSchema.parse({
        id: "cmd_empty",
        name: "Empty",
        template: "",
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z",
      }),
    ).toThrow(z.ZodError);
  });
});

describe("runResultSchema", () => {
  it("accepts a success payload", () => {
    const parsed = runResultSchema.parse({
      ok: true,
      kind: "new-agent",
      workspaceId: "ws_1",
      agentId: "ag_1",
      terminalId: null,
      title: "Review",
      error: null,
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("historyEntrySchema", () => {
  it("parses pre-upgrade entries without provider/values/batchId", () => {
    const parsed = historyEntrySchema.parse({
      id: "h_1",
      commandId: "cmd_1",
      commandName: "Review",
      rendered: "Review #1",
      targetWorkspaceId: null,
      targetAgentId: null,
      kind: "new-agent",
      ok: true,
      error: null,
      at: "2026-09-22T12:00:00.000Z",
    });
    expect(parsed.provider).toBeUndefined();
    expect(parsed.values).toBeUndefined();
    expect(parsed.batchId).toBeUndefined();
  });

  it("keeps provider, values and batchId for repeatable runs", () => {
    const parsed = historyEntrySchema.parse({
      id: "h_2",
      commandId: "cmd_1",
      commandName: "Review",
      rendered: "Review #2",
      targetWorkspaceId: "ws_1",
      targetAgentId: null,
      kind: "new-agent",
      ok: true,
      error: null,
      at: "2026-09-22T12:00:00.000Z",
      provider: "opencode/opencode/mimo-v2.6-flash-free",
      values: { pr: "#2" },
      batchId: "b_abc",
    });
    expect(parsed.provider).toBe("opencode/opencode/mimo-v2.6-flash-free");
    expect(parsed.values).toEqual({ pr: "#2" });
    expect(parsed.batchId).toBe("b_abc");
  });
});

describe("fullModelRef", () => {
  it("qualifies a bare model id with the provider", () => {
    expect(fullModelRef("cline", "claude-opus-4-6")).toBe("cline/claude-opus-4-6");
  });

  it("always composes, even when the model id already contains slashes", () => {
    // The daemon splits on the FIRST "/" and looks up the remainder in the
    // provider catalog, where ids are stored qualified (opencode lists
    // `opencode/mimo-v2.6-flash-free`). Sending the model id alone silently
    // falls back to the provider default model.
    expect(fullModelRef("opencode", "opencode/mimo-v2.6-flash-free")).toBe(
      "opencode/opencode/mimo-v2.6-flash-free",
    );
  });
});

describe("isFullModelRef", () => {
  it("accepts provider/model and rejects bare ids", () => {
    expect(isFullModelRef("opencode/gpt-5")).toBe(true);
    expect(isFullModelRef("opencode")).toBe(false);
    expect(isFullModelRef("")).toBe(false);
    expect(isFullModelRef(undefined)).toBe(false);
    expect(isFullModelRef("/model")).toBe(false);
    expect(isFullModelRef("provider/")).toBe(false);
  });
});

describe("normalizeProviderModels", () => {
  it("returns null for a missing models array (listModels fallback)", () => {
    expect(normalizeProviderModels(undefined, "cline")).toBeNull();
  });

  it("qualifies model ids and drops non-selectable entries", () => {
    expect(
      normalizeProviderModels(
        [
          { id: "claude-opus-4-6", label: "Claude Opus 4.6", isDefault: true },
          { id: "legacy", label: "Legacy", isSelectable: false },
          { id: "", label: "Broken" },
        ],
        "cline",
      ),
    ).toEqual([{ id: "cline/claude-opus-4-6", label: "Claude Opus 4.6", isDefault: true }]);
  });

  it("composes already-qualified catalog ids with the provider", () => {
    expect(normalizeProviderModels([{ id: "opencode/mimo-v2.6-flash-free", label: "MiMo" }], "opencode")).toEqual([
      { id: "opencode/opencode/mimo-v2.6-flash-free", label: "MiMo", isDefault: false },
    ]);
  });
});

describe("resolveModelRef", () => {
  const catalog: ProviderWithModels[] = [
    {
      id: "opencode",
      serverId: "local",
      hostLabel: "",
      models: [
        { id: "opencode/opencode/nemotron-3-ultra-free", label: "Nemotron", isDefault: true },
        { id: "opencode/opencode/mimo-v2.6-flash-free", label: "MiMo", isDefault: false },
      ],
    },
  ];

  it("keeps a known reference as-is", () => {
    expect(resolveModelRef(catalog, "opencode/opencode/mimo-v2.6-flash-free")).toBe(
      "opencode/opencode/mimo-v2.6-flash-free",
    );
  });

  it("re-qualifies a stale pre-compose reference", () => {
    expect(resolveModelRef(catalog, "opencode/mimo-v2.6-flash-free")).toBe(
      "opencode/opencode/mimo-v2.6-flash-free",
    );
  });

  it("falls back to the default model for bare ids and empties", () => {
    expect(resolveModelRef(catalog, "opencode")).toBe("opencode/opencode/nemotron-3-ultra-free");
    expect(resolveModelRef(catalog, "")).toBe("opencode/opencode/nemotron-3-ultra-free");
    expect(resolveModelRef([], "opencode/mimo-v2.6-flash-free")).toBe("");
  });
});
