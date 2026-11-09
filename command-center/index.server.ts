import type { PluginServerContext } from "@getpaseo/plugin/server";
import { commandCenterSettings } from "./shared/settings";
import {
  agentReload,
  appendHistory,
  clearHistory,
  deleteCommand,
  listCategories,
  listCommands,
  listHistory,
  runBatch,
  runCommand,
  saveCategories,
  searchCommandsForAttachment,
  saveCommand,
  toggleFavorite,
  type CommandDefinition,
  type RunResult,
} from "./shared/commands";
import { commandSchema, validateCommandForSave } from "./shared/commands";
import {
  createSchedule,
  listScheduleRuns,
  listSchedules,
  scheduleAction,
  updateSchedule,
} from "./shared/schedules";
import {
  appendHistory as appendHistoryEntry,
  clearHistoryStore,
  collectImplicitCategories,
  enforceHistoryLimit,
  loadCategories,
  loadCommands,
  loadHistory,
  saveCategories as persistCategories,
  saveCommands,
  setHistoryLimit,
} from "./server/store";
import { executeBatch, executeCommand } from "./server/executor";
import { createCommandCenterTool } from "./server/agent-tool";
import { readSavedMcpServers } from "./server/agent-record";
import { forgetAgentMcp, loadAgentMcpRegistry } from "./server/agent-mcp";
import { decideSessionOpen, needsCapabilityProbe } from "./server/session-open";
import { renderTemplate } from "./shared/template";
import {
  createScheduleFromCommand,
  fetchScheduleRuns,
  fetchScheduleViews,
  runScheduleAction,
  updateScheduleOnDaemon,
} from "./server/schedules";

