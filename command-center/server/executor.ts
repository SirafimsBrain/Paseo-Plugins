import type { PaseoApi } from "@getpaseo/client";
import type { CommandDefinition, HistoryEntry, RunResult } from "../shared/commands";
import { renderTemplate } from "../shared/template";
import { appendHistory, loadHistory } from "./store";

/** Workspace fields the executor and the template context rely on. */
interface WorkspaceLike {
  id: string;
  name: string | null;
  workspaceDirectory: string | null;
  projectRootPath: string | null;
}

function normalizeWorkspace(workspace: unknown): WorkspaceLike | null {
  if (typeof workspace !== "object" || workspace === null) return null;
  const record = workspace as Record<string, unknown>;
  const id = typeof record["id"] === "string" ? record["id"] : null;
  if (!id) return null;
  const name = typeof record["name"] === "string" ? record["name"] : null;
  const directory =
    typeof record["workspaceDirectory"] === "string"
      ? record["workspaceDirectory"]
      : typeof record["directory"] === "string"
        ? (record["directory"] as string)
        : null;
  const root = typeof record["projectRootPath"] === "string" ? record["projectRootPath"] : null;
  return { id, name, workspaceDirectory: directory, projectRootPath: root };
}

async function listWorkspaces(paseo: PaseoApi): Promise<WorkspaceLike[]> {
  const result = await paseo.workspaces.list();
  return result.entries
    .map(normalizeWorkspace)
    .filter((workspace): workspace is WorkspaceLike => workspace !== null);
}

async function resolveWorkspace(
  paseo: PaseoApi,
  workspaceId: string | undefined,
): Promise<WorkspaceLike | null> {
  const workspaces = await listWorkspaces(paseo);
  if (workspaces.length === 0) return null;
  if (workspaceId) return workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  // Prefer a workspace whose agents are busy or waiting for input: that is the
  // one a user is most likely to mean by "the current workspace".
  const prioritized = await paseo.agents
    .list({ scope: "active", filter: { includeArchived: false } })
    .catch(() => null);
  const activeWorkspaceIds = new Set(
    (prioritized?.entries ?? [])
      .map((entry) => (entry as { workspaceId?: string | null }).workspaceId ?? null)
      .filter((value): value is string => typeof value === "string"),
  );
  return (
    workspaces.find((workspace) => activeWorkspaceIds.has(workspace.id)) ??
    workspaces[0] ??
    null
  );
}

function commandTitle(command: CommandDefinition): string {
  return command.name.length > 60 ? `${command.name.slice(0, 59)}…` : command.name;
}

/** Worktree mode "branch-off" requires an explicit branch name. */
function worktreeBranchName(command: CommandDefinition): string {
  const slug =
    command.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "command";
  return `command-center/${slug}-${Date.now().toString(36)}`;
}

/** True when the agent id exists and is not archived. */
async function agentIsOpen(paseo: PaseoApi, agentId: string): Promise<boolean> {
  const agents = await paseo.agents
    .list({ scope: "active", filter: { includeArchived: true } })
    .catch(() => null);
  for (const entry of agents?.entries ?? []) {
    const candidate = entry as { id?: string; archivedAt?: string | null };
    if (candidate.id === agentId) return !candidate.archivedAt;
  }
  return false;
}

export interface RunDeps {
  paseo: PaseoApi;
  now?: () => Date;
}

/**
 * Executes a command. Prompt commands create a new agent (optionally inside a
 * fresh worktree) or send to an existing agent; shell commands create a
 * workspace terminal and write the rendered line into it.
 */
