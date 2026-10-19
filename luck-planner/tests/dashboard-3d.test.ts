/**
 * WebGL probe, the 2D/3D view policy and the lazy 3D chunk (PLAN.md stage I1).
 *
 * Stage I1 is the spike that de-risks block I: prove the tab can get a WebGL
 * context, pin the fallback ("no WebGL → stay on 2D and say why") and keep
 * `three`/`@react-three/fiber`/`@react-three/drei` out of the first chunk.
 * Everything here is a pure-module or artifact check — the repo's rule 4
 * keeps real-tab checks (console clean, scene visible) for the J2 manual
 * acceptance, so these tests pin the parts a tab cannot re-verify for us:
 *
 * 1. `detectWebGL` with injected canvas fakes (the vitest environment has no
 *    DOM): WebGL2, WebGL1 floor, "no context", "no canvas", a throwing
 *    `getContext`, and that the probe context is released (browsers cap live
 *    contexts).
 * 2. `planViewSwitch`: the `--disable-webgl` acceptance — the request for 3D
 *    is *refused* with a written explanation, never a black viewport.
 * 3. The built artifacts: `dashboard-3d.js` exists, the main chunk reaches it
 *    through exactly one dynamic `import()`, and no three/drei marker leaks
 *    into the file `index.html` loads eagerly.
 * 4. Source contracts: the loader imports only the *type* from the scene
 *    module (a value import would drag the chunk into the first bundle), and
 *    the scene module exports the imperative mount/dispose pair.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  detectWebGL,
  planViewSwitch,
  WEBGL_UNAVAILABLE_HINT,
  type WebGLCanvasLike,
} from "../dashboard/src/webgl";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ASSETS_DIR = path.join(ROOT, "dist", "dashboard", "assets");
const APP_JS = path.join(ASSETS_DIR, "dashboard.js");
const SCENE_JS = path.join(ASSETS_DIR, "dashboard-3d.js");
const INDEX_HTML = path.join(ROOT, "dist", "dashboard", "index.html");

// ---------------------------------------------------------------------------
// detectWebGL — the probe, with every browser outcome faked
// ---------------------------------------------------------------------------

/** A canvas whose `getContext` answers per type and records what was asked. */
function fakeCanvas(
  contexts: Record<string, unknown>,
  options: { throws?: boolean } = {},
): { canvas: WebGLCanvasLike; asked: string[] } {
  const asked: string[] = [];
  const canvas: WebGLCanvasLike = {
    getContext(type: string): unknown {
      asked.push(type);
      if (options.throws) throw new Error("driver blocked");
      return contexts[type] ?? null;
    },
  };
  return { canvas, asked };
}

describe("detectWebGL", () => {
  it("accepts a tab that offers WebGL2 and releases the probe context", () => {
    let lost = 0;
    const context = {
      getExtension: (name: string) =>
        name === "WEBGL_lose_context" ? { loseContext: () => (lost += 1) } : null,
    };
    const { canvas, asked } = fakeCanvas({ webgl2: context });

    const support = detectWebGL(() => canvas);
    expect(support).toEqual({ ok: true, reason: null });
    // WebGL2 first — one probe attempt, no fallback walk on a healthy tab.
    expect(asked).toEqual(["webgl2"]);
    // The probe context is freed: browsers cap live contexts (Chrome: 16),
    // and a probe that leaks one per reload would evict the scene's context.
    expect(lost).toBe(1);
  });

  it("falls back to WebGL1 when WebGL2 is refused", () => {
    const { canvas, asked } = fakeCanvas({ webgl: {} });
    expect(detectWebGL(() => canvas)).toEqual({ ok: true, reason: null });
    expect(asked).toEqual(["webgl2", "webgl"]);
  });

  it("keeps the experimental name as the last floor", () => {
    const { canvas, asked } = fakeCanvas({ "experimental-webgl": {} });
    expect(detectWebGL(() => canvas).ok).toBe(true);
    expect(asked).toEqual(["webgl2", "webgl", "experimental-webgl"]);
  });

  it("refuses when the browser offers no context at all", () => {
    const { canvas } = fakeCanvas({});
    const support = detectWebGL(() => canvas);
    expect(support.ok).toBe(false);
    // The reason lands in the status line — it must name WebGL, not be empty.
    expect(support.reason).toContain("no WebGL context");
  });

  it("refuses when there is no canvas (a non-DOM context)", () => {
    const support = detectWebGL(() => null);
    expect(support).toEqual({ ok: false, reason: "no canvas is available" });
  });

  it("never throws: a getContext that throws answers ok: false", () => {
    // A blocked driver or a tainted origin surfaces as an exception; the tab
    // must stay on 2D rather than crash the app on mount.
    const { canvas } = fakeCanvas({}, { throws: true });
    const support = detectWebGL(() => canvas);
    expect(support.ok).toBe(false);
    expect(support.reason).toBe("driver blocked");
  });

  it("survives a factory that throws", () => {
    const support = detectWebGL(() => {
      throw new Error("canvas factory exploded");
    });
    expect(support.ok).toBe(false);
    expect(support.reason).toBe("canvas factory exploded");
  });
});

// ---------------------------------------------------------------------------
// planViewSwitch — the fallback policy (--disable-webgl acceptance)
// ---------------------------------------------------------------------------

