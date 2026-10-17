import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  defaultSettings,
  luckPlannerSettings,
  normalizeSettings,
  type LuckPlannerSettings,
} from "./shared/settings";
import {
  UI_ACTOR,
  bugReport,
  dashboardStatus,
  goalApprove,
  goalCreate,
  growthGet,
  nodeDetail,
  nodeSetStatus,
  stats,
  treeGet,
  treeSearch,
} from "./shared/rpc";
import {
  MCP_SERVER_KEY,
  injectedMcpConfig,
  isExecutableFile,
  publishedMcpEntry,
  resolveMcpEntry,
  sessionActorEnv,
} from "./server/mcp-launch";
import { ensureSkillInstalled } from "./server/skill";
import { LuckPlannerStore } from "./server/store";
import { DashboardEndpoint } from "./server/http-lifecycle";
import { growthProgress } from "./shared/growth";

/**
 * Server entry (daemon subprocess runtime).
 *
 * Contributions by stage (PLAN.md):
 * - D2 (done): publish the stdio MCP bundle at its revision-independent path
 * - D3 (done): inject the MCP server into created agents (`agent.create`),
 *   stamp the per-agent audit actor onto the session env
 *   (`agent.session_open`), auto-install the skill into existing skills
 *   directories, host-scoped settings (`injectIntoAgents`, `mcpServerName`)
 * - E1 (done): plugin RPC handlers (`shared/rpc.ts`) over one shared store
 * - E3 (done): goal-create + bug-report RPCs behind the ⌘K items and slash
 *   commands
 * - E4 (done): settings screen + history retention enforcement
 * - F1 (done): read-only dashboard HTTP server (`/health`, `/api/*`, SSE
 *   placeholder) on loopback, kept in step with `httpEnabled`/`httpPort`/
 *   `accessToken`
 * - F2 (done): `dashboard-status` RPC — where the client should open the
 *   dashboard (live URL with token + project)
 */
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(luckPlannerSettings);

  const store = new LuckPlannerStore();
  let disposed = false;

  // Publish the bundle at its revision-independent path on every plugin
  // load, not only when an agent is created: agents created before an
  // update hold that path in their config and re-spawn from it on every
  // turn, so it has to be current before the first turn of the day. This is
  // the memory-flash 0.7.1 lesson — see `server/mcp-launch.ts`.
  const entry = resolveMcpEntry();
  console.log(
    `[luck-planner] MCP entry: ${entry} (${isExecutableFile(entry) ? "exists" : "MISSING"})`,
  );

  // Skill install (stage D3): into skills directories that already exist,
  // only when the content differs — see `ensureSkillInstalled`. One log
  // line per written path makes the install verifiable in
  // `paseo plugin logs luck-planner`.
  const writtenSkills = ensureSkillInstalled();
  if (writtenSkills.length > 0) {
    for (const file of writtenSkills) {
      console.log(`[luck-planner] skill installed: ${file}`);
    }
  } else {
    console.log(`[luck-planner] skill up to date`);
  }

  /** Settings values for the hooks; schema defaults when not ready yet. */
  const readValues = async (): Promise<LuckPlannerSettings> => {
    const state = await settings.read().catch(() => null);
    // `normalizeSettings` fills defaults for fields added after a settings
    // doc was written, so an old doc upgrades without a daemon restart.
    return state?.status === "ready"
      ? normalizeSettings(state.values)
      : defaultSettings();
  };

  // History retention (stage E4): prune once at load and again on every
  // settings change, so lowering the retention takes effect without a
  // daemon restart (only a plugin reload). `0` disables pruning — the
  // append-only trail is kept forever.
  const applyRetention = (values: LuckPlannerSettings): void => {
    try {
      const removed = store.pruneHistory(values.historyRetentionDays);
      if (removed > 0) {
        console.log(
          `[luck-planner] history retention: pruned ${removed} row(s) older than ${values.historyRetentionDays} day(s)`,
        );
      }
    } catch (cause) {
      console.error(
        `[luck-planner] history retention prune failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  };

  // -------------------------------------------------------------------------
  // Dashboard HTTP server (stage F1, ADR-1/ADR-9): a read-only JSON API and
  // the SPA host for the 2D/3D dashboards, bound to loopback only. The
  // endpoint owns the socket and serialises restarts, so a port typed one
  // digit at a time causes one apply, not four (see the class docs).
  // -------------------------------------------------------------------------
  const dashboard = new DashboardEndpoint({
    store,
    log: (message) => console.log(message),
    logError: (message) => console.error(message),
  });

  /** Applies every settings-dependent side effect in one place. */
  const applySettings = (values: LuckPlannerSettings): void => {
    applyRetention(values);
    dashboard.sync({
      enabled: values.httpEnabled,
      port: values.httpPort,
      accessToken: values.accessToken,
    });
  };
  void readValues().then(applySettings);
  const unsubscribeSettings = settings.subscribe((state) => {
    if (state.status === "ready") applySettings(normalizeSettings(state.values));
  });

  // -------------------------------------------------------------------------
  // MCP injection (ADR-3): every Paseo-created agent gets the bundled stdio
  // server. Async `before` hooks are awaited by the host before the request
  // proceeds, so the mutation below is applied to agent creation.
  // -------------------------------------------------------------------------

  const removeCreateHook = server.before("agent.create", async ({ request }) => {
    const values = await readValues();
    if (!values.injectIntoAgents) {
      console.log(`[luck-planner] agent.create injection disabled by settings`);
      return request;
    }
    const config = injectedMcpConfig({ serverName: values.mcpServerName });
    request.config.mcpServers = {
      ...(request.config.mcpServers ?? {}),
      [MCP_SERVER_KEY]: config,
    };
    // Diagnostic: visible in `paseo plugin logs luck-planner` — helps to
    // troubleshoot MCP spawn failures on the agent side.
    const entryPath = config.args[0] ?? "";
    console.log(
      `[luck-planner] MCP injected: ${config.command} ${config.args.join(" ")} ` +
        `(${isExecutableFile(entryPath) ? "entry exists" : "entry MISSING"}; ` +
        `stable path ${publishedMcpEntry()})`,
    );
    return request;
  });

  // -------------------------------------------------------------------------
  // Audit actor: the MCP server stamps writes with LUCK_PLANNER_AGENT_ID.
  // The id exists only at session open (the create request predates the
  // agent record), and the daemon spawns stdio servers with
  // `env: { ...sessionEnv, ...config.env }` — so the session env is where
  // the id has to travel.
  // -------------------------------------------------------------------------

  const removeSessionHook = server.before(
    "agent.session_open",
    async ({ request }) => {
      const values = await readValues();
      if (!values.injectIntoAgents) return request;
      request.env = { ...request.env, ...sessionActorEnv(request.agentId) };
      return request;
    },
  );

  // -------------------------------------------------------------------------
  // Plugin RPC surface (stage E1): the native panel, Command Center items
  // and the settings screen all read and approve through these handlers.
  // The store scopes every call by `projectKey` (ADR-2); writes stamp
  // `actor ?? "user"` into the audit trail so panel approvals are
  // attributable. Read handlers return store rows directly; write handlers
  // answer `{ ok, …, error }` instead of throwing, mirroring the MCP
  // dispatch discipline (one bad call never takes the server down).
  // -------------------------------------------------------------------------

  server.handle(treeGet, (input) => {
    throwIfDisposed();
    const roots = store.listChildren(input.projectKey, null);
    return {
      projectKey: input.projectKey,
      roots: roots.map((node) => ({
        node,
        children: store.listChildren(input.projectKey, node.id),
      })),
    };
  });

  server.handle(treeSearch, (input) => {
    throwIfDisposed();
    const hits = store.search(input.query, {
      projectKey: input.projectKey,
      kinds: input.kinds,
      statuses: input.statuses,
      includeArchived: input.includeArchived,
      limit: input.limit,
    });
    return {
      matches: hits.length,
      results: hits.map((hit) => ({
        node: hit.node,
        score: hit.score,
        snippet: hit.snippet,
      })),
    };
  });

  server.handle(nodeDetail, (input) => {
    throwIfDisposed();
    const node = store.getNode(input.projectKey, input.nodeId);
    if (!node) {
      throw new Error(
        `node ${input.nodeId} not found in project ${input.projectKey}`,
      );
    }
    return {
      node,
      path: store.getNodePath(input.projectKey, node.id),
      children: store.listChildren(input.projectKey, node.id),
      bees: store.listBeesForNode(input.projectKey, node.id),
      bugs: store.listBugsForNode(input.projectKey, node.id),
      blockingBugs: store.listBlockingBugs(input.projectKey, node.id),
      history: store.listHistory(input.projectKey, node.id),
      growth: store.getGrowthForSubject(input.projectKey, "node", node.id),
    };
  });

  server.handle(nodeSetStatus, (input) => {
    try {
      throwIfDisposed();
      const node = store.setStatus({
        projectKey: input.projectKey,
        id: input.nodeId,
        status: input.status,
        actor: input.actor ?? UI_ACTOR,
      });
      return { ok: true, node, error: null };
    } catch (cause) {
      return {
        ok: false,
        node: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });

  server.handle(goalApprove, (input) => {
    try {
      throwIfDisposed();
      const goal = store.approveGoal({
        projectKey: input.projectKey,
        id: input.goalId,
        parentBranchId: input.parentBranchId,
        actor: input.actor ?? UI_ACTOR,
      });
      return { ok: true, goal, error: null };
    } catch (cause) {
      return {
        ok: false,
        goal: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });

  server.handle(goalCreate, (input) => {
    try {
      throwIfDisposed();
      const goal = store.createGoal({
        projectKey: input.projectKey,
        formalText: input.formalText,
        plan: input.plan,
        actor: input.actor ?? UI_ACTOR,
      });
      return { ok: true, goal, error: null };
    } catch (cause) {
      return {
        ok: false,
        goal: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });

  server.handle(bugReport, (input) => {
    try {
      throwIfDisposed();
      const bug = store.createBug({
        projectKey: input.projectKey,
        title: input.title,
        description: input.description,
        // The contract defaults this to "medium" at the SDK boundary; the
        // handler keeps its own fallback so a raw call cannot reach the
        // store with an undefined severity (same pattern as `actor`).
        severity: input.severity ?? "medium",
        nodeIds: input.nodeIds,
        actor: input.actor ?? UI_ACTOR,
      });
      return { ok: true, bug, error: null };
    } catch (cause) {
      return {
        ok: false,
        bug: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });

  server.handle(growthGet, (input) => {
    throwIfDisposed();
    const growth = store.getGrowthForSubject(
      input.projectKey,
      input.subjectType,
      input.subjectId,
    );
    if (!growth) {
      return { growth: null, total: 0, completed: 0, failed: 0, ratio: 0 };
    }
    const aggregate = growthProgress(growth.steps);
    return { growth, ...aggregate };
  });

  server.handle(stats, (input) => {
    throwIfDisposed();
    return store.stats(input.projectKey);
  });

  // Stage F2: the panel button and the ⌘K "Open dashboard" action ask where the
  // dashboard is. The answer comes from the live endpoint (bound port + active
  // token), not from the settings — a busy port may have fallen back and the
  // token is auto-generated when the setting is empty. Read-only.
  server.handle(dashboardStatus, (input) => {
    throwIfDisposed();
    const status = dashboard.status();
    return {
      enabled: status.enabled,
      listening: status.listening,
      url: dashboard.projectUrl(input.projectKey),
      port: status.boundPort,
      portFallback: status.portFallback,
      error: status.error,
    };
  });

  function throwIfDisposed(): void {
    if (disposed) throw new Error("luck-planner store is closed");
  }

  return async () => {
    disposed = true;
    removeCreateHook();
    removeSessionHook();
    unsubscribeSettings();
    // Awaited (unlike the fire-and-forget syncs above) so the listening
    // socket is really gone before the store it serves is closed: a leaked
    // port would break the next plugin load on the same setting.
    await dashboard.dispose();
    store.close();
  };
}
