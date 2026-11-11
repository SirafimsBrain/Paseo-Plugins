import { describe, expect, it } from "vitest";
import type { CommandDefinition } from "../shared/commands";
import {
  buildShareBundle,
  parseShareBundle,
  planImport,
  uniqueCommandName,
} from "../shared/share";

function command(overrides: Partial<CommandDefinition> & { id: string; name: string }): CommandDefinition {
  return {
    type: "prompt",
    template: "Run {{input:target}}",
    variables: [],
    steps: [],
    scope: "global",
    provider: "cline/claude-opus-4-6",
    favorite: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    useCount: 0,
    ...overrides,
  };
}

function sequencer(): () => string {
  let counter = 0;
  return () => `new_${++counter}`;
}

describe("export", () => {
  it("exports the whole library as a versioned bundle and resets usage counters", () => {
    const bundle = buildShareBundle(
      [command({ id: "a", name: "Alpha", useCount: 9 })],
      undefined,
      "2026-11-11T00:00:00.000Z",
    );
    expect(bundle.format).toBe("command-center/commands");
    expect(bundle.version).toBe(1);
    expect(bundle.exportedAt).toBe("2026-11-11T00:00:00.000Z");
    expect(bundle.commands).toHaveLength(1);
    expect(bundle.commands[0]!.useCount).toBe(0);
  });

  it("exports only the selected ids", () => {
    const bundle = buildShareBundle(
      [command({ id: "a", name: "Alpha" }), command({ id: "b", name: "Beta" })],
      ["b"],
    );
    expect(bundle.commands.map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("parse", () => {
  it("accepts the versioned envelope", () => {
    const json = JSON.stringify(buildShareBundle([command({ id: "a", name: "Alpha" })], undefined));
    expect(parseShareBundle(json).commands).toHaveLength(1);
    expect(parseShareBundle(json).error).toBeNull();
  });

  it("accepts a bare commands.json array", () => {
    const parsed = parseShareBundle(JSON.stringify([command({ id: "a", name: "Alpha" })]));
    expect(parsed.error).toBeNull();
    expect(parsed.commands).toHaveLength(1);
  });

  it("rejects broken JSON, a foreign format and an unsupported version", () => {
    expect(parseShareBundle("{not json").error).toMatch(/Not valid JSON/);
    expect(parseShareBundle(JSON.stringify({ format: "other", version: 1, commands: [] })).error).toMatch(
      /Unrecognized bundle format/,
    );
    expect(
      parseShareBundle(JSON.stringify({ format: "command-center/commands", version: 99, commands: [] }))
        .error,
    ).toMatch(/Unsupported bundle version/);
  });
});

describe("merge import", () => {
  it("updates by name while keeping the local id, favorite flag and run counter", () => {
    const existing = [command({ id: "a", name: "Alpha", template: "old", favorite: true, useCount: 7 })];
    const plan = planImport(
      existing,
      [{ ...command({ id: "a", name: "alpha", template: "new" }), useCount: 0 }],
      { mode: "merge", nowIso: "2026-11-11T00:00:00.000Z" },
    );
    expect(plan.updated).toBe(1);
    expect(plan.added).toBe(0);
    expect(plan.library).toHaveLength(1);
    expect(plan.library[0]).toMatchObject({
      id: "a",
      name: "Alpha",
      template: "new",
      favorite: true,
      useCount: 7,
    });
  });

  it("adds unknown commands and reports invalid records", () => {
    const plan = planImport(
      [command({ id: "a", name: "Alpha" })],
      [
        command({ id: "b", name: "Beta" }),
        { id: "c", name: "Broken", type: "prompt", template: "   " },
        { id: "d" },
      ],
      { mode: "merge", makeId: sequencer() },
    );
    expect(plan.added).toBe(1);
    expect(plan.skipped).toBe(2);
    expect(plan.library.map((entry) => entry.name)).toEqual(["Alpha", "Beta"]);
    expect(plan.errors).toHaveLength(2);
  });
});

describe("copy import", () => {
  it("creates fresh ids and de-duplicated names instead of overwriting", () => {
    const plan = planImport(
      [command({ id: "a", name: "Alpha", template: "original" })],
      [command({ id: "a", name: "Alpha", template: "copy" })],
      { mode: "copy", makeId: sequencer() },
    );
    expect(plan.added).toBe(1);
    expect(plan.updated).toBe(0);
    expect(plan.library.map((entry) => entry.name).sort()).toEqual(["Alpha", "Alpha (2)"]);
    expect(plan.library.find((entry) => entry.name === "Alpha")!.template).toBe("original");
    expect(plan.library.find((entry) => entry.name === "Alpha (2)")!.template).toBe("copy");
  });

  it("remaps workflow steps to the copied commands, even when the step is listed later", () => {
    const plan = planImport(
      [command({ id: "a", name: "Alpha" })],
      [
        {
          ...command({ id: "w", name: "Chain", type: "workflow", template: "", steps: [] }),
          steps: [{ commandId: "a", condition: "always" }],
        },
        command({ id: "a", name: "Alpha", template: "step" }),
      ],
      { mode: "copy", makeId: sequencer() },
    );
    expect(plan.added).toBe(2);
    expect(plan.skipped).toBe(0);
    const chain = plan.library.find((entry) => entry.name === "Chain")!;
    const step = plan.library.find((entry) => entry.name === "Alpha (2)")!;
    expect(chain.steps[0]!.commandId).toBe(step.id);
    expect(step.id).not.toBe("a");
  });

  it("skips a workflow whose step is missing from the bundle and the library", () => {
    const plan = planImport(
      [],
      [
        {
          ...command({ id: "w", name: "Chain", type: "workflow", template: "", steps: [] }),
          steps: [{ commandId: "ghost", condition: "always" }],
        },
      ],
      { mode: "merge", makeId: sequencer() },
    );
    expect(plan.added).toBe(0);
    expect(plan.skipped).toBe(1);
    expect(plan.library).toEqual([]);
    expect(plan.errors[0]).toMatch(/no longer exists/);
  });
});

describe("uniqueCommandName", () => {
  it("appends the first free counter", () => {
    expect(uniqueCommandName("Deploy", new Set())).toBe("Deploy");
    expect(
      uniqueCommandName("Deploy", new Set(["deploy", "deploy (2)"])),
    ).toBe("Deploy (3)");
  });
});
