import type { PaseoApi } from "@getpaseo/client";
import type { CommandDefinition } from "../shared/commands";
import { isFullModelRef } from "../shared/commands";
import { renderTemplate, worktreeBranchFor } from "../shared/template";

export interface RemoteTargetInput {
  workspaceId?: string;
  agentId?: string;
  provider?: string;
  newWorktree: boolean;
}

export interface RemoteWorkspaceInfo {
  id: string;
  name: string | null;
  directory: string | null;
}

export interface RemoteDispatchResult {
  ok: boolean;
  kind: "new-agent" | "existing-agent" | "terminal";
  workspaceId: string | null;
  agentId: string | null;
  terminalId: string | null;
  rendered: string;
  error: string | null;
}

function commandTitle(command: CommandDefinition): string {
  return command.name.length > 60 ? `${command.name.slice(0, 59)}…` : command.name;
}

function fail(
  kind: RemoteDispatchResult["kind"],
  message: string,
  workspaceId: string | null = null,
): RemoteDispatchResult {
  return {
    ok: false,
    kind,
    workspaceId,
    agentId: null,
    terminalId: null,
    rendered: "",
    error: message,
  };
}

/**
 * Executes one target against a non-local host via its `PaseoApi`.
 * Mirrors the daemon-side executor (`server/executor.ts`) so multi-host
 * fan-out behaves the same; history recording stays with the caller, which
 * reports back through the `command-center.history-append` RPC.
 */
export async function dispatchRemoteTarget(
  paseo: PaseoApi,
  command: CommandDefinition,
  values: Record<string, string>,
  target: RemoteTargetInput,
  workspace: RemoteWorkspaceInfo | null,
  now: Date = new Date(),
): Promise<RemoteDispatchResult> {
  const context = {
    workspaceName: workspace?.name ?? null,
    workspacePath: workspace?.directory ?? null,
    date: now.toISOString().slice(0, 10),
    time: now.toTimeString().slice(0, 5),
  };

  try {
    if (command.type === "shell") {
      if (!workspace) {
        return fail("terminal", "No workspace selected for this host.");
      }
      const rendered = renderTemplate(command.template, values, context);
      const terminal = await paseo.terminals.create({
        workspaceId: workspace.id,
        name: command.terminalName ?? command.name,
      });
      terminal.write(rendered);
      terminal.write("\n");
      return {
        ok: true,
        kind: "terminal",
        workspaceId: workspace.id,
        agentId: null,
        terminalId: terminal.id,
        rendered,
        error: null,
      };
    }

    const provider = target.provider?.trim() || command.provider?.trim() || "";
    if (!isFullModelRef(provider)) {
      return fail(
        "new-agent",
        provider
          ? `Provider "${provider}" must be in 'provider/model' format — pick a model when running.`
          : "No provider/model selected.",
        workspace?.id ?? null,
      );
    }
    const rendered = renderTemplate(command.template, values, context);

    if (target.agentId) {
      await paseo.agents.ref(target.agentId).send(rendered);
      return {
        ok: true,
        kind: "existing-agent",
        workspaceId: workspace?.id ?? null,
        agentId: target.agentId,
        terminalId: null,
        rendered,
        error: null,
      };
    }

    if (target.newWorktree) {
      if (!workspace) {
        return fail("new-agent", "A workspace is required to branch off a worktree.");
      }
      const created = await paseo.workspaces.ref(workspace.id).agents.create({
        config: { provider },
        prompt: rendered,
        worktree: { mode: "branch-off", newBranch: worktreeBranchFor(command.name, now.getTime()) },
        title: commandTitle(command),
        labels: { source: "command-center" },
      });
      return {
        ok: true,
        kind: "new-agent",
        workspaceId: workspace.id,
        agentId: created.id,
        terminalId: null,
        rendered,
        error: null,
      };
    }

    if (!workspace?.directory) {
      return fail(
        "new-agent",
        "No workspace selected for this host — pick one to derive the working directory.",
      );
    }
    const created = await paseo.agents.create({
      config: { provider },
      cwd: workspace.directory,
      prompt: rendered,
      title: commandTitle(command),
      labels: { source: "command-center" },
    });
    return {
      ok: true,
      kind: "new-agent",
      workspaceId: workspace.id,
      agentId: created.id,
      terminalId: null,
      rendered,
      error: null,
    };
  } catch (error) {
    return fail(
      command.type === "shell" ? "terminal" : "new-agent",
      error instanceof Error ? error.message : String(error),
      workspace?.id ?? null,
    );
  }
}
