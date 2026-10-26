/**
 * Dashboard build output and its serving path (PLAN.md stage G1).
 *
 * Stage G1 is the first stage that produces `dist/dashboard` instead of the
 * F1 placeholder, so this suite pins the whole chain the acceptance criteria
 * name:
 *
 * 1. `scripts/bundle.mjs` writes `dist/dashboard/index.html` + the asset pair
 *    the shell links (`assets/dashboard.js`, `assets/dashboard.css`), the
 *    committed artifact matches a *fresh* deterministic build (file set
 *    included), and that build is reproducible in a temp root — never in the
 *    shared `dist/`, which parallel test files read.
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
// Stage I1: the lazy 3D entry, hashed with the pair so a rebuild stays
// byte-identical across the whole split graph (chunk hashes are content-
// derived, so this also covers the shared chunk-* files).
const SCENE_JS = path.join(ASSETS_DIR, "dashboard-3d.js");

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
    // H1 live updates: the SSE subscription and the toolbar indicator.
    expect(js).toContain("/api/events");
    expect(js).toContain("tree-changed");
    expect(js).toContain("lp-live");
    // K2 modal: the portal, the dialog contract and the Escape close ship in
    // the first chunk with the board that opens it.
    expect(js).toContain("lp-modal-overlay");
    expect(js).toContain('role: "dialog"');
    expect(js).toContain("Escape");
    expect(js).toContain("createPortal");
    // K1 plain board: the card view ships in the first chunk with its
    // zone/card classes and the default-view label.
    expect(js).toContain("lp-plain-zone");
    expect(js).toContain("lp-plain-card");
    expect(js).toContain("In motion");
  });

  it("rebuilds deterministically, without touching the committed artifact", () => {
    // The rebuild runs into *temp* roots, never into the shared `dist/`:
    // vitest runs test files in parallel, and the chunk sweep would briefly
    // unlink `chunk-*.js` under the sibling suites that read the built graph
    // (`dashboard-3d.test.ts`) — a genuinely flaky failure, fixed by keeping
    // every write out of the artifact the other files read. `pretest` still
    // rebuilds `dist/` before the suite, so those readers see a fresh build.
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "luck-planner-build-a-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "luck-planner-build-b-"));
    try {
      for (const outRoot of [first, second]) {
        execFileSync(
          process.execPath,
          [path.join(ROOT, "scripts", "bundle.mjs"), "--outdir", outRoot],
          { cwd: ROOT, stdio: "pipe" },
        );
      }
      const digestA = hashTree(path.join(first, "dist"));
      const digestB = hashTree(path.join(second, "dist"));
      expect(digestB).toBe(digestA);
      // …and the committed artifact *is* that build, file set included: a
      // byte-identical rebuild is what makes shipping `dist/` in the repo
      // honest, and comparing trees also catches a stale `chunk-*.js` left
      // behind by an older stage.
      expect(hashTree(path.join(ROOT, "dist"))).toBe(digestA);
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  }, 120000);
});

/** Sorted recursive digest of one output tree (relative paths + bytes). */
function hashTree(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

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

describe("source contracts the bundler cannot tell us", () => {
  it("puts the Plain button before 2D and 3D in the toolbar", () => {
    // ADR-10: the card board is the default view, and its button reads
    // first — the order is the contract, not a rendering accident.
    const toolbar = fs.readFileSync(
      path.join(ROOT, "dashboard", "src", "components", "Toolbar.tsx"),
      "utf8",
    );
    const plain = toolbar.indexOf('onViewChange("plain")');
    const two = toolbar.indexOf('onViewChange("2d")');
    const three = toolbar.indexOf('onViewChange("3d")');
    expect(plain).toBeGreaterThan(-1);
    expect(plain).toBeLessThan(two);
    expect(two).toBeLessThan(three);
  });

  it("hides the diagram layer switch and the details panel on the board", () => {
    // The layer is a property of the diagrams (G5), and the K2 modal takes
    // the panel's job on the board — the "click a node on the diagram"
    // placeholder would only confuse there.
    const toolbar = fs.readFileSync(
      path.join(ROOT, "dashboard", "src", "components", "Toolbar.tsx"),
      "utf8",
    );
    expect(toolbar).toContain('props.view === "plain" ? null :');
    const app = fs.readFileSync(
      path.join(ROOT, "dashboard", "src", "app.tsx"),
      "utf8",
    );
    expect(app).toContain('className={view === "plain" ? "lp-body lp-body-plain" : "lp-body"}');
    expect(app).toContain("{view === \"plain\" ? null : (");
    // The board renders through the same selection the diagrams use.
    expect(app).toContain("selectedEntityId={selectedId}");
    expect(app).toContain("plainReveal(plainBoard, hit.id)");
  });

  it("styles the K2 modal as a viewport-fixed portal and makes every card open it", () => {
    // The modal portals onto `document.body`, *outside* the `.lp-app` grid:
    // without its own fixed positioning the overlay falls below the legend
    // and the modal's body-scroll lock traps the user at the bottom of the
    // page (the 0.34.1 regression report from live acceptance).
    const css = fs.readFileSync(APP_CSS, "utf8");
    const overlay = css.indexOf(".lp-modal-overlay");
    expect(overlay, "dashboard.css has .lp-modal-overlay").toBeGreaterThan(-1);
    expect(css.slice(overlay, css.indexOf("}", overlay))).toContain("position: fixed");
    expect(css).toContain(".lp-modal {");
    expect(css).toContain(".lp-modal-body");

    // K2 acceptance: *every* card kind opens the modal — goal and bug cards
    // route through the same handler as leaf cards, not a static article.
    const plain = fs.readFileSync(
      path.join(ROOT, "dashboard", "src", "components", "PlainView.tsx"),
      "utf8",
    );
    expect(plain).toContain("props.onSelectCard(card.kind, card.entityId)");
    expect(plain).not.toContain("<article");
  });
});

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

  it("builds the SSE channel URL the tab subscribes to (stage H1)", async () => {
    const origin = await boot();
    const client = new DashboardApi(origin, TOKEN, P);

    const url = new URL(client.eventsUrl());
    expect(url.pathname).toBe("/api/events");
    // The token travels in the query — `EventSource` cannot set headers.
    expect(url.searchParams.get("token")).toBe(TOKEN);
    expect(url.searchParams.get("project")).toBe(P);

    const controller = new AbortController();
    const res = await fetch(client.eventsUrl(), { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const first = await reader.read();
    const head = new TextDecoder().decode(first.value);
    expect(head).toContain("retry: 3000");
    expect(head).toContain("event: ready");
    expect(head).toContain('"version"');
    controller.abort();
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