export async function executeCommand(
  command: CommandDefinition,
  input: {
    values: Record<string, string>;
    workspaceId?: string;
    agentId?: string;
    newWorktree: boolean;
  },
  deps: RunDeps,
): Promise<RunResult> {
  const { paseo } = deps;
  const now = deps.now ?? (() => new Date());

  try {
    if (command.type === "shell") {
      const workspace = await resolveWorkspace(paseo, input.workspaceId);
      if (!workspace) {
        return failure("terminal", "No workspace available to run a terminal command in.");
      }
      const rendered = renderTemplate(command.template, input.values, templateContext(workspace, now));
      const terminal = await paseo.terminals.create({
        workspaceId: workspace.id,
        name: command.terminalName ?? command.name,
      });
      terminal.write(rendered);
      terminal.write("\n");
      const entry: HistoryEntry = {
        id: `h_${now().getTime()}_${Math.random().toString(36).slice(2, 8)}`,
        commandId: command.id,
        commandName: command.name,
        rendered,
        targetWorkspaceId: workspace.id,
        targetAgentId: null,
        kind: "terminal",
        ok: true,
        error: null,
        at: now().toISOString(),
      };
      appendHistory(loadHistory(), entry);
      return {
        ok: true,
        kind: "terminal",
        workspaceId: workspace.id,
        agentId: null,
        terminalId: terminal.id,
        title: workspace.name,
        error: null,
      };
    }

    if (!command.provider) {
      return failure(
        "new-agent",
        "Command has no provider configured. Edit the command and set provider/model.",
      );
    }

    const workspace = input.newWorktree ? await resolveWorkspace(paseo, input.workspaceId) : null;
    if (input.newWorktree && !workspace) {
      return failure("new-agent", "A workspace is required to branch off a worktree.");
    }

    const contextWorkspace = await resolveWorkspace(paseo, input.workspaceId);
    const rendered = renderTemplate(
      command.template,
      input.values,
      templateContext(contextWorkspace, now),
    );

    if (input.agentId) {
      if (!(await agentIsOpen(paseo, input.agentId))) {
        return failure(
          "existing-agent",
          `Agent ${input.agentId} is archived or unknown; reopen it or create a new agent.`,
        );
      }
      const handle = paseo.agents.ref(input.agentId);
      await handle.send(rendered);
      recordHistory(command, rendered, "existing-agent", contextWorkspace?.id ?? null, input.agentId, true, null, now);
      return {
        ok: true,
        kind: "existing-agent",
        workspaceId: contextWorkspace?.id ?? null,
        agentId: input.agentId,
        terminalId: null,
        title: commandTitle(command),
        error: null,
      };
    }

    const created = input.newWorktree && workspace
      ? await paseo.workspaces.ref(workspace.id).agents.create({
          config: { provider: command.provider },
          prompt: rendered,
          worktree: { mode: "branch-off", newBranch: worktreeBranchName(command) },
          title: commandTitle(command),
          labels: { source: "command-center" },
        })
      : await paseo.agents.create({
          config: { provider: command.provider },
          cwd: contextWorkspace?.workspaceDirectory ?? contextWorkspace?.projectRootPath ?? process.cwd(),
          prompt: rendered,
          title: commandTitle(command),
          labels: { source: "command-center" },
        });

    recordHistory(
      command,
      rendered,
      "new-agent",
      input.newWorktree ? (workspace?.id ?? null) : (contextWorkspace?.id ?? null),
      created.id,
      true,
      null,
      now,
    );
    return {
      ok: true,
      kind: "new-agent",
      workspaceId: input.newWorktree ? (workspace?.id ?? null) : (contextWorkspace?.id ?? null),
      agentId: created.id,
      terminalId: null,
      title: commandTitle(command),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(command.type === "shell" ? "terminal" : "new-agent", message);
  }
}

function templateContext(
  workspace: WorkspaceLike | null,
  now: () => Date,
): Parameters<typeof renderTemplate>[2] {
  return {
    workspaceName: workspace?.name ?? null,
    workspacePath: workspace?.workspaceDirectory ?? workspace?.projectRootPath ?? null,
    date: now().toISOString().slice(0, 10),
    time: now().toTimeString().slice(0, 5),
  };
}

function recordHistory(
  command: CommandDefinition,
  rendered: string,
  kind: HistoryEntry["kind"],
  workspaceId: string | null,
  agentId: string | null,
  ok: boolean,
  error: string | null,
  now: () => Date,
): void {
  appendHistory(loadHistory(), {
    id: `h_${now().getTime()}_${Math.random().toString(36).slice(2, 8)}`,
    commandId: command.id,
    commandName: command.name,
    rendered,
    targetWorkspaceId: workspaceId,
    targetAgentId: agentId,
    kind,
    ok,
    error,
    at: now().toISOString(),
  });
}

function failure(kind: RunResult["kind"], message: string): RunResult {
  return {
    ok: false,
    kind,
    workspaceId: null,
    agentId: null,
    terminalId: null,
    title: null,
    error: message,
  };
}
