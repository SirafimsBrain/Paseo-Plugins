import { describe, expect, it } from "vitest";
import { z } from "zod";
import { commandSchema, runResultSchema } from "../shared/commands";

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
