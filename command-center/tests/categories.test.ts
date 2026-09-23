import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectImplicitCategories, loadCategories, saveCategories } from "../server/store";
import type { CommandDefinition } from "../shared/commands";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-categories-"));

beforeEach(() => {
  process.env.PASEO_HOME = home;
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("category store", () => {
  it("starts empty and persists round-trips", () => {
    expect(loadCategories()).toEqual([]);
    saveCategories([
      { name: "Code review", sortKey: "code review" },
      { name: "Ops", sortKey: "ops" },
    ]);
    expect(loadCategories()).toHaveLength(2);
  });

  it("dedupes case-insensitive duplicates on load", () => {
    saveCategories([
      { name: "Ops", sortKey: "ops" },
      { name: "ops", sortKey: "ops" },
    ]);
    expect(loadCategories()).toHaveLength(1);
  });

  it("collects implicit categories from commands", () => {
    const command = {
      id: "cmd_x",
      name: "X",
      type: "prompt",
      template: "t",
      variables: [],
      scope: "global",
      favorite: false,
      createdAt: "",
      updatedAt: "",
      useCount: 0,
      category: "  Deploy  ",
    } as CommandDefinition;
    expect(collectImplicitCategories([command])).toEqual(["deploy"]);
  });
});
