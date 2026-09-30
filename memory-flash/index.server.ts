import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { McpStdioServerConfig } from "@getpaseo/protocol/agent-types";
import { memoryFlashSettings } from "./shared/settings";
import {
  clearHistory,
  delegateTask,
  deleteMemory,
  deleteRemoteHost,
  getMemory,
  installSkill,
  listMemories,
  listRemoteHosts,
  listSkillTargets,
  listTags,
  memoryStats,
  purgeMemories,
  restoreRevision,
  saveMemory,
  saveRemoteHost,
  searchMemories,
  skillStatus,
  skillPreview,
  uninstallSkill,
  checkRemoteHost,
} from "./shared/memories";
import { MemoryStore } from "./server/store";
import { skillStatuses, skillMarkdown, installSkill as installSkillOnDisk, uninstallSkill as uninstallSkillOnDisk } from "./server/skill";
import {
  listRemoteHosts as loadHosts,
  saveRemoteHost as persistHost,
  deleteRemoteHost as removeHost,
  checkRemoteHost as probeHost,
} from "./server/remote-hosts";
import * as path from "node:path";
import * as process from "node:process";
import { statSync as fsStatSync } from "node:fs";

/**
 * Plugin server for Memory Flash.
 *
 * Responsibilities:
 * 1. Registers host-scoped settings and keeps the store's history cap in sync.
 * 2. Injects the memory MCP server into every Paseo-created agent via the
 *    `agent.create` before-hook (requirement 1 and 9 — the plugin runs with
 *    the Paseo server process and integrates with agent creation).
 * 3. Serves the plugin RPC surface for the Paseo UI (browse, search, edit,
 *    delete, history, stats, skill install, remote hosts, delegation).
 */

/**
 * Resolves the command that spawns the MCP server for an agent process.
 *
 * The MCP server is spawned by the agent process itself (OpenCode, Kilo,
 * Cline, ...), not by the plugin host. The plugin host binary is an Electron
 * binary run in node mode (ELECTRON_RUN_AS_NODE=1), but agents do not
 * necessarily inherit that variable — so prefer a real `node` binary and only
 * fall back to `process.execPath` when nothing better exists.
 */
function mcpServerCommand(): { command: string; args: string[] } {
  const entry = path.join(pluginDir(), "mcp-server.js");
  const command = resolveNodeCommand();
  return { command, args: [entry] };
}

function resolveNodeCommand(): string {
  // A plain node binary — the ideal case (plugin host run by node).
  if (path.basename(process.execPath) === "node" || path.basename(process.execPath) === "node.exe") {
    return process.execPath;
  }
  // Electron distributions sometimes sit next to a node binary.
  const sibling = path.join(path.dirname(process.execPath), "node");
  if (isExecutableFile(sibling)) return sibling;
  // Let the spawning agent resolve `node` from its own PATH. Every supported
  // coding agent runs on Node.js, so `node` is effectively always available.
  return "node";
}

function isExecutableFile(candidate: string): boolean {
  try {
    return fsStatSync(candidate).isFile();
  } catch {
    return false;
  }
}

