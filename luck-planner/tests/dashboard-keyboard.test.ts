/**
 * Keyboard navigation of the 2D diagram (PLAN.md stage L9).
 *
 * `dashboard/src/keyboard.ts` decides where an arrow key goes from the layout
 * boxes the adapter already drew — no DOM, no React, no measurement. These
 * tests therefore work on numbers, and the last suite runs the rule over a real
 * graph the adapter built, so the rule is checked against the layout that ships.
 *
 * The properties that matter: an arrow always moves *forward* in its direction
 * (never backwards, never to a node level with the current one), an aligned
 * candidate wins over a closer off-axis one, a gap in the layout still moves
 * (second pass over the half-plane), a dead end stays put (`null` → the caller
 * keeps the selection), and the walk is deterministic for a shuffled payload.
 */
import { describe, expect, it } from "vitest";
import type { TreeResponse } from "../shared/api";
import type { Node as TreeNode } from "../shared/tree";
import { buildGraph, LAYOUT } from "../dashboard/src/graph";
import {
  KEYBOARD_HINT,
  navBoxes,
  navTarget,
  nearestInDirection,
  readingOrder,
  tabStopId,
  type NavBox,
} from "../dashboard/src/keyboard";

const P = "/tmp/luck-planner-l9";
const T0 = 1_700_000_000_000;

/** A box centred on (x, y) with the adapter's default size. */
function box(id: string, x: number, y: number): NavBox {
  return {
    id,
    x,
    y,
    width: LAYOUT.nodeWidth,
    height: LAYOUT.nodeHeight,
  };
}

/**
 * A three-level tree as the adapter actually draws it: every kind is one
 * `LAYOUT.nodeWidth` wide, siblings sit `LAYOUT.horizontalGap` apart, and the
 * parent is centred over its children. The tree grows **upwards** (§ graph.ts):
 * the root sits at the bottom, the leaves at the top.
 */
const CENTER = 400;
const LEFT = CENTER - LAYOUT.nodeWidth / 2 - LAYOUT.horizontalGap / 2 -
  LAYOUT.nodeWidth / 2;
const RIGHT = CENTER + LAYOUT.horizontalGap / 2 + LAYOUT.nodeWidth / 2 -
  LAYOUT.nodeWidth / 2;
const TOP = CENTER - LAYOUT.nodeWidth / 2;

const TREE: NavBox[] = [
  box("l-left", LEFT, 0),
  box("l-right", RIGHT, 0),
  box("b-left", LEFT, 180),
  box("b-right", RIGHT, 180),
  box("trunk", TOP, 360),
  box("root", TOP, 540),
];

describe("boxes and reading order", () => {
  it("takes the adapter's default size when none is drawn", () => {
    const boxes = navBoxes([
      { id: "b", position: { x: 10, y: 20 } },
      { id: "a", position: { x: 0, y: 0 }, width: 100, height: 40 },
    ]);
    expect(boxes).toEqual([
      { id: "a", x: 0, y: 0, width: 100, height: 40 },
      {
        id: "b",
        x: 10,
        y: 20,
        width: LAYOUT.nodeWidth,
        height: LAYOUT.nodeHeight,
      },
    ]);
  });

  it("reads top to bottom, then left to right", () => {
    expect(readingOrder(TREE)).toEqual([
      "l-left",
      "l-right",
      "b-left",
      "b-right",
      "trunk",
      "root",
    ]);
  });

  it("is stable for a payload that arrives shuffled", () => {
    const shuffled = [...TREE].reverse();
    expect(readingOrder(shuffled)).toEqual(readingOrder(TREE));
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      for (const start of TREE.map((entry) => entry.id)) {
        expect(navTarget(shuffled, start, key)).toBe(
          navTarget(TREE, start, key),
        );
      }
    }
  });
});

describe("one arrow, one node", () => {
  it("climbs the drawing: up towards the leaves, down towards the root", () => {
    expect(nearestInDirection(TREE, "root", "up")).toBe("trunk");
    expect(nearestInDirection(TREE, "trunk", "up")).toBe("b-left");
    expect(nearestInDirection(TREE, "l-left", "down")).toBe("b-left");
    expect(nearestInDirection(TREE, "trunk", "down")).toBe("root");
  });

  it("goes sideways between neighbours on the same level", () => {
    expect(nearestInDirection(TREE, "b-left", "right")).toBe("b-right");
    expect(nearestInDirection(TREE, "b-right", "left")).toBe("b-left");
    // Diagonals are still "forward": the right branch is right-and-up of the
    // trunk, so it is what the right arrow means from there.
    expect(nearestInDirection(TREE, "trunk", "right")).toBe("b-right");
  });

  it("stays put at the edge of the layout", () => {
    // Nothing is below the root, above the leaves, or beyond an outer branch.
    expect(nearestInDirection(TREE, "root", "down")).toBeNull();
    expect(nearestInDirection(TREE, "l-left", "up")).toBeNull();
    expect(nearestInDirection(TREE, "b-right", "right")).toBeNull();
    expect(nearestInDirection(TREE, "b-left", "left")).toBeNull();
  });

  it("never moves backwards, even when the only node is behind", () => {
    const boxes = [box("a", 0, 0), box("b", 0, 400)];
    expect(nearestInDirection(boxes, "b", "up")).toBe("a");
    expect(nearestInDirection(boxes, "a", "down")).toBe("b");
    expect(nearestInDirection(boxes, "b", "down")).toBeNull();
  });

  it("prefers the aligned candidate over a closer off-axis one", () => {
    // `far` is exactly below; `near` is closer but far to the side.
    const boxes = [box("from", 200, 0), box("near", 400, 120), box("far", 200, 300)];
    expect(nearestInDirection(boxes, "from", "down")).toBe("far");
  });

  it("still moves when the layout leaves a wide gap sideways", () => {
    // A wide, flat layout: the next row is far to the side of the current box
    // but it is still the only thing below, so the arrow must not get stuck.
    const boxes = [box("from", 0, 0), box("wide", 900, 100)];
    expect(nearestInDirection(boxes, "from", "down")).toBe("wide");
  });

  it("lands on the nearest generation, not a grandchild that lines up", () => {
    // A wide fan: the branches are far off-axis, the grandchildren are wider
    // still but closer to straight up. Up from the trunk must take a branch.
    const boxes = [
      box("g-far-left", -452, 0),
      box("g-far-right", 452, 0),
      box("b-far-left", -452, 180),
      box("b-far-right", 452, 180),
      box("trunk", 0, 360),
    ];
    expect(["b-far-left", "b-far-right"]).toContain(
      nearestInDirection(boxes, "trunk", "up"),
    );
  });

  it("breaks an exact tie by id, not by payload order", () => {
    const boxes = [box("from", 500, 0), box("zed", 0, 200), box("abe", 1000, 200)];
    // Both candidates are equally far and equally off-axis.
    expect(nearestInDirection(boxes, "from", "down")).toBe("abe");
    expect(nearestInDirection([...boxes].reverse(), "from", "down")).toBe("abe");
  });

  it("answers null for an id it does not draw", () => {
    expect(nearestInDirection(TREE, "ghost", "down")).toBeNull();
  });
});