function parseCommand(raw: unknown): CommandDefinition | null {
  const result = commandSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(commandCenterSettings);

  // History retention: apply the configured limit at startup and on changes.
  void settings.read().then((state) => {
    if (state.status === "ready") setHistoryLimit(state.values.historyLimit);
    enforceHistoryLimit();
  });
  settings.subscribe((state) => {
    if (state.status === "ready") setHistoryLimit(state.values.historyLimit);
    enforceHistoryLimit();
  });

  // Automation: run a configured command when an agent turn completes. The
  // command runs with template defaults in its default workspace — automation
  // has no user to answer input prompts. Errors are swallowed: a failing
  // auto-run must not break the agent that just finished.
  server.addHook("agent.turn.after", async (event, { paseo }) => {
    if (event.outcome.kind !== "completed") return;
    const state = await settings.read();
    if (state.status !== "ready") return;
    const name = state.values.autoRunCommandOnTurnEnd.trim();
    if (name.length === 0) return;
    const command = loadCommands().find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    );
    if (!command || command.type !== "prompt") return;
    await executeCommand(command, { values: {}, newWorktree: false }, { paseo }).catch(() => undefined);
  });

  // Automation: bootstrap every newly created workspace with a configured
  // command (install deps, lint…). Same defaults-and-swallow-errors policy.
  server.addHook("workspace.create.after", async (event, { paseo }) => {
    const state = await settings.read();
    if (state.status !== "ready") return;
    const name = state.values.bootstrapCommand.trim();
    if (name.length === 0) return;
    const command = loadCommands().find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    );
    if (!command) return;
    await executeCommand(
      command,
      { values: {}, newWorktree: false, workspaceId: event.workspace.id },
      { paseo },
    ).catch(() => undefined);
  });

  // The MCP registry tracks live agents only; an archived agent's entry is
  // worthless (a later reopen of the same id would be a different session).
  server.addHook("agent.archive.after", async (event) => {
    forgetAgentMcp(event.agent.id);
  });

  // -------------------------------------------------------------------------
  // Session-open re-derivation (Paseo 0.14.0, 0.6.0 — recommendations §12.3
  // items 1 and 2).
  //
  // Every interactive reopen re-derives two contributions:
  //
  // 1. the `command_center_run` agent tool — attached unconditionally (its
  //    only collision rule is against Paseo's own and other plugins' tools);
  // 2. the launch-only MCP servers of the last command that ran against this
  //    agent (the registry, `server/agent-mcp.ts`) — contributed only for the
  //    names the agent's *saved* configuration lacks, and only when the
  //    record on disk proves that (`server/agent-record.ts`); every unreadable
  //    or unknown state fails safe to *skip*, because a name collision aborts
  //    the session open (host `agent-manager.js`).
  //
  // Runs against *created* agents need none of this: their servers are saved
  // into the agent config at `agents.create` time and survive every reopen.
  // -------------------------------------------------------------------------

  const commandCenterTool = createCommandCenterTool();

  server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    const registry = loadAgentMcpRegistry()[request.agentId] ?? null;
    const decisionInput = {
      reason: request.reason,
      purpose: request.purpose,
      lookup: readSavedMcpServers(request.agentId),
      registry,
      supportsMcpServers: null as boolean | null,
    };

    // The daemon is only consulted when an MCP contribution is still possible;
    // every other branch is decided without touching it.
    if (needsCapabilityProbe(decisionInput)) {
      const snapshot = await paseo.agents
        .ref(request.agentId)
        .refresh()
        .catch(() => null);
      decisionInput.supportsMcpServers = snapshot?.agent.capabilities.supportsMcpServers ?? null;
    }

    const decision = decideSessionOpen(decisionInput);
    console.log(
      `[command-center] session_open ${request.agentId} (${request.reason}/${request.purpose}): ${decision.why}`,
    );

    const tools =
      request.purpose === "interactive" ? [...request.tools, commandCenterTool] : request.tools;
    if (decision.contribute.length === 0) {
      return { ...request, tools };
    }

    const contributed = Object.fromEntries(
      decision.contribute.map((name) => [name, registry!.servers[name]]),
    );
    console.log(
      `[command-center] session_open MCP contributed: ${decision.contribute.join(", ")}`,
    );
    return {
      ...request,
      tools,
      mcpServers: { ...request.mcpServers, ...contributed } as typeof request.mcpServers,
    };
  });

  server.handle(listCommands, () => ({
    commands: loadCommands(),
  }));

  server.handle(saveCommand, (input) => {
    if (input.deleteId) {
      const remaining = loadCommands().filter((command) => command.id !== input.deleteId);
      saveCommands(remaining);
    }
    const incoming = parseCommand(input.command);
    if (!incoming) {
      return { saved: false, id: null, error: "Command payload failed validation." };
    }
    const commands = loadCommands();
    // Per-type requirements the schema leaves out (workflow steps, template):
    // one shared definition with the editor and the tests.
    const invalid = validateCommandForSave(incoming, commands);
    if (invalid) {
      return { saved: false, id: null, error: invalid };
    }
    const existingIndex = commands.findIndex((command) => command.id === incoming.id);
    if (existingIndex >= 0) {
      // Preserve server-owned counters the client editor does not track.
      incoming.useCount = commands[existingIndex].useCount;
      commands[existingIndex] = incoming;
    } else {
      commands.push(incoming);
    }
    commands.sort((a, b) => a.name.localeCompare(b.name));
    saveCommands(commands);
    return { saved: true, id: incoming.id, error: null };
  });

  server.handle(deleteCommand, (input) => {
    saveCommands(loadCommands().filter((command) => command.id !== input.id));
    return { deleted: true };
  });

  server.handle(listCategories, () => {
    // Commands may reference labels that are not in the store (manual edits of
    // commands.json, or a sync race). Surface them so they are editable and
    // the filter never silently hides commands.
    const implicit = collectImplicitCategories(loadCommands());
    const stored = loadCategories();
    const known = new Set(stored.map((category) => category.sortKey));
    const merged = [
      ...stored,
      ...implicit
        .filter((key) => !known.has(key))
        .map((key) => ({ name: key, sortKey: key })),
    ];
    merged.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    return { categories: merged };
  });

  server.handle(saveCategories, (input) => {
    const commands = loadCommands();
    let categories = loadCategories();

    if (input.deleteName) {
      const key = input.deleteName.trim().toLowerCase();
      categories = categories.filter((category) => category.sortKey !== key);
      // Commands referencing the deleted label fall back to uncategorized.
      let changed = false;
      for (const command of commands) {
        if (typeof command.category === "string" && command.category.trim().toLowerCase() === key) {
          delete command.category;
          changed = true;
        }
      }
      if (changed) saveCommands(commands);
    }

    if (input.category) {
      const name = input.category.name.trim();
      if (name.length === 0) {
        return { ok: false, error: "Category name must not be empty." };
      }
      const sortKey = name.toLowerCase();
      const renameKey = input.renameFrom?.trim().toLowerCase() ?? null;
      if (renameKey !== null && renameKey !== sortKey) {
        // Rename: move commands over, drop the old label from the store.
        for (const command of commands) {
          if (typeof command.category === "string" && command.category.trim().toLowerCase() === renameKey) {
            command.category = name;
            command.updatedAt = new Date().toISOString();
          }
        }
        saveCommands(commands);
        categories = categories.filter((category) => category.sortKey !== renameKey);
      }
      categories = categories.filter((category) => category.sortKey !== sortKey);
      categories.push({ name, sortKey });
      categories.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    }

    persistCategories(categories);
    return { ok: true, error: null };
  });

  server.handle(toggleFavorite, (input) => {
    const commands = loadCommands();
    const target = commands.find((command) => command.id === input.id);
    if (!target) return { ok: false };
    target.favorite = input.favorite;
    saveCommands(commands);
    return { ok: true };
  });

  server.handle(listHistory, () => ({ entries: loadHistory() }));

  server.handle(clearHistory, () => {
    clearHistoryStore();
    return { ok: true };
  });

  server.handle(runCommand, async (input, { paseo }) => {
    const command = loadCommands().find((candidate) => candidate.id === input.commandId);
    if (!command) {
      const miss: RunResult = {
        ok: false,
        kind: "new-agent",
        workspaceId: null,
        agentId: null,
        terminalId: null,
        title: null,
        error: `Unknown command ${input.commandId}.`,
      };
      return miss;
    }
    const result = await executeCommand(
      command,
      {
        values: input.values,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        newWorktree: input.newWorktree ?? false,
        provider: input.provider,
      },
      { paseo },
    );
    if (result.ok) {
      const commands = loadCommands();
      const stored = commands.find((candidate) => candidate.id === command.id);
      if (stored) {
        stored.useCount += 1;
        saveCommands(commands);
      }
    }
    return result;
  });

  server.handle(runBatch, async (input, { paseo }) => {
    const command = loadCommands().find((candidate) => candidate.id === input.commandId);
    if (!command) {
      return {
        results: input.targets.map(
          (): RunResult => ({
            ok: false,
            kind: "new-agent",
            workspaceId: null,
            agentId: null,
            terminalId: null,
            title: null,
            error: `Unknown command ${input.commandId}.`,
          }),
        ),
      };
    }
    const results = await executeBatch(
      command,
      { values: input.values, targets: input.targets, batchId: input.batchId },
      { paseo },
    );
    const succeeded = results.filter((result) => result.ok).length;
    if (succeeded > 0) {
      const commands = loadCommands();
      const stored = commands.find((candidate) => candidate.id === command.id);
      if (stored) {
        stored.useCount += succeeded;
        saveCommands(commands);
      }
    }
    return { results };
  });

  server.handle(appendHistory, (input) => {
    const now = new Date();
    const entry = {
      ...input.entry,
      id: `h_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      at: now.toISOString(),
    };
    appendHistoryEntry(loadHistory(), entry);
    return { ok: true, id: entry.id };
  });

  server.handle(listSchedules, () =>
    fetchScheduleViews().then((schedules) => ({ schedules })),
  );

  server.handle(createSchedule, async (input, { paseo }) => {
    // Resolve the workspace for template context and the run cwd via the
    // normal plugin API; the schedule itself is created on the daemon.
    // No workspaceId (e.g. `/cc schedule` from chat) falls back to the first
    // workspace — the same best-guess the run flow uses.
    let workspaceName: string | null = null;
    let workspaceDirectory: string | null = null;
    try {
      const result = await paseo.workspaces.list();
      const entries = result.entries;
      const record = (
        input.workspaceId
          ? entries.find(
              (entry) => (entry as { id?: string }).id === input.workspaceId,
            )
          : entries[0]
      ) as
        | {
            id?: string;
            name?: string | null;
            workspaceDirectory?: string | null;
            projectRootPath?: string | null;
          }
        | undefined;
      if (record) {
        workspaceName = record.name ?? null;
        workspaceDirectory = record.workspaceDirectory ?? record.projectRootPath ?? null;
      }
    } catch {
      // Workspace listing failed — fall back to the explicit cwd input.
    }
    // Workflows execute their steps synchronously against the scheduler's own
    // context, which the schedule bridge does not model — scheduling the
    // individual step commands is the supported equivalent.
    const scheduled = loadCommands().find((command) => command.id === input.commandId);
    if (!scheduled) {
      return { ok: false, id: null, view: null, error: `Unknown command ${input.commandId}.` };
    }
    if (scheduled.type === "workflow") {
      return {
        ok: false,
        id: null,
        view: null,
        error: "Workflows cannot be scheduled — schedule their steps instead.",
      };
    }
    return createScheduleFromCommand({
      commandId: input.commandId,
      name: input.name ?? null,
      values: input.values,
      workspaceId: input.workspaceId ?? null,
      cwd: input.cwd ?? null,
      provider: input.provider,
      newWorktree: input.newWorktree,
      archiveOnFinish: input.archiveOnFinish,
      cron: input.cron,
      maxRuns: input.maxRuns ?? null,
      runOnCreate: input.runOnCreate,
      workspaceName,
      workspaceDirectory,
      render: renderTemplate,
    });
  });

  server.handle(scheduleAction, (input) => runScheduleAction(input.id, input.action));

  // "Refresh Command Center tools" (0.6.0): `agents.ref(id).reload()` (new in
  // 0.14.0) reopens the provider session with the current configuration,
  // rerunning `agent.session_open` — the programmatic answer to "this agent
  // lost its Command Center tools". A refused reload throws, which the client
  // surfaces as an error toast, so it is never silent.
  server.handle(agentReload, async (input, { paseo }) => {
    try {
      const result = await paseo.agents.ref(input.agentId).reload();
      return { ok: true, title: result?.agent?.title ?? null, error: null };
    } catch (error) {
      return {
        ok: false,
        title: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  server.handle(searchCommandsForAttachment, (input) => {
    const query = input.query.trim().toLowerCase();
    const terms = query.length > 0 ? query.split(/\s+/) : [];
    const matches = (command: CommandDefinition): boolean =>
      terms.every((term) =>
        [command.name, command.template, command.category ?? ""]
          .join("\n")
          .toLowerCase()
          .includes(term),
      );
    return {
      items: loadCommands()
        // A workflow has no template of its own, so there is nothing to insert
        // into a composer message; it stays out of the attachment picker.
        .filter((command) => command.type !== "workflow")
        .filter(matches)
        .slice(0, 20)
        .map((command) => ({
          id: command.id,
          identifier: `command-center:${command.id}`,
          title: command.name,
          subtitle: command.category,
          url: `command-center://command/${command.id}`,
          text: command.template,
          resourceType: command.type === "shell" ? "shell-command" : "prompt-command",
        })),
    };
  });

  server.handle(listScheduleRuns, (input) =>
    fetchScheduleRuns(input.id).then((runs) => ({ runs })),
  );

  server.handle(updateSchedule, (input) =>
    updateScheduleOnDaemon({
      id: input.id,
      cron: input.cron,
      maxRuns: input.maxRuns,
    }),
  );

  return () => {};
}
