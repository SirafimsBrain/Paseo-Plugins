import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  defaultSettings,
  luckPlannerSettings,
  type LuckPlannerSettings,
} from "./shared/settings";
import {
  MCP_SERVER_KEY,
  injectedMcpConfig,
  isExecutableFile,
  publishedMcpEntry,
  resolveMcpEntry,
  sessionActorEnv,
} from "./server/mcp-launch";
import { ensureSkillInstalled } from "./server/skill";

/**
 * Server entry (daemon subprocess runtime).
 *
 * Contributions by stage (PLAN.md):
 * - D2 (done): publish the stdio MCP bundle at its revision-independent path
 * - D3 (done): inject the MCP server into created agents (`agent.create`),
 *   stamp the per-agent audit actor onto the session env
 *   (`agent.session_open`), auto-install the skill into existing skills
 *   directories, host-scoped settings (`injectIntoAgents`, `mcpServerName`)
 * - E1: plugin RPC handlers
 * - F1: dashboard HTTP server
 */
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(luckPlannerSettings);

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
    return state?.status === "ready" ? state.values : defaultSettings();
  };

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

  return () => {
    removeCreateHook();
    removeSessionHook();
  };
}