const OK = { ok: true, reason: null } as const;
const BLOCKED = { ok: false, reason: "the browser offered no WebGL context" } as const;

describe("planViewSwitch", () => {
  it("opens 3D when the probe passed", () => {
    expect(planViewSwitch(OK, "3d")).toEqual({ view: "3d", status: null });
  });

  it("refuses 3D without WebGL and explains it in words", () => {
    // The I1 acceptance case: launched with `--disable-webgl`, pressing 3D
    // must keep the diagram and put the reason in the status line — never a
    // silent no-op and never colour-only.
    const plan = planViewSwitch(BLOCKED, "3d");
    expect(plan.view).toBe("2d");
    expect(plan.status).toBe(WEBGL_UNAVAILABLE_HINT);
    expect(plan.status).toContain("WebGL");
    expect(plan.status).toContain("2D");
  });

  it("returns to 2D silently — the view that cannot fail", () => {
    expect(planViewSwitch(OK, "2d")).toEqual({ view: "2d", status: null });
    expect(planViewSwitch(BLOCKED, "2d")).toEqual({ view: "2d", status: null });
  });
});

// ---------------------------------------------------------------------------
// The built artifacts — the lazy chunk really is lazy
// ---------------------------------------------------------------------------

describe("the lazy 3D chunk in dist/dashboard", () => {
  it("exists next to the app bundle", () => {
    expect(fs.existsSync(SCENE_JS), "dist/dashboard/assets/dashboard-3d.js").toBe(
      true,
    );
    // Both are real builds, not stubs.
    expect(fs.statSync(APP_JS).size).toBeGreaterThan(100_000);
    expect(fs.statSync(SCENE_JS).size).toBeGreaterThan(100_000);
  });

  it("the main chunk reaches it through exactly one dynamic import", () => {
    const js = fs.readFileSync(APP_JS, "utf8");
    const occurrences = js.match(/dashboard-3d\.js/g) ?? [];
    expect(occurrences).toHaveLength(1);
    // The exact shape esbuild emits for `import("../dashboard-3d")`: a
    // runtime-fetched module, not a static import statement.
    expect(js).toContain('import("./dashboard-3d.js")');
  });

  it("keeps three and its helpers out of the eagerly loaded chunk", () => {
    const js = fs.readFileSync(APP_JS, "utf8");
    for (const marker of ["OrbitControls", "gridHelper", "WebGLRenderer"]) {
      expect(js, marker).not.toContain(marker);
    }
    // The probe itself does live in the first chunk — the fallback has to be
    // answerable before the scene code is even requested.
    expect(js).toContain("webgl2");
  });

  it("carries the spike scene in the 3D chunk", () => {
    const scene = fs.readFileSync(SCENE_JS, "utf8");
    // The acceptance target of I1: an empty scene with orbit controls.
    expect(scene).toContain("OrbitControls");
    expect(scene).toContain("gridHelper");
    // Imperative mount/dispose — the caller owns the container.
    expect(scene).toContain("mountScene3D");
    // And it is not the app: no toolbar, no diagram chrome leaked in.
    expect(scene).not.toContain("lp-app");
  });

  it("index.html never links the 3D chunk eagerly", () => {
    const html = fs.readFileSync(INDEX_HTML, "utf8");
    expect(html).not.toContain("dashboard-3d");
    expect(html).toContain('src="/assets/dashboard.js"');
  });
});

// ---------------------------------------------------------------------------
// Source contracts — what the bundler cannot tell us
// ---------------------------------------------------------------------------

describe("source contracts", () => {
  it("the loader imports only the type from the scene module", () => {
    // A *value* import of `../dashboard-3d` would drag the whole scene graph
    // (three, r3f, drei) into the first chunk — the exact failure this stage
    // exists to prevent. Only `import type` and a dynamic `import()` are
    // allowed to name the module.
    const source = fs.readFileSync(
      path.join(ROOT, "dashboard", "src", "components", "ThreeView.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      /import type \{[^}]*Scene3DHandle[^}]*\} from "\.\.\/dashboard-3d"/,
    );
    expect(source).toContain('import("../dashboard-3d")');
    const valueImports = source.match(/^import\s(?!\s*type)[^;]*from "\.\.\/dashboard-3d";$/gm);
    expect(valueImports ?? []).toEqual([]);
  });

  it("the scene module exports the mount handle with a dispose", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "dashboard", "src", "dashboard-3d.tsx"),
      "utf8",
    );
    expect(source).toContain("export function mountScene3D");
    expect(source).toContain("dispose(): void");
    // The spike scene itself: lights, grid and orbit controls.
    expect(source).toContain("<OrbitControls");
    expect(source).toContain("<gridHelper");
  });

  it("the app gates every 3D request through planViewSwitch", () => {
    // The toolbar only reports a request; the policy lives in one place, so
    // a tab without WebGL can never mount the scene component.
    const app = fs.readFileSync(
      path.join(ROOT, "dashboard", "src", "app.tsx"),
      "utf8",
    );
    expect(app).toContain("planViewSwitch(webgl, target)");
    const toolbar = fs.readFileSync(
      path.join(ROOT, "dashboard", "src", "components", "Toolbar.tsx"),
      "utf8",
    );
    // The button explains itself before it is pressed (the tooltip carries
    // the fallback text when the probe failed).
    expect(toolbar).toContain("WEBGL_UNAVAILABLE_HINT");
  });
});
