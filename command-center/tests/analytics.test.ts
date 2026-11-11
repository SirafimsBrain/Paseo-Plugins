import { describe, expect, it } from "vitest";
import type { CommandDefinition } from "../shared/commands";
import { mostUsedCommands, sortCommands } from "../shared/analytics";

function command(name: string, useCount: number, favorite = false): CommandDefinition {
  return {
    id: name.toLowerCase(),
    name,
    type: "prompt",
    template: "x",
    variables: [],
    steps: [],
    scope: "global",
    favorite,
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    useCount,
  };
}

describe("sortCommands", () => {
  const library = [
    command("Zeta", 0),
    command("Beta", 9, true),
    command("Alpha", 9),
    command("Gamma", 1),
  ];

  it("keeps favorites first and alphabetical by default", () => {
    expect(sortCommands(library, "default").map((entry) => entry.name)).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
      "Zeta",
    ]);
  });

  it("puts the most-run commands first and breaks ties by the default order", () => {
    expect(sortCommands(library, "used").map((entry) => entry.name)).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
      "Zeta",
    ]);
    expect(
      sortCommands([command("B", 5), command("A", 9), command("C", 5)], "used").map((entry) => entry.name),
    ).toEqual(["A", "B", "C"]);
  });

  it("does not mutate the input array", () => {
    const original = [...library];
    sortCommands(library, "used");
    expect(library).toEqual(original);
  });
});

describe("mostUsedCommands", () => {
  it("excludes commands that never ran and caps the list", () => {
    const top = mostUsedCommands(
      [command("A", 3), command("B", 0), command("C", 8), command("D", 1), command("E", 4)],
      3,
    );
    expect(top.map((entry) => entry.name)).toEqual(["C", "E", "A"]);
  });

  it("returns an empty list when nothing has run", () => {
    expect(mostUsedCommands([command("A", 0), command("B", 0)])).toEqual([]);
  });

  it("respects a zero limit", () => {
    expect(mostUsedCommands([command("A", 1)], 0)).toEqual([]);
  });
});
