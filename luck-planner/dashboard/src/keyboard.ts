/**
 * Keyboard navigation of the 2D diagram (PLAN.md stage L9).
 *
 * A diagram is a picture, and a picture is unusable without a mouse unless the
 * positions that are visible on screen also exist in the model. This module is
 * that model: it takes the **layout boxes** the adapter already computed and
 * answers "which node is next when I press this arrow". No React, no DOM, no
 * SDK — the same discipline as `graph.ts` and `plain.ts`, so the whole rule can
 * be tested on plain numbers.
 *
 * The rule, in one paragraph. Vertical directions (`up`/`down`) move between
 * the levels of the tree, horizontal ones (`left`/`right`) between neighbours
 * on a level — but the answer comes from geometry, not from the tree, because
 * the tree is drawn and the eye follows the drawing. Two things decide it: the
 * candidate must lie **ahead** in the requested direction (never level with the
 * current node, never behind it), and among those the cheapest wins, where cost
 * is `forward + 2 · |drift|` — moving along the arrow counts half as much as
 * drifting away from it. The factor of two is what makes an arrow land on the
 * nearest generation: from a trunk, a child two levels away in the drawing
 * costs `160 + 2·226` while a grandchild costs `320 + 2·226`, yet a candidate
 * lying straight ahead still beats a closer one far to the side.
 *
 * Consequences worth stating: an arrow never gets stuck on a gap in the layout
 * (there is no cone to fall out of), never jumps backwards, and answers `null`
 * only at the edge of the drawing. `Home`/`End` go to the first/last node in
 * reading order.
 *
 * Everything is deterministic: candidates are compared by score and then by id,
 * so a shuffled payload yields the same walk.
 */
import { LAYOUT } from "./graph";

/** A layout box: the on-screen footprint of one node, in flow coordinates. */
export interface NavBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * How much a pixel of drift away from the arrow costs relative to a pixel of
 * progress along it. Two keeps the nearest generation while still preferring
 * what lies straight ahead (see the module comment).
 */
const LATERAL_WEIGHT = 2;

/** The four arrow directions, in the order the docs list them. */
export const NAV_KEYS = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
} as const;

export type NavDirection = (typeof NAV_KEYS)[keyof typeof NAV_KEYS];

/**
 * `Home`/`End` jump to the ends of the reading order; arrows move one step.
 * One table, so the canvas never spells a key name itself.
 */
export const NAV_COMMANDS = {
  ...NAV_KEYS,
  Home: "first",
  End: "last",
} as const;

export type NavCommand = (typeof NAV_COMMANDS)[keyof typeof NAV_COMMANDS];

/**
 * Boxes for the nodes of a graph. The adapter draws every kind at
 * `LAYOUT.nodeWidth`/`nodeHeight`, so the constants are the measurement — which
 * keeps this module free of `getBoundingClientRect` and of any DOM at all.
 */
export function navBoxes(
  nodes: ReadonlyArray<{
    readonly id: string;
    readonly position: { readonly x: number; readonly y: number };
    readonly width?: number | undefined;
    readonly height?: number | undefined;
  }>,
): NavBox[] {
  return nodes
    .map((node) => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: node.width ?? LAYOUT.nodeWidth,
      height: node.height ?? LAYOUT.nodeHeight,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function center(box: NavBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Top to bottom, then left to right — the order a person reads a diagram.
 * `navBoxes` sorts by id first, so equal rows keep a stable order regardless of
 * how the payload arrived.
 */
export function readingOrder(boxes: ReadonlyArray<NavBox>): string[] {
  return [...boxes]
    .sort((a, b) => {
      const dy = a.y - b.y;
      if (Math.abs(dy) > a.height / 2) return dy;
      return a.x - b.x;
    })
    .map((box) => box.id);
}

/**
 * One arrow, one answer. `null` means "there is nothing that way" — the caller
 * keeps the selection instead of inventing a jump.
 */
export function nearestInDirection(
  boxes: ReadonlyArray<NavBox>,
  fromId: string,
  direction: NavDirection,
): string | null {
  const from = boxes.find((box) => box.id === fromId);
  if (from === undefined) return null;
  const origin = center(from);
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "right" || direction === "down" ? 1 : -1;

  const scored: Array<{
    id: string;
    primary: number;
    lateral: number;
  }> = [];
  for (const box of boxes) {
    if (box.id === from.id) continue;
    const point = center(box);
    // `primary` is progress along the arrow, `lateral` is drift away from it.
    const primary =
      (horizontal ? point.x - origin.x : point.y - origin.y) * sign;
    const lateral = horizontal
      ? Math.abs(point.y - origin.y)
      : Math.abs(point.x - origin.x);
    // Anything level with the current node (or behind it) is not "that way".
    if (primary <= 1) continue;
    scored.push({ id: box.id, primary, lateral });
  }
  if (scored.length === 0) return null;

  let best: { id: string; score: number } | null = null;
  for (const candidate of scored) {
    const score = candidate.primary + candidate.lateral * LATERAL_WEIGHT;
    if (
      best === null ||
      score < best.score ||
      (score === best.score && candidate.id < best.id)
    ) {
      best = { id: candidate.id, score };
    }
  }
  return best === null ? null : best.id;
}

/**
 * The whole key → target rule. `fromId` is the node that has focus (or the
 * selection); when it is `null` or no longer drawn, the first node of the
 * reading order is the answer, so Tab into the diagram always lands somewhere.
 */
export function navTarget(
  boxes: ReadonlyArray<NavBox>,
  fromId: string | null,
  key: string,
): string | null {
  const order = readingOrder(boxes);
  if (order.length === 0) return null;
  const command = (NAV_COMMANDS as Record<string, NavCommand | undefined>)[key];
  if (command === undefined) return null;
  if (command === "first") return order[0]!;
  if (command === "last") return order[order.length - 1]!;
  if (fromId === null || !order.includes(fromId)) return order[0]!;
  return nearestInDirection(boxes, fromId, command);
}

/**
 * The single tab stop of the diagram (roving `tabindex`): the selected node
 * while it is drawn, otherwise the first node. A 200-node diagram must not put
 * 200 stops between the toolbar and the details panel.
 */
export function tabStopId(
  boxes: ReadonlyArray<NavBox>,
  selectedId: string | null,
): string | null {
  const order = readingOrder(boxes);
  if (order.length === 0) return null;
  return selectedId !== null && order.includes(selectedId)
    ? selectedId
    : order[0]!;
}

/** The hint the canvas announces once, in words rather than key glyphs. */
export const KEYBOARD_HINT =
  "Use the arrow keys to move between nodes, Home and End for the first and " +
  "last, Enter or Space to select, Escape to clear the selection.";