function pluginDir(): string {
  if (typeof __dirname === "string") return __dirname;
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // Last resort: the daemon copies plugin directories under its home.
    return path.join(process.env["PASEO_HOME"] ?? path.join(os.homedir(), ".paseo"), "plugins", "memory-flash");
  }
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(memoryFlashSettings);

  const store = new MemoryStore();
  let disposed = false;

  // Keep the per-memory history cap in sync with settings.
  void settings.read().then((state) => {
    if (state.status === "ready") store.historyLimitPerMemory = state.values.historyPerMemory;
  });
  const unsubscribeSettings = settings.subscribe((state) => {
    if (state.status === "ready") store.historyLimitPerMemory = state.values.historyPerMemory;
  });

  // -------------------------------------------------------------------------
  // MCP injection (requirement: all agents share one memory through MCP)
  // -------------------------------------------------------------------------

  const removeCreateHook = server.before("agent.create", async ({ request }) => {
    // Async hooks are awaited by the host before the request proceeds, so the
    // mutation below is guaranteed to be applied to agent creation.
    const state = await settings.read().catch(() => null);
    if (state?.status !== "ready" || !state.values.injectIntoAgents) return request;
    const { command, args } = mcpServerCommand();
    const config: McpStdioServerConfig = {
      type: "stdio",
      command,
      args,
      alwaysLoad: true,
    };
    request.config.mcpServers = {
      ...(request.config.mcpServers ?? {}),
      "memory-flash": config,
    };
    return request;
  });

  // -------------------------------------------------------------------------
  // RPC surface
  // -------------------------------------------------------------------------

  server.handle(listMemories, (input) => {
    const { memories, total } = store.list({
      query: "",
      kinds: input.kinds,
      tags: input.tags,
      tagMode: input.tagMode,
      project: input.project,
      agentId: input.agentId,
      limit: input.limit,
      offset: input.offset,
    });
    return { memories, total };
  });

  server.handle(searchMemories, (input) => {
    const results = store.search(input);
    return { results };
  });

  server.handle(saveMemory, (input) => {
    try {
      if (input.id === undefined) {
        const memory = store.create(input.input, input.input.changedBy ?? "paseo-ui");
        return { ok: true, id: memory.id, error: null };
      }
      const memory = store.update(input.id, input.input, input.input.changedBy ?? "paseo-ui");
      return { ok: true, id: memory.id, error: null };
    } catch (cause) {
      return { ok: false, id: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  server.handle(deleteMemory, (input) => {
    try {
      const deleted = store.delete(input.id, "paseo-ui");
      return { ok: deleted, error: deleted ? null : `Memory ${input.id} not found.` };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  server.handle(getMemory, (input) => {
    return {
      memory: store.getById(input.id),
      history: store.historyOf(input.id),
    };
  });

  server.handle(restoreRevision, (input) => {
    try {
      const memory = store.restoreRevision(input.revisionId, "paseo-ui");
      return { ok: true, id: memory.id, error: null };
    } catch (cause) {
      return { ok: false, id: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  server.handle(memoryStats, () => store.stats());

  server.handle(listTags, () => ({ tags: store.allTags() }));

  server.handle(clearHistory, (input) => ({ removed: store.clearHistory(input.olderThan) }));

  server.handle(purgeMemories, (input) => {
    try {
      return { removed: store.purge({ tags: input.tags, project: input.project, kind: input.kind }) };
    } catch (cause) {
      // Purge with no filter is refused by the store; surface the reason.
      throw new Error(cause instanceof Error ? cause.message : String(cause));
    }
  });

  // --- Delegation: ask an agent to edit the database through its MCP tools --

  server.handle(delegateTask, async (input, { paseo }) => {
    try {
      const agents = await paseo.agents.list();
      const target = agents.entries.find(
        (entry) =>
          (entry as unknown as { id?: string }).id === input.agentId ||
          (entry as unknown as { agentId?: string }).agentId === input.agentId,
      );
      const open = (target as unknown as { archivedAt?: string | null } | undefined)?.archivedAt == null;
      if (!target) {
        return { ok: false, error: `Agent ${input.agentId} not found.` };
      }
      if (!open) {
        return { ok: false, error: `Agent ${input.agentId} is archived or closed.` };
      }
      const references =
        input.memoryIds.length > 0
          ? `\n\nMemory ids to consider: ${input.memoryIds.map((id) => `#${id}`).join(", ")}. Read each with memory_get before changing it.`
          : "";
      const prompt =
        "Memory Flash maintenance task — you have the memory-flash MCP tools.\n\n" +
        `${input.instruction}${references}\n\n` +
        "Work carefully: prefer memory_update over delete; when deleting several " +
        "memories, list them first (memory_search / memory_list_by_tag) and keep " +
        "the changes minimal. Report what you changed.";
      const agentId = (target as unknown as { id?: string }).id ?? input.agentId;
      await paseo.agents.ref(agentId).send(prompt);
      return { ok: true, error: null };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  // --- Skill management ------------------------------------------------------

  server.handle(listSkillTargets, () => {
    // `listSkillTargets` returns static targets; the status RPC adds install state.
    return { targets: skillStatuses().map(({ id, label, path, detected }) => ({ id, label, path, detected })) };
  });

  server.handle(skillStatus, () => ({ targets: skillStatuses() }));

  server.handle(skillPreview, () => ({ markdown: skillMarkdown() }));

  server.handle(installSkill, (input) => installSkillOnDisk(input.targetId));

  server.handle(uninstallSkill, (input) => {
    const result = uninstallSkillOnDisk(input.targetId);
    return { ok: result.ok, error: result.error };
  });

  // --- Remote hosts ----------------------------------------------------------

  server.handle(listRemoteHosts, () => ({ hosts: loadHosts() }));

  server.handle(saveRemoteHost, (input) => persistHost(input.host));

  server.handle(deleteRemoteHost, (input) => ({ ok: removeHost(input.id) }));

  server.handle(checkRemoteHost, (input) => probeHost(input.id));

  // ---------------------------------------------------------------------------

  return () => {
    disposed = true;
    void disposed;
    removeCreateHook();
    unsubscribeSettings();
    store.close();
  };
}
