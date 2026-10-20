/**
 * The details panel's width and the lenient array schema (stage I4
 * follow-up, stage D5).
 *
 * Two small rules with real consequences:
 *
 * 1. **The panel is resizable** and remembers its width. The bounds are the
 *    rule: a panel narrower than 280 px cuts the node names, a panel wider
 *    than 720 px squeezes the diagram out. The storage is injected, so the
 *    rule is tested without a DOM — the theme's `resolveTheme` precedent.
 * 2. **The growth schema tolerates a rewriting MCP client.** The Kilo client
 *    rewrites an array that lives inside a schema-free object: `steps[].facts`
 *    arrives as `{"item": [...]}` (and an empty array as `""`), and the whole
 *    call used to be rejected with "expected array, received object". The
 *    data is not damaged, only the shape it arrives in — so the shape is
 *    normalized before the validation.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clampDetailsWidth,
  DEFAULT_DETAILS_WIDTH,
  DETAILS_WIDTH_KEY,
  forgetDetailsWidth,
  MAX_DETAILS_WIDTH,
  MIN_DETAILS_WIDTH,
  readStoredDetailsWidth,
  storeDetailsWidth,
  type DetailsWidthStorage,
} from "../dashboard/src/details-width";
import { growthStepSchema } from "../shared/growth";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A storage that keeps the values in a map. */
function memoryStorage(): DetailsWidthStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("the details panel's width", () => {
  it("opens 1.5× the old fixed column", () => {
    expect(DEFAULT_DETAILS_WIDTH).toBe(450);
  });

  it("clamps a dragged width into the window", () => {
    expect(clampDetailsWidth(100)).toBe(MIN_DETAILS_WIDTH);
    expect(clampDetailsWidth(5000)).toBe(MAX_DETAILS_WIDTH);
    expect(clampDetailsWidth(520)).toBe(520);
    // A pointer event without coordinates must not produce NaN.
    expect(clampDetailsWidth(Number.NaN)).toBe(DEFAULT_DETAILS_WIDTH);
  });

  it("reads the stored width and ignores a broken one", () => {
    const storage = memoryStorage();
    expect(readStoredDetailsWidth(storage)).toBe(DEFAULT_DETAILS_WIDTH);
    storeDetailsWidth(storage, 600);
    expect(storage.values.get(DETAILS_WIDTH_KEY)).toBe("600");
    expect(readStoredDetailsWidth(storage)).toBe(600);
    // Out of bounds and garbage fall back to the default.
    storage.values.set(DETAILS_WIDTH_KEY, "9999");
    expect(readStoredDetailsWidth(storage)).toBe(DEFAULT_DETAILS_WIDTH);
    storage.values.set(DETAILS_WIDTH_KEY, "wide");
    expect(readStoredDetailsWidth(storage)).toBe(DEFAULT_DETAILS_WIDTH);
  });

  it("survives a storage that refuses to work", () => {
    const hostile: DetailsWidthStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredDetailsWidth(hostile)).toBe(DEFAULT_DETAILS_WIDTH);
    expect(() => storeDetailsWidth(hostile, 500)).not.toThrow();
    expect(() => forgetDetailsWidth(hostile)).not.toThrow();
    expect(readStoredDetailsWidth(null)).toBe(DEFAULT_DETAILS_WIDTH);
  });

  it("forgets the width on request", () => {
    const storage = memoryStorage();
    storeDetailsWidth(storage, 600);
    forgetDetailsWidth(storage);
    expect(storage.values.has(DETAILS_WIDTH_KEY)).toBe(false);
    expect(readStoredDetailsWidth(storage)).toBe(DEFAULT_DETAILS_WIDTH);
  });
});

describe("the panel really is draggable", () => {
  it("carries a drag edge with the pointer handlers", () => {
    const panel = fs.readFileSync(
      path.join(ROOT, "dashboard", "src", "components", "DetailsPanel.tsx"),
      "utf8",
    );
    expect(panel).toContain("lp-resize-handle");
    expect(panel).toContain("onPointerDown");
    expect(panel).toContain("onPointerMove");
    // The drag follows the pointer on the window: it leaves the thin edge
    // long before the user stops moving.
    expect(panel).toContain('window.addEventListener("pointermove"');
    expect(panel).toContain('window.addEventListener("pointerup"');
    // The panel is on the right: dragging left widens it.
    expect(panel).toContain("origin.width + (origin.x - event.clientX)");
    // A double-click restores the default.
    expect(panel).toContain("onDoubleClick");
  });

  it("the grid follows the width the app sets", () => {
    const app = fs.readFileSync(path.join(ROOT, "dashboard", "src", "app.tsx"), "utf8");
    expect(app).toContain("--lp-details-width");
    const css = fs.readFileSync(path.join(ROOT, "dashboard", "src", "dashboard.css"), "utf8");
    expect(css).toContain("grid-template-columns: 1fr var(--lp-details-width, 450px)");
    expect(css).toContain(".lp-resize-handle");
  });
});

describe("the growth schema tolerates a rewriting MCP client", () => {
  const step = {
    id: "s1",
    title: "split the handler",
    state: "completed",
    facts: ["the handler was split"],
    reason: "",
  };

  it("accepts the plain shape", () => {
    expect(growthStepSchema.safeParse(step).success).toBe(true);
  });

  it("accepts an array rewritten into an object with an `item` array", () => {
    const rewritten = { ...step, facts: { item: ["the handler was split"] } };
    const parsed = growthStepSchema.safeParse(rewritten);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.facts).toEqual(["the handler was split"]);
    }
  });

  it("accepts an empty array rewritten into an empty string", () => {
    const rewritten = { ...step, facts: "" };
    const parsed = growthStepSchema.safeParse(rewritten);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.facts).toEqual([]);
    }
  });

  it("accepts a string as a single fact", () => {
    const rewritten = { ...step, facts: "the handler was split" };
    const parsed = growthStepSchema.safeParse(rewritten);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.facts).toEqual(["the handler was split"]);
    }
  });

  it("still rejects a value that is not a list of facts", () => {
    expect(growthStepSchema.safeParse({ ...step, facts: 42 }).success).toBe(false);
    expect(growthStepSchema.safeParse({ ...step, facts: { a: 1 } }).success).toBe(
      false,
    );
  });
});
