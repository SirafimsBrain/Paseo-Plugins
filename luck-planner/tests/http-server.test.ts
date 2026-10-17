import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_EVENT_READY,
  DASHBOARD_EVENT_TREE_CHANGED,
  nodeResponseSchema,
  searchResponseSchema,
  statsResponseSchema,
  treeResponseSchema,
} from "../shared/api";
import {
  DEFAULT_DASHBOARD_HOST,
  DashboardHttpServer,
  buildNodeResponse,
  buildTreeResponse,
} from "../server/http-server";
import { LuckPlannerStore } from "../server/store";
import type { Goal, GoalStep } from "../shared/goals";
import type { GrowthStep } from "../shared/growth";
import type { Node } from "../shared/tree";

/**
 * Stage F1 acceptance (`PLAN.md`): the read-only dashboard HTTP server over a
 * real SQLite file on a real loopback port, driven by `fetch` — no mocks, the
 * same discipline as `tests/http-server.test.ts` in memory-flash.
 *
 * Pinned here: `/health` is public, every `/api/*` request needs the token,
 * each response parses against its shared contract (the composite tree graph
 * plus the schemas the RPC layer reuses), project scoping holds, the SPA is
 * served (with a truthful placeholder when nothing is built), the SSE stream
 * opens and receives broadcasts, and `stop()` releases the port.
 */

const P = "/projects/demo";
const OTHER = "/projects/other";
const ACTOR = "agent:coder";
const TOKEN = "test-token";
const VERSION = "0.17.0-test";

let dir: string;
let dashboardDir: string;
let store: LuckPlannerStore;
let server: DashboardHttpServer;
let base: string;

function seedTree(target: LuckPlannerStore): {
  root: Node;
  trunk: Node;
  branch: Node;
  leafA: Node;
  leafB: Node;
} {
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
  const leafA = target.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "retry failed charges",
    actor: ACTOR,
  });
  const leafB = target.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "prorate refunds",
    actor: ACTOR,
  });
  return { root, trunk, branch, leafA, leafB };
}

function seedRelations(target: LuckPlannerStore, leafA: Node, leafB: Node): {
  goal: Goal;
  bugId: string;
} {
  target.createBee({
    projectKey: P,
    sourceLeafId: leafA.id,
    targetLeafId: leafB.id,
    impact: "shares the retry queue",
    actor: ACTOR,
  });
  const bug = target.createBug({
    projectKey: P,
    title: "queue stalls",
    severity: "high",
    nodeIds: [leafA.id],
    actor: ACTOR,
  });
  const plan: GoalStep[] = [
    { id: "s1", title: "migrate charges", description: "" },
    { id: "s2", title: "backfill worker", description: "" },
  ];
  const created = target.createGoal({
    projectKey: P,
    formalText: "ship billing retries",
    plan,
    actor: ACTOR,
  });
  const goal = target.setGoalStatus({
    projectKey: P,
    id: created.id,
    status: "proposed",
    actor: ACTOR,
  });
  const steps: GrowthStep[] = [
    { id: "g1", title: "schema", state: "completed", facts: ["drafted"], reason: "" },
    { id: "g2", title: "worker", state: "in_progress", facts: [], reason: "in review" },
  ];
  target.createGrowth({
    projectKey: P,
    subjectType: "node",
    subjectId: leafA.id,
    steps,
    actor: ACTOR,
  });
  return { goal, bugId: bug.id };
}

/** Fresh store + server on an ephemeral port, with a built SPA shell. */
async function boot(options?: {
  dashboard?: boolean;
  token?: string;
}): Promise<void> {
  store = new LuckPlannerStore({ dbPath: path.join(dir, "luck.db") });
  dashboardDir = path.join(dir, "dashboard");
  if (options?.dashboard !== false) {
    mkdirSync(path.join(dashboardDir, "assets"), { recursive: true });
    writeFileSync(
      path.join(dashboardDir, "index.html"),
      "<!doctype html><title>dashboard</title>",
    );
    writeFileSync(path.join(dashboardDir, "assets", "app.js"), "console.log('ok')");
  }
  server = new DashboardHttpServer({
    store,
    token: options?.token ?? TOKEN,
    port: 0,
    version: VERSION,
    dashboardDir,
  });
  await server.start();
  base = server.origin!;
}