describe("navTarget — the whole rule", () => {
  it("maps the arrow keys", () => {
    expect(navTarget(TREE, "trunk", "ArrowUp")).toBe("b-left");
    expect(navTarget(TREE, "trunk", "ArrowDown")).toBe("root");
    expect(navTarget(TREE, "b-left", "ArrowRight")).toBe("b-right");
  });

  it("goes to the ends for Home and End", () => {
    expect(navTarget(TREE, "b-right", "Home")).toBe("l-left");
    expect(navTarget(TREE, "trunk", "End")).toBe("root");
  });

  it("lands on the first node when nothing is selected or the id vanished", () => {
    expect(navTarget(TREE, null, "ArrowDown")).toBe("l-left");
    expect(navTarget(TREE, "ghost", "ArrowRight")).toBe("l-left");
  });

  it("ignores every other key and an empty diagram", () => {
    expect(navTarget(TREE, "trunk", "Tab")).toBeNull();
    expect(navTarget(TREE, "trunk", "a")).toBeNull();
    expect(navTarget([], null, "ArrowDown")).toBeNull();
    expect(tabStopId([], null)).toBeNull();
  });

  it("gives the diagram exactly one tab stop", () => {
    expect(tabStopId(TREE, null)).toBe("l-left");
    expect(tabStopId(TREE, "b-right")).toBe("b-right");
    // A selection the filters just hid must not swallow Tab.
    expect(tabStopId(TREE, "ghost")).toBe("l-left");
  });

  it("states the keys in words", () => {
    expect(KEYBOARD_HINT).toContain("arrow keys");
    expect(KEYBOARD_HINT).toContain("Escape");
    expect(KEYBOARD_HINT).toContain("Enter or Space");
  });
});

describe("over a layout the adapter actually drew", () => {
  function node(
    id: string,
    parentId: string | null,
    kind: TreeNode["kind"],
    name: string,
  ): TreeNode {
    return {
      id,
      projectKey: P,
      parentId,
      kind,
      name,
      description: "",
      status: "draft",
      version: "0.1.0",
      revision: 1,
      payload: {},
      createdAt: T0,
      updatedAt: T0,
      createdBy: "user",
      updatedBy: "user",
      archivedAt: null,
    };
  }

  const payload: TreeResponse = {
    projectKey: P,
    generatedAt: T0,
    nodes: [
      node("root", null, "root", "Tech stack"),
      node("trunk", "root", "trunk", "Platform"),
      node("api", "trunk", "branch", "api"),
      node("web", "trunk", "branch", "web"),
      node("leaves-api", "api", "leaf", "retry"),
      node("leaves-web", "web", "leaf", "cache"),
    ],
    bees: [],
    bugs: [],
    bugAttachments: [],
    goals: [],
    growth: [],
  };

  it("climbs the drawn tree: levels, then left and right between branches", () => {
    const graph = buildGraph(payload);
    const boxes = navBoxes(graph.nodes);
    expect(navTarget(boxes, "root", "ArrowUp")).toBe("trunk");
    // The two branches share a row: left and right go between them.
    const first = navTarget(boxes, "trunk", "ArrowUp")!;
    expect(["api", "web"]).toContain(first);
    const other = first === "api" ? "web" : "api";
    expect(
      navTarget(boxes, first, first === "api" ? "ArrowRight" : "ArrowLeft"),
    ).toBe(other);
    // Up from a branch reaches its own leaf, and down comes back.
    const leaf = navTarget(boxes, first, "ArrowUp")!;
    expect(navTarget(boxes, leaf, "ArrowDown")).toBe(first);
  });

  it("only offers what is drawn: a collapsed subtree is skipped", () => {
    const graph = buildGraph(payload, { collapsedIds: new Set(["trunk"]) });
    const boxes = navBoxes(graph.nodes);
    expect(boxes.map((entry) => entry.id).sort()).toEqual(["root", "trunk"]);
    expect(navTarget(boxes, "trunk", "ArrowUp")).toBeNull();
    // Only the trunk and the root are drawn: the trunk, being higher up the
    // drawing, is the stop Tab lands on once the old selection vanished.
    expect(tabStopId(boxes, "api")).toBe("trunk");
  });
});
