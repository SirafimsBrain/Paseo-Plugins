/**
 * Dashboard build output and its serving path (PLAN.md stage G1).
 *
 * Stage G1 is the first stage that produces `dist/dashboard` instead of the
 * F1 placeholder, so this suite pins the whole chain the acceptance criteria
 * name:
 *
 * 1. `scripts/bundle.mjs` writes `dist/dashboard/index.html` + the asset pair
 *    the shell links (`assets/dashboard.js`, `assets/dashboard.css`), and the
 *    rebuild is byte-identical (the same determinism rule the MCP bundle has).
 * 2. The bundle is a *production* React build: it must not carry a live
 *    `process.env` reference, which would kill the tab with a
 *    `ReferenceError: process is not defined` before the first render.
 * 3. The real `DashboardHttpServer`, pointed at the real `dist/dashboard`
 *    (its default), serves that shell, its assets with the right content
 *    types, and the SPA fallback for deep links.
 * 4. The browser API client (`dashboard/src/api.ts`) round-trips against that
 *    real server + a real store: the very cross-boundary contract the app
 *    depends on, with no mocks.
 *
 * The tab-level checks that need a real browser (console clean, theme
 * applied) stay manual (PLAN rule 4); everything else is asserted here.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardHttpServer } from "../server/http-server";
import { LuckPlannerStore } from "../server/store";
import type { Node } from "../shared/tree";
import { DashboardApi, resolveApiOrigin } from "../dashboard/src/api";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DASHBOARD_DIR = path.join(ROOT, "dist", "dashboard");
const INDEX_FILE = path.join(DASHBOARD_DIR, "index.html");
const ASSETS_DIR = path.join(DASHBOARD_DIR, "assets");
const APP_JS = path.join(ASSETS_DIR, "dashboard.js");
const APP_CSS = path.join(ASSETS_DIR, "dashboard.css");

const P = "/tmp/luck-planner-g1";
const ACTOR = "user";
const TOKEN = "lp_test_token_g1";

let dir = "";
let store: LuckPlannerStore | undefined;
let server: DashboardHttpServer | undefined;

afterEach(async () => {
  if (server) await server.stop();
  server = undefined;
  if (store) store.close();
  store = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("dist/dashboard (the built SPA)", () => {
  it("exists with the shell and the asset pair the shell links", () => {
    // `pretest` runs scripts/bundle.mjs, so a plain `vitest run` sees a fresh
    // build — the same guarantee the MCP bundle suite relies on.
    expect(fs.existsSync(INDEX_FILE), "dist/dashboard/index.html").toBe(true);
    expect(fs.existsSync(APP_JS), "dist/dashboard/assets/dashboard.js").toBe(true);
    expect(fs.existsSync(APP_CSS), "dist/dashboard/assets/dashboard.css").toBe(true);

    const html = fs.readFileSync(INDEX_FILE, "utf8");
    // Root-absolute URLs: a deep link like /tree/leaf/123 must resolve the
    // assets against the origin, not against its own path.
    expect(html).toContain('src="/assets/dashboard.js"');
    expect(html).toContain('href="/assets/dashboard.css"');
    expect(html).toContain('id="root"');
    expect(html).toContain("<title>luck-planner dashboard</title>");
  });

  it("is a production React build (no live process.env in the bundle)", () => {
    const js = fs.readFileSync(APP_JS, "utf8");
    // esbuild's `define` replaces every process.env.NODE_ENV; a raw reference
    // surviving here means the define was dropped and the tab would crash on
    // load in a browser (where `process` does not exist).
    expect(js).not.toContain("process.env");
    // The app itself is in the bundle, not an empty stub.
    expect(js).toContain("lp-app");
    expect(js).toContain("luck-planner:theme");
    // The G5 growth layer ships with it: the toolbar switch and the heat
    // class the nodes are tinted with.
    expect(js).toContain("Growth heat");
    expect(js).toContain("lp-node-growthbar");
  });

  it("rebuilds deterministically", () => {
    const hashDashboard = (): string => {
      execFileSync(process.execPath, [path.join(ROOT, "scripts", "bundle.mjs")], {
        cwd: ROOT,
        stdio: "pipe",
      });
      return createHash("sha256")
        .update(fs.readFileSync(APP_JS))
        .update(fs.readFileSync(APP_CSS))
        .update(fs.readFileSync(INDEX_FILE))
        .digest("hex");
    };
    expect(hashDashboard()).toBe(hashDashboard());
  }, 60000);
});

/** Boots a real server over a real store, serving the real dist/dashboard. */
async function boot(): Promise<string> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "luck-planner-g1-"));
  store = new LuckPlannerStore({ dbPath: path.join(dir, "luck.db") });
  server = new DashboardHttpServer({
    store,
    token: TOKEN,
    port: 0,
  });
  await server.start();
  return server.origin!;
}

