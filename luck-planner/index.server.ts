import type { PluginRpcContract } from "@getpaseo/plugin";
import type {
  PluginHandlerContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import type {
  ZodType,
  input as ZodInput,
  output as ZodOutput,
} from "zod";
import {
  defaultSettings,
  luckPlannerSettings,
  normalizeSettings,
  type LuckPlannerSettings,
} from "./shared/settings";
import {
  UI_ACTOR,
  agentMcpRegister,
  agentMcpStatus,
  agentMcpUnregister,
  agentActivity,
  agentReload,
  bugReport,
  dashboardStatus,
  dbRestore,
  dbSnapshot,
  goalApprove,
  goalCreate,
  growthGet,
  nodeDetail,
  nodeSetStatus,
  stats,
  treeChanges,
  treeGet,
  treeSearch,
  type AgentMcpTargetId,
} from "./shared/rpc";
import {
  MCP_SERVER_KEY,
  injectedMcpConfig,
  isExecutableFile,
  publishedMcpEntry,
  resolveMcpEntry,
  sessionActorEnv,
} from "./server/mcp-launch";
import {
  AGENT_MCP_TARGETS,
  agentConfigCoversProvider,
  agentMcpStatuses,
  registerAgentMcp,
  unregisterAgentMcp,
} from "./server/agent-mcp-config";
import { readSavedMcpServers } from "./server/agent-record";
import {
  decideSessionOpen,
  needsCapabilityProbe,
} from "./server/session-open";
import { createUpsertLeafTool } from "./server/agent-tool";
import { probeOpenCodeService } from "./server/opencode-service";
import { snapshotDatabase } from "./server/snapshot";
import { readRestoreSource, replaceDatabase } from "./server/restore";
import { normalizeProjectKey, seedProjectTree } from "./server/project-seed";
import { ensureSkillInstalled } from "./server/skill";
import { ChangeFeed, readChangesSince } from "./server/change-feed";
import {
  notifyTimelineChange,
  timelineSink,
  type TimelinePaseo,
} from "./server/timeline";
import { LuckPlannerStore } from "./server/store";
import { DashboardEndpoint } from "./server/http-lifecycle";
import { growthProgress } from "./shared/growth";

/**
 * Server entry (daemon subprocess runtime).
 *
 * Contributions by stage (PLAN.md):
 * - D2 (done): publish the stdio MCP bundle at its revision-independent path
 * - D3 (done): inject the MCP server into created agents
 *   (`agent.create.before`), stamp the per-agent audit actor onto the
 *   session env (`agent.open.before`), auto-install the skill into
 *   existing skills directories, host-scoped settings (`injectIntoAgents`,
 *   `mcpServerName`)
 * - E1 (done): plugin RPC handlers (`shared/rpc.ts`) over one shared store
 * - E3 (done): goal-create + bug-report RPCs behind the ⌘K items and slash
 *   commands
 * - E4 (done): settings screen + history retention enforcement
 * - F1 (done): read-only dashboard HTTP server (`/health`, `/api/*`, SSE
 *   placeholder) on loopback, kept in step with `httpEnabled`/`httpPort`/
 *   `accessToken`
 * - F2 (done): `dashboard-status` RPC — where the client should open the
 *   dashboard (live URL with token + project)
 * - H1 (done): live data — the endpoint's change feed broadcasts
 *   `tree-changed` over SSE, and `tree-changes` is the polling twin the
 *   native panel uses
 * - H2 (done): agent timeline rows — a second change feed turns two audit
 *   facts (goal approved, leaf done) into `timeline.append` calls on the
 *   responsible agent's timeline (`server/timeline.ts`)
 */
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(luckPlannerSettings);

  // `let`, not `const`: stage L4 replaces the database file under the daemon
  // and reopens the store (`db-restore`), so every closure below reads the
  // current handle. The two long-lived consumers that capture it — the
  // dashboard endpoint and the timeline feed — are rebuilt on that path too.
  let store = new LuckPlannerStore();
  /** Directory of the database; the store handle is swapped by a restore. */
  const dbPath = store.dbPath;
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
  let dashboard = new DashboardEndpoint({
    store,
    log: (message) => console.log(message),
    logError: (message) => console.error(message),
  });

  /** Applies every settings-dependent side effect in one place. */
  const applySettings = (values: LuckPlannerSettings): void => {
    applyRetention(values);
    // The MCP entry is refreshed here as well, and this is the *first* moment
    // it can be: the daemon finalises an install (and rewrites its config
    // with the new revision's path) right after the plugin is ready — so the
    // publication at load time may still have copied the bundle of the
    // revision the update replaced. The copy is cheap and the agents that
    // already hold the entry path re-spawn from it on every turn, so it must
    // carry the running code (stage J2, live daemon).
    const entry = resolveMcpEntry();
    console.log(
      `[luck-planner] MCP entry refreshed: ${entry} ` +
        `(${isExecutableFile(entry) ? "exists" : "MISSING"})`,
    );
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
  // Agent timeline rows (stage H2). Two feeds over one audit table, on
  // purpose: the dashboard's feed (stage H1) is armed only while a socket
  // listens and deliberately skips rows written while it slept, because a
  // tab refetches everything on connect — a timeline row has to appear with
  // HTTP switched off and without that refetch. Independent watermarks are
  // what make both true; the cost is one more indexed `SELECT` per second.
  //
  // The SDK handle is not available at contribute time: hooks and RPC
  // handlers receive it in their context, so the first context to arrive
  // hands it over and the feed appends through it (`server/timeline.ts`).
  // -------------------------------------------------------------------------
  let paseoHandle: TimelinePaseo | null = null;
  const rememberPaseo = (
    candidate: TimelinePaseo | null | undefined,
  ): void => {
    if (candidate && paseoHandle === null) paseoHandle = candidate;
  };

  /**
   * Builds the timeline feed over the current store. A factory rather than a
   * literal because a restore swaps the store and the old feed would keep
   * polling a closed handle.
   */
  const openTimelineFeed = (): ChangeFeed => {
    const feed = new ChangeFeed({
      store,
      onChange: (change) => {
        void notifyTimelineChange(change, {
          store,
          // Resolved per batch: the handle may only arrive mid-run.
          sink: paseoHandle === null ? null : timelineSink(paseoHandle),
          log: (message) => console.log(message),
          logError: (message) => console.error(`[luck-planner] ${message}`),
        }).catch((cause) => {
          console.error(
            `[luck-planner] timeline notify failed: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        });
      },
      onError: (message) => console.error(`[luck-planner] ${message}`),
    });
    feed.start();
    return feed;
  };
  let timelineFeed = openTimelineFeed();

  // -------------------------------------------------------------------------
  // MCP injection (ADR-3): every Paseo-created agent gets the bundled stdio
  // server. Request hooks are awaited by the host before the request
  // proceeds, so the mutation below is applied to agent creation. Registered
  // through `server.addHook` — since 0.15.0 the `server.before` spelling is
  // `@deprecated` (removal after 2027-04-30) and `agent.create` is now
  // `agent.create.before`.
  // -------------------------------------------------------------------------

  const removeCreateHook = server.addHook(
    "agent.create.before",
    async ({ request }, context) => {
      rememberPaseo(context.paseo);
      const values = await readValues();
      if (!values.injectIntoAgents) {
        console.log(
          `[luck-planner] agent.create injection disabled by settings`,
        );
        return request;
      }
      // Stage D4: when the agent's own config file already carries a current
      // registration, the session-level entry is *not* injected. The config
      // entry survives OpenCode's per-directory eviction, reconnects at every
      // location boot and is the only thing the terminal agents (Cline,
      // Cursor, Qwen Code, Codex CLI) read at all — while a session entry that died with
      // an eviction would still own the server's name and shadow the healthy
      // config one, breaking every call. The injection stays the fallback for
      // machines whose config file was never (or can no longer) be written.
      const cover = agentConfigCoversProvider(request.config.provider);
      if (cover.covered) {
        console.log(
          `[luck-planner] agent.create injection skipped for ${request.config.provider}: ` +
            `config-file registration active at ${cover.path ?? "(unknown)"}`,
        );
        return request;
      }
      // 0.40.8 (§10.11 item 1): 0.15.0 lets the `opencode` provider reuse a
      // running v2 service, and an agent whose config carries custom MCP
      // servers is then *rejected* by the host — creation fails before the
      // first turn. The session-open hook attaches the native
      // `luck_tree_upsert_leaf` tool instead, so the tree stays writable.
      const service = probeOpenCodeService({ provider: request.config.provider });
      if (service.shared) {
        console.log(
          `[luck-planner] agent.create injection skipped for ${request.config.provider}: ${service.why} — ` +
            `the host rejects custom MCP servers on a shared OpenCode service; ` +
            `the native luck_tree_upsert_leaf tool is attached when the session opens`,
        );
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
    },
  );

  // -------------------------------------------------------------------------
  // Audit actor + MCP re-derivation (stage D3 + 0.35.1, §10.8 items 1/2):
  // the MCP server is stamped onto the session env so the spawned server
  // identifies the agent (the create request predates the agent record), and
  // since 0.35.1 the hook also re-derives the *launch-only* MCP contribution
  // on every open — the path that reaches agents created before
  // `injectIntoAgents` was on and survives OpenCode/Kilo's per-directory
  // eviction — falling back to the native `luck_tree_upsert_leaf` tool for
  // providers without MCP support. The hook is `agent.open.before` on
  // 0.15.0 (registered through `server.addHook`; the deprecated spelling is
  // `server.before("agent.session_open")`). The decision is pure
  // (server/session-open.ts);
  // a collision with the agent's saved configuration aborts the open, so the
  // saved set is read from the daemon's agent record and every unknown state
  // fails safe to *skip the MCP map* (the native tool cannot collide).
  // -------------------------------------------------------------------------

  const upsertLeafTool = createUpsertLeafTool(store);

  const removeSessionHook = server.addHook(
    "agent.open.before",
    async ({ request }, context) => {
      rememberPaseo(context.paseo);
      const values = await readValues();
      // Host-level gate (0.40.8, §10.11 item 1): decided before the daemon is
      // asked anything, because no capability answer can make a shared
      // OpenCode service accept custom MCP servers.
      const service = probeOpenCodeService({ provider: request.provider });
      // The audit actor rides the **session environment**, and 0.15.0 rejects a
      // shared-service agent for a custom environment exactly as it does for a
      // custom MCP server ("Custom OpenCode MCP servers or process environment
      // …"). The stamp exists only for the spawned MCP server, so with no MCP
      // contribution there is nothing to stamp — the native tool reads the
      // actor from `context.agent.id` instead.
      let env = request.env;
      if (values.injectIntoAgents && !service.shared) {
        env = { ...env, ...sessionActorEnv(request.agentId) };
      }

      const cover = agentConfigCoversProvider(request.provider);
      const base = {
        reason: request.reason,
        purpose: request.purpose,
        injectIntoAgents: values.injectIntoAgents,
        serverName: MCP_SERVER_KEY,
        configCovered: cover.covered,
        lookup: readSavedMcpServers(request.agentId),
        supportsMcpServers: null as boolean | null,
        sharedOpenCodeService: { shared: service.shared, why: service.why },
      };

      // The daemon is only consulted when an MCP contribution is still
      // possible; every other branch (gated off, history, create owned by the
      // create hook, config-file cover, server already saved) is decided
      // without touching it.
      let supportsMcpServers: boolean | null = null;
      if (needsCapabilityProbe({ ...base, supportsMcpServers: null })) {
        const snapshot = await context.paseo.agents
          .ref(request.agentId)
          .refresh()
          .catch(() => null);
        supportsMcpServers =
          snapshot?.agent?.capabilities?.supportsMcpServers ?? null;
      }

      const decision = decideSessionOpen({ ...base, supportsMcpServers });
      console.log(
        `[luck-planner] session_open ${request.agentId} (${request.reason}/${request.purpose}): ${decision.why}`,
      );

      if (!decision.injectMcp && !decision.attachTool) {
        return { ...request, env };
      }

      const tools = decision.attachTool
        ? [...request.tools, upsertLeafTool]
        : request.tools;
      let mcpServers = request.mcpServers;
      if (decision.injectMcp) {
        const config = injectedMcpConfig({ serverName: values.mcpServerName });
        mcpServers = { ...request.mcpServers, [MCP_SERVER_KEY]: config };
        console.log(
          `[luck-planner] session_open MCP injected: ${config.command} ${config.args.join(" ")}`,
        );
      } else {
        console.log(
          `[luck-planner] session_open native upsert tool attached: ${decision.why}`,
        );
      }
      return { ...request, env, tools, mcpServers };
    },
  );

  // -------------------------------------------------------------------------
  // Project seeding (0.40.8, §10.11 items 2/3): the store scopes every row by
  // `projectKey` = the workspace's `projectRootPath`, and nothing exists for a
  // project until its first write. 0.15.0 exposes the hooks that close the gap:
  // `worktree.create.after` (awaited before workspace setup and agents start)
  // and the two `*.after` events. Seeding is the store's own skeleton
  // (`ensureSkeletonBranch`), guarded by an emptiness check — so a project
  // bootstrapped by an agent and one seeded here are indistinguishable, and a
  // hook can never throw into an agent creation.
  //
  // `worktree.create.after` answers with `{ path, branch, sourceCheckout }` and
  // is the only hook that needs no daemon round trip: the path *is* the key of
  // the workspace that will exist there. The two event hooks carry ids only, so
  // they resolve `projectRootPath` through the SDK and seed nothing when the
  // workspace cannot be read — guessing a key the panel never reads would only
  // create invisible trees.
  // -------------------------------------------------------------------------

  const removeWorktreeSeedHook = server.addHook(
    "worktree.create.after",
    async ({ worktree }) => {
      if (disposed) return;
      const seeded = seedProjectTree(store, { projectKey: worktree.path });
      if (seeded.created) {
        console.log(
          `[luck-planner] worktree.create.after ${worktree.branch}: ${seeded.why}`,
        );
      }
    },
  );

  const removeWorkspaceSeedHook = server.addHook(
    "workspace.create.after",
    async ({ workspace }, context) => {
      if (disposed) return;
      const snapshot = await context.paseo.workspaces
        .ref(workspace.id)
        .refresh()
        .catch(() => null);
      const projectKey = normalizeProjectKey(
        snapshot?.projectRootPath ?? workspace.cwd,
      );
      if (projectKey === null) return;
      const seeded = seedProjectTree(store, { projectKey });
      if (seeded.created) {
        console.log(
          `[luck-planner] workspace.create.after ${workspace.id}: ${seeded.why}`,
        );
      }
    },
  );

  // An agent created in a workspace that predates this release (or the
  // plugin) is the case the event hooks exist for: `workspace.create.after`
  // never fires for it, so the first creation there is what makes the project
  // visible in the dashboard and the panel.
  const removeAgentSeedHook = server.addHook(
    "agent.create.after",
    async ({ agent }, context) => {
      if (disposed || agent.workspaceId === null) return;
      const snapshot = await context.paseo.workspaces
        .ref(agent.workspaceId)
        .refresh()
        .catch(() => null);
      const projectKey = normalizeProjectKey(snapshot?.projectRootPath ?? null);
      if (projectKey === null) return;
      const seeded = seedProjectTree(store, { projectKey });
      if (seeded.created) {
        console.log(
          `[luck-planner] agent.create.after ${agent.id}: ${seeded.why}`,
        );
      }
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
  //
  // Registration goes through `handle` rather than `server.handle`: the
  // handler context carries the same SDK handle the hooks carry, so a panel
  // that never opened an agent session still gives the timeline feed its
  // `paseo` (stage H2).
  // -------------------------------------------------------------------------
  const handle = <InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
  ): void => {
    server.handle(contract, (input, context) => {
      rememberPaseo(context.paseo);
      return handler(input, context);
    });
  };

  handle(treeGet, (input) => {
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

  handle(treeSearch, (input) => {
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

  handle(nodeDetail, (input) => {
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

  // -------------------------------------------------------------------------
  // Agent config registrations (stage D4): the plugin can register its MCP
  // server in the agents' *own* config files — the only registration that
  // survives OpenCode's per-directory eviction and the only one the terminal
  // agents (Cline, Cursor, Qwen Code, Codex CLI) read at all. The files belong to the
  // user, so nothing is written without an explicit request from the settings
  // screen; every other key, server, table and comment is preserved, and a
  // file that does not parse is reported instead of overwritten.
  // -------------------------------------------------------------------------
  handle(agentMcpStatus, () => ({ targets: agentMcpStatuses() }));

  handle(agentMcpRegister, (input) => {
    const targets: AgentMcpTargetId[] =
      input.target === "all" ? [...AGENT_MCP_TARGETS] : [input.target];
    const results = targets.map((id) => {
      const outcome = registerAgentMcp(id);
      const status = agentMcpStatuses().find((candidate) => candidate.id === id);
      console.log(
        `[luck-planner] agent MCP registered: ${status?.label ?? id} ` +
          `(${outcome.ok ? "ok" : outcome.error})`,
      );
      return { id, label: status?.label ?? id, ok: outcome.ok, error: outcome.error };
    });
    const failed = results.filter((result) => !result.ok);
    return {
      ok: failed.length === 0,
      error:
        failed.length === 0
          ? null
          : failed.map((result) => `${result.label}: ${result.error}`).join("; "),
      results,
    };
  });

  handle(agentMcpUnregister, (input) => {
    const targets: AgentMcpTargetId[] =
      input.target === "all" ? [...AGENT_MCP_TARGETS] : [input.target];
    const results = targets.map((id) => {
      const outcome = unregisterAgentMcp(id);
      const status = agentMcpStatuses().find((candidate) => candidate.id === id);
      console.log(
        `[luck-planner] agent MCP unregistered: ${status?.label ?? id} ` +
          `(${outcome.ok ? "ok" : outcome.error})`,
      );
      return { id, label: status?.label ?? id, ok: outcome.ok, error: outcome.error };
    });
    const failed = results.filter((result) => !result.ok);
    return {
      ok: failed.length === 0,
      error:
        failed.length === 0
          ? null
          : failed.map((result) => `${result.label}: ${result.error}`).join("; "),
      results,
    };
  });

  // 0.35.1 (§10.8 item 3): "Refresh luck-planner tools on this agent" — the
  // supported answer to an agent that lost its tools: `reload()` reopens the
  // provider session with its current configuration and reruns
  // `agent.open.before`, which re-derives the MCP contribution or attaches
  // the native fallback. A refused reload surfaces as `{ ok: false, error }`,
  // which the Command Center item throws into the host's error toast.
  handle(agentReload, async (input, context) => {
    try {
      const client = context.paseo;
      if (!client) {
        return {
          ok: false,
          error: "Paseo host client is unavailable.",
        };
      }
      const result = await client.agents.ref(input.agentId).reload();
      if (result === null) {
        return { ok: false, error: `Agent ${input.agentId} not found or not reloadable.` };
      }
      console.log(
        `[luck-planner] reloaded agent ${input.agentId} (luck-planner tools re-derived)`,
      );
      return { ok: true, error: null };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[luck-planner] agent reload failed: ${message}`);
      return { ok: false, error: message };
    }
  });

  handle(nodeSetStatus, (input) => {
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

  handle(goalApprove, (input) => {
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

  handle(goalCreate, (input) => {
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

  handle(bugReport, (input) => {
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

  handle(growthGet, (input) => {
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

  handle(stats, (input) => {
    throwIfDisposed();
    return store.stats(input.projectKey);
  });

  // 0.40.8 (§10.11 item 4): the agent panel's read. Audit rows are already
  // stamped with their actor, so this is the existing trail sliced by it; the
  // node resolution happens here, once per row, instead of in the panel.
  handle(agentActivity, (input) => {
    throwIfDisposed();
    const entries = store
      .listActorActivity(input.projectKey, input.agentId, input.limit)
      .map((entry) => ({
        entry,
        node:
          entry.entityType === "node"
            ? store.getNode(input.projectKey, entry.entityId)
            : null,
      }));
    return { agentId: input.agentId, entries };
  });

  // Stage F2: the panel button and the ⌘K "Open dashboard" action ask where the
  // dashboard is. The answer comes from the live endpoint (bound port + active
  // token), not from the settings — a busy port may have fallen back and the
  // token is auto-generated when the setting is empty. Read-only.
  handle(dashboardStatus, (input) => {
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

  // Stage H1: the native panel polls this while it is mounted (the SDK has no
  // server→client push). `sinceId` absent = "just tell me the cursor", which is
  // what a freshly opened panel calls so it never replays the whole trail; the
  // rows are filtered to the caller's project (ADR-2) even though the cursor is
  // global. The watermark comes from the shared audit table, so writes made by
  // agent processes are visible here too.
  handle(treeChanges, (input) => {
    throwIfDisposed();
    if (input.sinceId === undefined) {
      return { watermark: store.latestHistoryId(), changes: [] };
    }
    const batch = readChangesSince(store, input.sinceId);
    return {
      watermark: batch.watermark,
      changes: batch.changes.filter((entry) => entry.projectKey === input.projectKey),
    };
  });

  // Stage L3: the settings button asks for one snapshot of the whole database.
  // On an explicit request only — a timer would turn "a backup" into "a
  // directory of backups nobody reads", and the criteria for automatic
  // archiving are a separate stage (L11). `VACUUM INTO` + integrity check live
  // in `server/snapshot.ts`; this handler only turns a failure into the
  // `{ ok: false, error }` shape the settings screen renders, so one bad
  // filesystem never takes the settings screen down.
  handle(dbSnapshot, () => {
    throwIfDisposed();
    try {
      const result = snapshotDatabase(store);
      console.log(
        `[luck-planner] database snapshot: ${result.file} ` +
          `(${result.bytes} bytes, ${result.counts.nodes} nodes, ` +
          `${result.counts.projects} projects)`,
      );
      return {
        ok: true,
        error: null,
        file: result.file,
        bytes: result.bytes,
        dbBytes: result.dbBytes,
        schemaVersion: result.schemaVersion,
        counts: result.counts,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[luck-planner] database snapshot failed: ${message}`);
      return {
        ok: false,
        error: message,
        file: null,
        bytes: 0,
        dbBytes: 0,
        schemaVersion: 0,
        counts: null,
      };
    }
  });

  // Stage L4: put a snapshot back. The destructive half of the backup pair,
  // so it is one RPC with a readable failure for every step, and the order is
  // the safety: verify the file, snapshot what is there now, close the store,
  // swap, reopen, and only then rebuild the consumers that captured the old
  // handle. A reopen failure rolls the previous file back (see
  // `server/restore.ts`), which is why this can be offered without a
  // "point of no return" dialog — the automatic `pre-restore` snapshot is the
  // second net, and it survives even a successful restore.
  handle(dbRestore, async (input) => {
    throwIfDisposed();
    const reload = await readValues();
    let source: ReturnType<typeof readRestoreSource> | null = null;
    let backupFile: string | null = null;
    let backupError: string | null = null;
    try {
      source = readRestoreSource(input.file, dbPath);

      // Auto-snapshot *before* anything is touched. It is best-effort on
      // purpose: the classic reason to restore is a database that no longer
      // reads, and refusing the recovery because the courtesy copy failed
      // would lock the user out of their own backup. The failure is reported.
      try {
        const backup = snapshotDatabase(store, { label: "pre-restore" });
        backupFile = backup.file;
        console.log(
          `[luck-planner] pre-restore snapshot: ${backup.file} (${backup.bytes} bytes)`,
        );
      } catch (cause) {
        backupError = cause instanceof Error ? cause.message : String(cause);
        console.error(`[luck-planner] pre-restore snapshot failed: ${backupError}`);
      }

      // Everything that captured the old handle goes down before the file
      // changes: the feed would otherwise poll a closed database, and the
      // HTTP socket would serve a stale one.
      timelineFeed.stop();
      await dashboard.dispose();
      store.close();

      replaceDatabase(dbPath, source, () => {
        store = new LuckPlannerStore({ dbPath });
      });

      dashboard = new DashboardEndpoint({
        store,
        log: (message) => console.log(message),
        logError: (message) => console.error(message),
      });
      timelineFeed = openTimelineFeed();
      applySettings(reload);

      const outcome = {
        ok: true,
        error: null,
        file: dbPath,
        backup: backupFile,
        backupError,
        schemaVersion: source.schemaVersion,
        counts: source.counts,
      };
      console.log(
        `[luck-planner] database restored from ${source.origin} ` +
          `(${source.counts.nodes} nodes in ${source.counts.projects} projects)`,
      );
      return outcome;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[luck-planner] database restore failed: ${message}`);
      return {
        ok: false,
        error: message,
        file: null,
        backup: backupFile,
        backupError,
        schemaVersion: 0,
        counts: null,
      };
    } finally {
      source?.cleanup();
    }
  });

  function throwIfDisposed(): void {
    if (disposed) throw new Error("luck-planner store is closed");
  }

  return async () => {
    disposed = true;
    removeCreateHook();
    removeSessionHook();
    removeWorktreeSeedHook();
    removeWorkspaceSeedHook();
    removeAgentSeedHook();
    unsubscribeSettings();
    // The timeline feed reads the audit table: gone before the store it
    // reads is closed, so a reload never polls a dead handle.
    timelineFeed.stop();
    // Awaited (unlike the fire-and-forget syncs above) so the listening
    // socket is really gone before the store it serves is closed: a leaked
    // port would break the next plugin load on the same setting.
    await dashboard.dispose();
    store.close();
  };
}