async function teardown(): Promise<void> {
  // The pure-builder suites never boot a server; tolerate that.
  const running = server as DashboardHttpServer | undefined;
  if (running) await running.stop();
  const open = store as LuckPlannerStore | undefined;
  if (open) open.close();
  rmSync(dir, { recursive: true, force: true });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "luck-planner-http-"));
});

afterEach(async () => {
  await teardown();
});

/** GET with the token in the query string (how the browser tab is opened). */
function get(pathname: string, token: string | null = TOKEN): Promise<Response> {
  const url = new URL(`${base}${pathname}`);
  if (token !== null) url.searchParams.set("token", token);
  return fetch(url);
}

describe("response builders (pure)", () => {
  it("builds the graph-ready tree for one project only", () => {
    const local = new LuckPlannerStore({ dbPath: path.join(dir, "graph.db") });
    try {
      const { leafA, leafB } = seedTree(local);
      const { goal, bugId } = seedRelations(local, leafA, leafB);

      const response = buildTreeResponse(local, P);
      const parsed = treeResponseSchema.parse(response);
      expect(parsed.projectKey).toBe(P);
      expect(parsed.nodes.map((node) => node.name)).toContain("retry failed charges");
      expect(parsed.bees).toHaveLength(1);
      expect(parsed.bugs.map((bug) => bug.id)).toEqual([bugId]);
      expect(parsed.bugAttachments).toEqual([{ bugId, nodeId: leafA.id }]);
      expect(parsed.goals.map((entry) => entry.id)).toEqual([goal.id]);
      expect(parsed.growth).toHaveLength(1);
      expect(parsed.growth[0].subjectId).toBe(leafA.id);

      // Never crosses the project boundary (ADR-2).
      const foreign = treeResponseSchema.parse(buildTreeResponse(local, OTHER));
      expect(foreign.nodes).toEqual([]);
      expect(foreign.bees).toEqual([]);
      expect(foreign.bugs).toEqual([]);
      expect(foreign.goals).toEqual([]);
      expect(foreign.growth).toEqual([]);
    } finally {
      local.close();
    }
  });

  it("builds one node with its path, links, history and growth", () => {
    const local = new LuckPlannerStore({ dbPath: path.join(dir, "node.db") });
    try {
      const { root, leafA, leafB } = seedTree(local);
      seedRelations(local, leafA, leafB);

      const response = buildNodeResponse(local, P, leafA.id);
      expect(response).not.toBeNull();
      const parsed = nodeResponseSchema.parse(response);
      expect(parsed.node.id).toBe(leafA.id);
      expect(parsed.path[0].id).toBe(root.id);
      expect(parsed.path[parsed.path.length - 1].id).toBe(leafA.id);
      expect(parsed.bees).toHaveLength(1);
      expect(parsed.bugs).toHaveLength(1);
      expect(parsed.blockingBugs).toHaveLength(1);
      expect(parsed.history.length).toBeGreaterThan(0);
      expect(parsed.growth).not.toBeNull();

      expect(buildNodeResponse(local, P, "00000000-0000-4000-8000-000000000000")).toBeNull();
      expect(buildNodeResponse(local, OTHER, leafA.id)).toBeNull();
    } finally {
      local.close();
    }
  });
});

