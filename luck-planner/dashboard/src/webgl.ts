/**
 * WebGL capability probe and the 2D/3D view policy (PLAN.md stage I1, the
 * block-I spike).
 *
 * The 3D tree (I2–I4) needs a real WebGL context, and the plugin cannot
 * assume one: a workspace browser may run with WebGL disabled
 * (`--disable-webgl`), a phone client may have none, and a driver blocklist
 * can turn a working tab into a black rectangle. The spike's answer, pinned
 * here, is the **fallback**: the dashboard stays on the 2D diagram and says
 * why, instead of switching into a scene that cannot render.
 *
 * Detection runs once per tab and takes a canvas factory so the policy can
 * be exercised without a DOM (the vitest environment has none) — the same
 * injected-boundary discipline as `dashboard/src/live.ts`.
 *
 * Client/server neutral: plain types and strings, no Node, no React.
 */

/** Which diagram the tab is showing. */
export type DashboardView = "2d" | "3d";

/** Outcome of the WebGL probe. */
export interface WebGLSupport {
  readonly ok: boolean;
  /** Short reason for the status line; `null` when WebGL works. */
  readonly reason: string | null;
}

/**
 * The slice of `HTMLCanvasElement` the probe touches. Structural on purpose:
 * tests hand in fakes, browsers hand in a real canvas.
 */
export interface WebGLCanvasLike {
  getContext(type: string): unknown;
}

export type WebGLCanvasFactory = () => WebGLCanvasLike | null;

/** Context names tried in order — WebGL2 first, WebGL1 as the floor. */
const CONTEXT_TYPES = ["webgl2", "webgl", "experimental-webgl"] as const;

/**
 * Shown when 3D was asked for without WebGL: the tab keeps the 2D diagram
 * and the explanation lands in the status line (never a silent no-op, and
 * never colour-only).
 */
export const WEBGL_UNAVAILABLE_HINT =
  "The 3D view needs WebGL, which this browser or launch flag has disabled — showing the 2D diagram.";

/** Status line while the lazy `dashboard-3d.js` chunk is arriving. */
export const THREE_LOADING_STATUS = "Loading the 3D view…";

/** Status line when the lazy chunk or the scene failed to start. */
export function threeFailedStatus(detail: string): string {
  return `The 3D view could not start: ${detail}`;
}

/** Toolbar tooltip for the 3D button when WebGL is available. */
export const THREE_BUTTON_HINT =
  "3D view: the project tree as a WebGL scene — drag to orbit, scroll to zoom (bees, bugs and goals arrive in stage I3).";

/**
 * Default factory for a real tab; `null` outside a DOM (server-side tests).
 *
 * `document` is reached structurally through `globalThis`, not as a global:
 * the file is imported by `tests/dashboard-3d.test.ts`, so the root
 * tsconfig (no DOM lib) compiles it — the same rule `client/use-host-typography.ts`
 * follows for `localStorage`.
 */
function browserCanvas(): WebGLCanvasLike | null {
  const scope = globalThis as unknown as {
    document?: { createElement(tag: string): WebGLCanvasLike };
  };
  const document = scope.document;
  if (!document) return null;
  try {
    return document.createElement("canvas");
  } catch {
    return null;
  }
}

/**
 * Frees the probe's context: browsers cap live WebGL contexts (Chrome: 16),
 * and a probe that leaks one per reload would evict a scene's context for no
 * reason. Best-effort — a fake context without the extension is fine.
 */
function releaseProbe(context: unknown): void {
  const probe = context as {
    getExtension?: (name: string) => { loseContext?: () => void } | null;
  };
  try {
    probe.getExtension?.("WEBGL_lose_context")?.loseContext?.();
  } catch {
    // Releasing is a courtesy, never a requirement.
  }
}

/**
 * Probes WebGL once. Never throws: a browser that refuses context creation,
 * a missing `document`, or a `getContext` that throws (blocked driver,
 * tainted origin) all answer `{ ok: false, reason }` — the caller then
 * keeps the 2D diagram.
 */
export function detectWebGL(
  createCanvas: WebGLCanvasFactory = browserCanvas,
): WebGLSupport {
  try {
    const canvas = createCanvas();
    if (canvas === null) {
      return { ok: false, reason: "no canvas is available" };
    }
    for (const type of CONTEXT_TYPES) {
      const context = canvas.getContext(type);
      if (context !== null && context !== undefined) {
        releaseProbe(context);
        return { ok: true, reason: null };
      }
    }
    return { ok: false, reason: "the browser offered no WebGL context" };
  } catch (cause) {
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** What a view request resolves to: the view to show, and the status line. */
export interface ViewSwitchPlan {
  /** The view the tab will actually show (may refuse the request). */
  readonly view: DashboardView;
  /** Status line to install, or `null` to leave the current one alone. */
  readonly status: string | null;
}

/**
 * Resolves a request from the toolbar's 2D/3D switch.
 *
 * - `2d` always wins, silently: it is the view that cannot fail.
 * - `3d` needs {@link WebGLSupport.ok}; without it the tab stays on 2D and
 *   the caller installs {@link WEBGL_UNAVAILABLE_HINT} — the acceptance case
 *   for `--disable-webgl` (PLAN.md I1).
 */
export function planViewSwitch(
  webgl: WebGLSupport,
  target: DashboardView,
): ViewSwitchPlan {
  if (target === "3d") {
    return webgl.ok
      ? { view: "3d", status: null }
      : { view: "2d", status: WEBGL_UNAVAILABLE_HINT };
  }
  return { view: "2d", status: null };
}
