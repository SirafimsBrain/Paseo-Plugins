/**
 * The details drawer (0.54.0) and the lenient growth schema (stage D5).
 *
 * Two small rules with real consequences:
 *
 * 1. **The details are a drawer under the diagram**, closed by default. The
 *    panel was a right-hand column and, once the planning strip joined the
 *    two-column body, it took the main area and squeezed the diagram into the
 *    narrow column — the reported 2D breakage. The open state is remembered
 *    for the browsing session (`sessionStorage`) and the height across visits
 *    (`localStorage`); both storages are injected, so the rule is tested
 *    without a DOM.
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
  clampDetailsHeight,
  DEFAULT_DETAILS_HEIGHT,
  DEFAULT_DETAILS_OPEN,
  DETAILS_HEIGHT_KEY,
  DETAILS_OPEN_KEY,
  forgetDetailsHeight,
  MAX_DETAILS_HEIGHT,
  MIN_DETAILS_HEIGHT,
  readStoredDetailsHeight,
  readStoredDetailsOpen,
  storeDetailsHeight,
  storeDetailsOpen,
  type DetailsPanelStorage,
} from "../dashboard/src/details-panel";
import { growthStepSchema } from "../shared/growth";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A storage that keeps the values in a map. */
function memoryStorage(): DetailsPanelStorage & { values: Map<string, string> } {
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

describe("the details drawer's height", () => {
  it("opens at a readable height and clamps a dragged one", () => {
    expect(DEFAULT_DETAILS_HEIGHT).toBe(280);
    expect(clampDetailsHeight(10)).toBe(MIN_DETAILS_HEIGHT);
    expect(clampDetailsHeight(5000)).toBe(MAX_DETAILS_HEIGHT);
    expect(clampDetailsHeight(420)).toBe(420);
    // A pointer event without coordinates must not produce NaN.
    expect(clampDetailsHeight(Number.NaN)).toBe(DEFAULT_DETAILS_HEIGHT);
  });

  it("reads the stored height and ignores a broken one", () => {
    const storage = memoryStorage();
    expect(readStoredDetailsHeight(storage)).toBe(DEFAULT_DETAILS_HEIGHT);
    storeDetailsHeight(storage, 400);
    expect(storage.values.get(DETAILS_HEIGHT_KEY)).toBe("400");
    expect(readStoredDetailsHeight(storage)).toBe(400);
    // Out of bounds and garbage fall back to the default.
    storage.values.set(DETAILS_HEIGHT_KEY, "9999");
    expect(readStoredDetailsHeight(storage)).toBe(DEFAULT_DETAILS_HEIGHT);
    storage.values.set(DETAILS_HEIGHT_KEY, "tall");
    expect(readStoredDetailsHeight(storage)).toBe(DEFAULT_DETAILS_HEIGHT);
  });

  it("forgets the height on request", () => {
    const storage = memoryStorage();
    storeDetailsHeight(storage, 400);
    forgetDetailsHeight(storage);
    expect(storage.values.has(DETAILS_HEIGHT_KEY)).toBe(false);
    expect(readStoredDetailsHeight(storage)).toBe(DEFAULT_DETAILS_HEIGHT);
  });
});

describe("the details drawer's open state", () => {
  it("is closed by default — the diagram is what the tab is for", () => {
    expect(DEFAULT_DETAILS_OPEN).toBe(false);
    expect(readStoredDetailsOpen(null)).toBe(false);
    expect(readStoredDetailsOpen(memoryStorage())).toBe(false);
  });

  it("remembers the user's choice for the session", () => {
    const storage = memoryStorage();
    storeDetailsOpen(storage, true);
    expect(storage.values.get(DETAILS_OPEN_KEY)).toBe("true");
    expect(readStoredDetailsOpen(storage)).toBe(true);
    storeDetailsOpen(storage, false);
    expect(readStoredDetailsOpen(storage)).toBe(false);
    // Only the exact strings count; a hand-edited value is not a decision.
    storage.values.set(DETAILS_OPEN_KEY, "yes");
    expect(readStoredDetailsOpen(storage)).toBe(false);
  });

  it("survives storages that refuse to work", () => {
    const hostile: DetailsPanelStorage = {
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
    expect(readStoredDetailsHeight(hostile)).toBe(DEFAULT_DETAILS_HEIGHT);
    expect(readStoredDetailsOpen(hostile)).toBe(DEFAULT_DETAILS_OPEN);
    expect(() => storeDetailsHeight(hostile, 300)).not.toThrow();
    expect(() => storeDetailsOpen(hostile, true)).not.toThrow();
    expect(() => forgetDetailsHeight(hostile)).not.toThrow();
  });
});

describe("the drawer is a bottom drawer with a toggle", () => {
  const readPanel = (): string =>
    fs.readFileSync(
      path.join(ROOT, "dashboard", "src", "components", "DetailsPanel.tsx"),
      "utf8",
    );

  it("carries a vertical drag edge with the pointer handlers", () => {
    const panel = readPanel();
    expect(panel).toContain("lp-resize-handle");
    expect(panel).toContain("onPointerDown");
    expect(panel).toContain('window.addEventListener("pointermove"');
    expect(panel).toContain('window.addEventListener("pointerup"');
    // The drawer is at the bottom: dragging up makes it taller.
    expect(panel).toContain("origin.height + (origin.y - event.clientY)");
    expect(panel).toContain('aria-orientation="horizontal"');
    // A double-click restores the default.
    expect(panel).toContain("onDoubleClick");
  });

  it("collapses to a header with an aria-expanded toggle", () => {
    const panel = readPanel();
    expect(panel).toContain("lp-details-toggle");
    expect(panel).toContain("aria-expanded={props.open}");
    // The body is not rendered while closed: a hidden panel must cost nothing.
    expect(panel).toContain("{props.open ? (");
  });

  it("the layout is one column, with the diagram taking the room", () => {
    const css = fs.readFileSync(
      path.join(ROOT, "dashboard", "src", "dashboard.css"),
      "utf8",
    );
    // The reported breakage: the canvas and the details were two grid columns.
    expect(css).not.toContain("grid-template-columns: 1fr var(--lp-details-width");
    expect(css).toContain("flex-direction: column;");
    expect(css).toContain(".lp-body > .lp-canvas");
    expect(css).toContain(".lp-body > .lp-planning-strip");
    expect(css).toContain("border-top: 1px solid var(--lp-border, #262b36);");
  });

  it("the app stores the open state in the session and the height across visits", () => {
    const app = fs.readFileSync(
      path.join(ROOT, "dashboard", "src", "app.tsx"),
      "utf8",
    );
    expect(app).toContain("window.sessionStorage");
    expect(app).toContain("readStoredDetailsOpen(detailsSessionStorage())");
    expect(app).toContain("storeDetailsOpen(detailsSessionStorage(), next)");
    expect(app).toContain("readStoredDetailsHeight(detailsStorage())");
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