describe("DashboardHttpServer", () => {
  it("answers /health without a token", async () => {
    await boot();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      ok: true,
      server: "luck-planner",
      version: VERSION,
    });
  });

  it("401s every /api request without the token", async () => {
    await boot();
    seedTree(store);

    const missing = await fetch(`${base}/api/tree?project=${encodeURIComponent(P)}`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });

    const wrong = await get(`/api/tree?project=${encodeURIComponent(P)}`, "nope");
    expect(wrong.status).toBe(401);

    // Same length, different byte — the constant-time path must still reject.
    const sameLength = await get(
      `/api/tree?project=${encodeURIComponent(P)}`,
      "test-tokeN",
    );
    expect(sameLength.status).toBe(401);

    const wrongScheme = await fetch(`${base}/api/stats?project=${encodeURIComponent(P)}`, {
      headers: { Authorization: "Basic abc" },
    });
    expect(wrongScheme.status).toBe(401);
  });

  it("serves /api/tree with the token as a query param or a Bearer header", async () => {
    await boot();
    const { leafA, leafB } = seedTree(store);
    const { goal } = seedRelations(store, leafA, leafB);

    const viaQuery = await get(`/api/tree?project=${encodeURIComponent(P)}`);
    expect(viaQuery.status).toBe(200);
    const tree = treeResponseSchema.parse(await viaQuery.json());
    expect(tree.projectKey).toBe(P);
    expect(tree.nodes).toHaveLength(5);
    expect(tree.bees).toHaveLength(1);
    expect(tree.bugs).toHaveLength(1);
    expect(tree.goals.map((entry) => entry.id)).toEqual([goal.id]);
    expect(tree.growth).toHaveLength(1);

    const viaHeader = await fetch(`${base}/api/tree?project=${encodeURIComponent(P)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(viaHeader.status).toBe(200);
    expect((await viaHeader.json()).nodes).toHaveLength(5);
  });

  it("scopes /api/tree by project and rejects a missing project", async () => {
    await boot();
    seedTree(store);

    const missing = await get("/api/tree");
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("project");

    const foreign = await get(`/api/tree?project=${encodeURIComponent(OTHER)}`);
    const tree = treeResponseSchema.parse(await foreign.json());
    expect(tree.nodes).toEqual([]);
  });

  it("serves /api/node/:id and 404s an unknown id", async () => {
    await boot();
    const { root, leafA, leafB } = seedTree(store);
    seedRelations(store, leafA, leafB);

    const res = await get(`/api/node/${leafA.id}?project=${encodeURIComponent(P)}`);
    expect(res.status).toBe(200);
    const detail = nodeResponseSchema.parse(await res.json());
    expect(detail.node.id).toBe(leafA.id);
    expect(detail.path[0].id).toBe(root.id);

    const unknown = await get(
      `/api/node/00000000-0000-4000-8000-000000000000?project=${encodeURIComponent(P)}`,
    );
    expect(unknown.status).toBe(404);

    // Foreign project resolves the same id to nothing.
    const foreign = await get(`/api/node/${leafA.id}?project=${encodeURIComponent(OTHER)}`);
    expect(foreign.status).toBe(404);
  });

  it("serves /api/search with filters and rejects an unknown kind", async () => {
    await boot();
    const { leafA } = seedTree(store);

    const res = await get(`/api/search?project=${encodeURIComponent(P)}&q=retry%20failed`);
    expect(res.status).toBe(200);
    const body = searchResponseSchema.parse(await res.json());
    expect(body.results.some((hit) => hit.node.id === leafA.id)).toBe(true);

    const filtered = await get(
      `/api/search?project=${encodeURIComponent(P)}&kind=leaf&status=draft`,
    );
    const filteredBody = searchResponseSchema.parse(await filtered.json());
    expect(filteredBody.results.length).toBeGreaterThan(0);
    for (const hit of filteredBody.results) expect(hit.node.kind).toBe("leaf");

    const bad = await get(`/api/search?project=${encodeURIComponent(P)}&kind=leafy`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("unknown node kind");
  });

  it("serves /api/stats", async () => {
    await boot();
    const { leafA, leafB } = seedTree(store);
    seedRelations(store, leafA, leafB);

    const res = await get(`/api/stats?project=${encodeURIComponent(P)}`);
    expect(res.status).toBe(200);
    const stats = statsResponseSchema.parse(await res.json());
    expect(stats.projectKey).toBe(P);
    expect(stats.nodes.total).toBe(5);
    expect(stats.leaves.total).toBe(2);
    expect(stats.bees).toBe(1);
    expect(stats.bugs).toEqual({ total: 1, open: 1 });
    expect(stats.growthRecords).toBe(1);
  });

  it("answers 405 for non-GET and 404 for an unknown /api path", async () => {
    await boot();
    const post = await fetch(`${base}/api/tree?token=${TOKEN}&project=${encodeURIComponent(P)}`, {
      method: "POST",
    });
    expect(post.status).toBe(405);

    const unknown = await get("/api/nope");
    expect(unknown.status).toBe(404);

    // Unknown routes are authenticated too: the route table is not exposed.
    const unknownNoToken = await fetch(`${base}/api/nope`);
    expect(unknownNoToken.status).toBe(401);
  });

  it("serves the SPA shell, assets and the client-side fallback", async () => {
    await boot();

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("dashboard");

    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(await asset.text()).toContain("ok");

    // Extensionless deep link → index.html (client-side routing).
    const deep = await fetch(`${base}/tree/leaf/123`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get("content-type")).toContain("text/html");

    // Missing asset with an extension stays a 404.
    const missing = await fetch(`${base}/assets/gone.js`);
    expect(missing.status).toBe(404);
  });

  it("serves the built-in placeholder when the dashboard is not built", async () => {
    await boot({ dashboard: false });
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("not built");
  });

  it("never lets a traversal read a file outside the dashboard root", async () => {
    await boot();
    writeFileSync(path.join(dir, "secret.txt"), "TOP-SECRET");

    // A raw request so the encoded dot segments reach the server verbatim
    // (the global fetch/URL parser would normalize them away client-side).
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        {
          host: DEFAULT_DASHBOARD_HOST,
          port: server.boundTcpPort,
          path: "/%2e%2e%2fsecret.txt",
          method: "GET",
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += String(chunk);
          });
          response.on("end", () => resolve(`${response.statusCode}:${text}`));
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(body).toBe("404:{\"error\":\"not found\"}\n");
    expect(body).not.toContain("TOP-SECRET");
  });

  it("streams SSE, delivers broadcasts and counts clients", async () => {
    await boot();
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events?token=${TOKEN}`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader() as unknown as {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
    };
    const buffer = { text: "" };
    await readUntil(reader, `event: ${DASHBOARD_EVENT_READY}`, buffer);
    expect(buffer.text).toContain("retry: 3000");
    expect(server.sseClientCount).toBe(1);

    server.broadcast(DASHBOARD_EVENT_TREE_CHANGED, { projectKey: P });
    await readUntil(reader, `event: ${DASHBOARD_EVENT_TREE_CHANGED}`, buffer);
    expect(buffer.text).toContain(`"projectKey":"${P}"`);

    controller.abort();
    // The abort lands asynchronously; stop() must still clear the client.
    await server.stop();
    expect(server.sseClientCount).toBe(0);
  });

  it("requires a token and releases the port on stop", async () => {
    expect(
      () =>
        new DashboardHttpServer({ store, token: "", port: 0 }),
    ).toThrow(/token/);

    await boot();
    const port = server.boundTcpPort;
    expect(port).toBeGreaterThan(0);
    await server.stop();
    expect(server.listening).toBe(false);

    // The same port is free again — no leak.
    const again = new DashboardHttpServer({
      store,
      token: TOKEN,
      port,
      version: VERSION,
      dashboardDir,
    });
    await again.start();
    expect(again.boundTcpPort).toBe(port);
    await again.stop();
  });
});

describe("wildcard-free bind", () => {
  it("binds loopback only and advertises a tokenised URL", async () => {
    await boot();
    expect(server.boundHost).toBe(DEFAULT_DASHBOARD_HOST);
    expect(server.url).toContain("/?token=");
    expect(decodeURIComponent(server.url!)).toContain(TOKEN);
    expect(DEFAULT_DASHBOARD_HOST).toBe("127.0.0.1");
  });
});

// ── helpers ──────────────────────────────────────────────────────────────

interface SseReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

async function readUntil(
  reader: SseReader,
  needle: string,
  buffer: { text: string },
  timeoutMs = 3000,
): Promise<void> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (!buffer.text.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`timed out waiting for "${needle}"; got: ${buffer.text}`);
    }
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for "${needle}"`)), remaining),
      ),
    ]);
    if (result.done) break;
    if (result.value) buffer.text += decoder.decode(result.value, { stream: true });
  }
}
