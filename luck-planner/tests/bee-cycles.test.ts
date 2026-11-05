/**
 * Influence cycles (PLAN.md stage L6, `__doc.md` §4.2).
 *
 * `shared/bees.ts` decides which leaves influence each other in a loop. It is
 * pure (bees in, report out), so these tests build fixtures in memory and pin
 * the cases that make the marking trustworthy: a loop is found, a chain and a
 * diamond are not, a settled link takes the loop away, and the report never
 * depends on the order the payload happened to arrive in — a live refetch must
 * not make the loop change shape on screen.
 *
 * The last suite pins the iterative SCC search: an influence chain long enough
 * to break a recursive walk must still answer.
 */
import { describe, expect, it } from "vitest";
import {
  beeCycleLabel,
  beeCycleOf,
  findBeeCycles,
  isBeeLive,
  NO_BEE_CYCLES,
  type BeeLink,
} from "../shared/bees";
import { BEE_STATUSES, type BeeStatus } from "../shared/links";

function bee(
  id: string,
  sourceLeafId: string,
  targetLeafId: string,
  status: BeeStatus = "active",
): BeeLink {
  return { id, sourceLeafId, targetLeafId, status };
}

describe("findBeeCycles", () => {
  it("answers an empty report when nothing links at all", () => {
    expect(findBeeCycles([])).toEqual(NO_BEE_CYCLES);
    expect(NO_BEE_CYCLES.count).toBe(0);
  });

  it("finds two leaves that influence each other both ways", () => {
    const report = findBeeCycles([
      bee("b1", "a", "b"),
      bee("b2", "b", "a"),
    ]);
    expect(report.count).toBe(1);
    expect(report.nodeIds).toEqual(["a", "b"]);
    expect(report.beeIds).toEqual(["b1", "b2"]);
    expect(report.cycles[0]).toMatchObject({
      nodeIds: ["a", "b"],
      walk: ["a", "b", "a"],
    });
  });

  it("finds a three-leaf loop and closes the walk", () => {
    const report = findBeeCycles([
      bee("b1", "a", "b"),
      bee("b2", "b", "c"),
      bee("b3", "c", "a"),
    ]);
    expect(report.count).toBe(1);
    expect(report.nodeIds).toEqual(["a", "b", "c"]);
    expect(report.beeIds).toEqual(["b1", "b2", "b3"]);
    const { walk } = report.cycles[0]!;
    expect(walk.length).toBe(4);
    expect(walk[0]).toBe(walk[walk.length - 1]);
    expect(new Set(walk)).toEqual(new Set(["a", "b", "c"]));
  });

  it("does not call a one-way chain a cycle", () => {
    const report = findBeeCycles([
      bee("b1", "a", "b"),
      bee("b2", "b", "c"),
    ]);
    expect(report).toEqual(NO_BEE_CYCLES);
  });

  it("does not call a diamond a cycle", () => {
    // a → b, a → c, b → d, c → d: plenty of influence, no way back.
    const report = findBeeCycles([
      bee("b1", "a", "b"),
      bee("b2", "a", "c"),
      bee("b3", "b", "d"),
      bee("b4", "c", "d"),
    ]);
    expect(report.count).toBe(0);
    expect(report.nodeIds).toEqual([]);
  });

  it("ignores links that are over, keeps the ones that are live", () => {
    // The same pair, first settled, then live: only the live link counts.
    for (const status of ["resolved", "cancelled"] as const) {
      const settled = findBeeCycles([
        bee("b1", "a", "b", status),
        bee("b2", "b", "a", status),
      ]);
      expect(settled).toEqual(NO_BEE_CYCLES);
    }
    for (const status of ["active", "watching"] as const) {
      expect(
        findBeeCycles([
          bee("b1", "a", "b", status),
          bee("b2", "b", "a", status),
        ]).count,
      ).toBe(1);
    }
  });

  it("breaks a loop when one of its links is settled", () => {
    const report = findBeeCycles([
      bee("b1", "a", "b"),
      bee("b2", "b", "c"),
      bee("b3", "c", "a", "resolved"),
    ]);
    expect(report.count).toBe(0);
  });

  it("covers every declared bee status in the live/settled split", () => {
    expect(BEE_STATUSES.filter(isBeeLive).sort()).toEqual([
      "active",
      "watching",
    ]);
  });

  it("keeps a leaf that only feeds the loop out of it", () => {
    const report = findBeeCycles([
      bee("b1", "x", "a"),
      bee("b2", "a", "b"),
      bee("b3", "b", "a"),
    ]);
    expect(report.cycles[0]?.nodeIds).toEqual(["a", "b"]);
    expect(report.cycles[0]?.beeIds).toEqual(["b2", "b3"]);
    expect(beeCycleOf(report, "x")).toBeNull();
  });

  it("reports several independent cycles in one deterministic order", () => {
    const report = findBeeCycles([
      bee("b1", "d", "e"),
      bee("b2", "e", "d"),
      bee("b3", "a", "b"),
      bee("b4", "b", "a"),
    ]);
    expect(report.count).toBe(2);
    expect(report.cycles.map((cycle) => cycle.nodeIds)).toEqual([
      ["a", "b"],
      ["d", "e"],
    ]);
    expect(report.nodeIds).toEqual(["a", "b", "d", "e"]);
    expect(report.beeIds).toEqual(["b1", "b2", "b3", "b4"]);
  });

  it("keeps every bee of a loop, including parallel links", () => {
    const report = findBeeCycles([
      bee("b1", "a", "b"),
      bee("b2", "a", "b", "watching"),
      bee("b3", "b", "a"),
    ]);
    expect(report.cycles[0]?.beeIds).toEqual(["b1", "b2", "b3"]);
    // The walk names leaves, so a duplicated link cannot repeat a leaf in it.
    expect(report.cycles[0]?.walk).toEqual(["a", "b", "a"]);
  });

  it("picks the shortest loop through the component's first leaf", () => {
    // One component with a three-leaf loop (a → b → c → a) and a two-leaf
    // loop through the same leaf (a ↔ e): the readable walk is the short one.
    const report = findBeeCycles([
      bee("b1", "a", "b"),
      bee("b2", "b", "c"),
      bee("b3", "c", "a"),
      bee("b4", "a", "e"),
      bee("b5", "e", "a"),
    ]);
    expect(report.count).toBe(1);
    expect(report.cycles[0]?.nodeIds).toEqual(["a", "b", "c", "e"]);
    expect(report.cycles[0]?.walk).toEqual(["a", "e", "a"]);
  });

  it("does not depend on the order the bees arrive in", () => {
    const bees = [
      bee("b1", "a", "b"),
      bee("b2", "b", "c"),
      bee("b3", "c", "a"),
      bee("b4", "x", "y"),
      bee("b5", "y", "x"),
    ];
    const forward = findBeeCycles(bees);
    const backward = findBeeCycles([...bees].reverse());
    const shuffled = findBeeCycles([bees[2]!, bees[4]!, bees[0]!, bees[3]!, bees[1]!]);
    expect(backward).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it("does not treat a self-link as a loop between two leaves", () => {
    // `beeSchema` rejects self-links; a row that slipped past it still must
    // not become a one-leaf "cycle".
    expect(findBeeCycles([bee("b1", "a", "a")])).toEqual(NO_BEE_CYCLES);
  });

  it("answers null for a node that is not on a cycle", () => {
    const report = findBeeCycles([
      bee("b1", "a", "b"),
      bee("b2", "b", "a"),
      bee("b3", "c", "d"),
    ]);
    expect(beeCycleOf(report, "c")).toBeNull();
    expect(beeCycleOf(report, "a")?.nodeIds).toEqual(["a", "b"]);
  });
});

describe("beeCycleLabel", () => {
  const names = new Map([
    ["a", "Retry receipts"],
    ["b", "Refund proration"],
  ]);

  it("writes the loop as one arrow chain of names", () => {
    const cycle = findBeeCycles([
      bee("b1", "a", "b"),
      bee("b2", "b", "a"),
    ]).cycles[0]!;
    expect(beeCycleLabel(cycle, (id) => names.get(id) ?? "")).toBe(
      "Retry receipts → Refund proration → Retry receipts",
    );
  });

  it("falls back to the id when a name cannot be resolved", () => {
    const cycle = findBeeCycles([
      bee("b1", "a", "b"),
      bee("b2", "b", "a"),
    ]).cycles[0]!;
    expect(beeCycleLabel(cycle, () => "")).toBe("a → b → a");
  });
});

describe("big graphs", () => {
  it("walks a 3000-leaf ring without a recursive descent", () => {
    const ids = Array.from({ length: 3000 }, (_, index) => `leaf-${String(index).padStart(4, "0")}`);
    const bees: BeeLink[] = ids.map((id, index) =>
      bee(`b-${index}`, id, ids[(index + 1) % ids.length]!),
    );
    // A pile of unrelated one-way links around it: the detector must stay
    // linear in the bees, not quadratic in the tree.
    for (let index = 0; index < 2000; index += 1) {
      bees.push(bee(`t-${index}`, `tail-${index}`, `head-${index}`));
    }
    const started = performance.now();
    const report = findBeeCycles(bees);
    const elapsed = performance.now() - started;
    expect(report.count).toBe(1);
    expect(report.nodeIds).toHaveLength(3000);
    expect(report.beeIds).toHaveLength(3000);
    expect(report.cycles[0]?.walk.length).toBe(3001);
    expect(elapsed).toBeLessThan(250);
  });
});