/** The small tree every read below is asserted against. */
function seed(target: LuckPlannerStore): Node {
  const root = target.createNode({
    projectKey: P,
    parentId: null,
    kind: "root",
    name: "Tech stack",
    actor: ACTOR,
  });
  const trunk = target.createNode({
    projectKey: P,
    parentId: root.id,
    kind: "trunk",
    name: "Platform",
    actor: ACTOR,
  });
  const branch = target.createNode({
    projectKey: P,
    parentId: trunk.id,
    kind: "branch",
    name: "billing",
    actor: ACTOR,
  });
  return target.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "retry failed charges",
    actor: ACTOR,
  });
}

describe("the built SPA served by the real HTTP server", () => {
  it("serves the shell, its assets and the SPA fallback", async () => {
    const origin = await boot();

    const index = await fetch(`${origin}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    const html = await index.text();
    expect(html).toContain('id="root"');
    expect(html).toContain("/assets/dashboard.js");

    const js = await fetch(`${origin}/assets/dashboard.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");

    const css = await fetch(`${origin}/assets/dashboard.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");

    // A client-side route resolves to the shell, not to a 404.
    const deep = await fetch(`${origin}/tree/leaf/123`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('id="root"');
  });
});

describe("the browser API client against the real server", () => {
  it("reads stats, the tree graph and one node; a bad token fails loudly", async () => {
    const origin = await boot();
    const leaf = seed(store!);
    const client = new DashboardApi(origin, TOKEN, P);

    const stats = await client.stats();
    expect(stats.projectKey).toBe(P);
    expect(stats.nodes.total).toBe(4);

    const tree = await client.tree();
    expect(tree.nodes).toHaveLength(4);
    expect(tree.bees).toEqual([]);

    const node = await client.node(leaf.id);
    expect(node.node.name).toBe("retry failed charges");
    expect(node.path.map((step) => step.kind)).toEqual([
      "root",
      "trunk",
      "branch",
      "leaf",
    ]);

    // A wrong token must produce a message that tells the user what to do,
    // not a generic HTTP failure.
    const anon = new DashboardApi(origin, "lp_wrong", P);
    await expect(anon.stats()).rejects.toThrow(/access token was rejected/i);
  });

  it("calls fetch with the global receiver (window.fetch rejects any other)", async () => {
    // Regression (found during the G3 visual acceptance): the client used to
    // invoke its fetch as a method of itself (`this.fetchImpl(url)`), which
    // Node tolerates but a browser rejects with
    // `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation` —
    // the dashboard then never loaded a single payload. A receiver-strict
    // stand-in reproduces the browser's rule in Node.
    const origin = await boot();
    seed(store!);

    let receiver: unknown = null;
    const receiverStrictFetch = function (
      this: unknown,
      input: string | URL | Request,
    ): Promise<Response> {
      receiver = this;
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return fetch(input);
    };

    const client = new DashboardApi(
      origin,
      TOKEN,
      P,
      receiverStrictFetch as typeof fetch,
    );
    const stats = await client.stats();
    expect(stats.nodes.total).toBe(4);
    expect(receiver).toBe(globalThis);
  });
});

describe("resolveApiOrigin", () => {
  it("uses the tab's own origin (the SPA and the API share one socket)", () => {
    expect(resolveApiOrigin("http://127.0.0.1:9123/?token=t&project=p")).toBe(
      "http://127.0.0.1:9123",
    );
    expect(resolveApiOrigin("https://example.test/x")).toBe("https://example.test");
  });

  it("falls back to the default loopback origin for non-http contexts", () => {
    expect(resolveApiOrigin("file:///tmp/dashboard/index.html")).toBe(
      "http://127.0.0.1:8899",
    );
    expect(resolveApiOrigin("not a url")).toBe("http://127.0.0.1:8899");
  });
});
