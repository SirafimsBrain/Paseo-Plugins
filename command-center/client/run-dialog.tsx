import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import type { ActiveTurnBehavior, CommandDefinition, ProviderWithModels, RunResult } from "../shared/commands";
import { isFullModelRef, resolveModelRef } from "../shared/commands";
import { browseFiles, resolveCommandInputs, type BrowseResult } from "../shared/variables";
import { planTargets, type BatchTarget } from "../shared/targets";
import { renderPreview } from "./preview";
import { ScheduleDialog } from "./schedule-dialog";
import { interfaceFontFamily, monoFontFamily, scaledFont, useHostTypography } from "./use-host-typography";
import { ProviderModelPicker } from "./provider-model-picker";

export interface DialogWorkspaceOption {
  id: string;
  name: string;
  serverId: string;
  hostLabel: string;
  directory: string | null;
}

export interface DialogAgentOption {
  id: string;
  title: string | null;
  status: string;
  workspaceId: string | null;
  serverId: string;
  hostLabel: string;
}

export interface DialogProviderOption {
  id: string;
  enabled: boolean;
  serverId: string;
  hostLabel: string;
}
export interface BatchItemResult {
  key: string;
  workspaceName: string;
  hostLabel: string;
  ok: boolean;
  kind: RunResult["kind"];
  error: string | null;
}

interface Props {
  command: CommandDefinition;
  /** Saved library, to label a workflow's steps in the preview. */
  library?: CommandDefinition[];
  workspaces: DialogWorkspaceOption[];
  agents: DialogAgentOption[];
  providers: ProviderWithModels[];
  modelsLoading: boolean;
  multiHost: boolean;
  theme: PluginTheme;
  /** Repeat preset from a history entry; overrides template defaults. */
  initialValues?: Record<string, string>;
  initialProvider?: string | null;
  /** JSON workspace key; null/unknown falls back to the default target. */
  initialWorkspaceKey?: string | null;
  initialAgentId?: string | null;
  onRun: (input: { values: Record<string, string>; targets: BatchTarget[] }) => Promise<BatchItemResult[]>;
  /** Creates a schedule from the current dialog state; absent on old hosts. */
  onSchedule?: (input: {
    values: Record<string, string>;
    provider: string;
    workspaceId: string | undefined;
    newWorktree: boolean;
    name: string;
    cron: string;
    maxRuns: number | null;
    runOnCreate: boolean;
  }) => Promise<string | null>;
  onCancel: () => void;
}

function isKnownWorkspaceKey(workspaces: DialogWorkspaceOption[], key: string): boolean {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed)) return false;
    return workspaces.some((option) => option.serverId === parsed[0] && option.id === parsed[1]);
  } catch {
    return false;
  }
}

export function RunDialog({
  command,
  library,
  workspaces,
  agents,
  providers,
  modelsLoading,
  multiHost,
  theme,
  initialValues,
  initialProvider,
  initialWorkspaceKey,
  initialAgentId,
  onRun,
  onSchedule,
  onCancel,
}: Props) {
  const isWorkflow = command.type === "workflow";
  // A workflow has no template of its own: each step renders its own command
  // with its stored defaults, so there are no workflow-level inputs to fill.
  // `resolveCommandInputs` merges declared variables (which carry the 0.10.0
  // kind) with `{{input:…}}` names discovered in the template.
  const merged = useMemo(() => resolveCommandInputs(command), [command]);
  const workflowPreview = useMemo(() => {
    if (!isWorkflow) return "";
    return command.steps
      .map((step, index) => {
        const target = (library ?? []).find((candidate) => candidate.id === step.commandId);
        const name = target?.name ?? "missing command";
        const condition =
          step.condition === "on-success" ? " [on success]" : step.condition === "on-failure" ? " [on failure]" : "";
        return `${index + 1}. ${name}${condition}`;
      })
      .join("\n");
  }, [command.steps, isWorkflow, library]);

  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(merged.map((variable) => [variable.name, variable.defaultValue ?? ""])),
    ...initialValues,
  }));
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() => {
    if (initialWorkspaceKey && isKnownWorkspaceKey(workspaces, initialWorkspaceKey)) {
      return [initialWorkspaceKey];
    }
    return workspaces.length > 0 ? [JSON.stringify([workspaces[0]!.serverId, workspaces[0]!.id])] : [];
  });
  const [provider, setProvider] = useState<string>(() =>
    resolveModelRef(providers, initialProvider ?? command.provider),
  );
  /** Existing agents picked as run targets (0.9.0 — multi-select fan-out). */
  const [selectedAgentKeys, setSelectedAgentKeys] = useState<string[]>(() => {
    if (!initialAgentId) return [];
    const match = agents.find((agent) => agent.id === initialAgentId && agent.status !== "closed");
    return match ? [`${match.serverId}:${match.id}`] : [];
  });
  const [newWorktree, setNewWorktree] = useState(false);
  /** What happens when the existing-agent target is mid-turn (0.6.0). */
  const [activeTurn, setActiveTurn] = useState<ActiveTurnBehavior>("interrupt");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BatchItemResult[] | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  /** `file` input whose directory browser is expanded (0.10.0). */
  const [browsingInput, setBrowsingInput] = useState<string | null>(null);

  // Re-resolve when the model catalog arrives/changes. Safe: a picked value
  // that is still known is returned unchanged, so explicit picks survive.
  useEffect(() => {
    setProvider((current) => resolveModelRef(providers, current || initialProvider || command.provider));
  }, [providers, command.provider, initialProvider]);

  const isShell = command.type === "shell";
  const openAgents = agents.filter((agent) => agent.status !== "closed");

  const selectedWorkspaces = useMemo(
    () =>
      selectedKeys
        .map((key) => {
          try {
            const parsed: unknown = JSON.parse(key);
            if (!Array.isArray(parsed)) return null;
            return workspaces.find((option) => option.serverId === parsed[0] && option.id === parsed[1]) ?? null;
          } catch {
            return null;
          }
        })
        .filter((option): option is DialogWorkspaceOption => option !== null),
    [selectedKeys, workspaces],
  );

  const groupedWorkspaces = useMemo(() => {
    const groups = new Map<string, { label: string; options: DialogWorkspaceOption[] }>();
    for (const option of workspaces) {
      const groupKey = option.serverId;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          label: option.hostLabel.length > 0 ? option.hostLabel : "This host",
          options: [],
        };
        groups.set(groupKey, group);
      }
      group.options.push(option);
    }
    return [...groups.values()];
  }, [workspaces]);

  const agentKey = (agent: DialogAgentOption) => `${agent.serverId}:${agent.id}`;
  const selectedAgents = useMemo(
    () => openAgents.filter((agent) => selectedAgentKeys.includes(agentKey(agent))),
    [openAgents, selectedAgentKeys],
  );
  /**
   * Agents offered as targets: when workspaces are selected, only the agents
   * living in them (across hosts); with no workspace selected, every open agent.
   * Selecting an agent implies its workspace, so the same workspace is not run
   * twice (no new agent is created next to the one that was picked).
   */
  const agentsForTarget = useMemo(() => {
    if (selectedWorkspaces.length === 0) return openAgents;
    return openAgents.filter((agent) =>
      selectedWorkspaces.some(
        (workspace) => workspace.id === agent.workspaceId && workspace.serverId === agent.serverId,
      ),
    );
  }, [openAgents, selectedWorkspaces]);
  const groupedAgents = useMemo(() => {
    const groups = new Map<string, { label: string; options: DialogAgentOption[] }>();
    for (const agent of agentsForTarget) {
      let group = groups.get(agent.serverId);
      if (!group) {
        group = { label: agent.hostLabel.length > 0 ? agent.hostLabel : "This host", options: [] };
        groups.set(agent.serverId, group);
      }
      group.options.push(agent);
    }
    return [...groups.values()];
  }, [agentsForTarget]);
  /** Workspace key of an agent's own workspace, when it is loaded. */
  const workspaceKeyForAgent = (agent: DialogAgentOption): string | null => {
    const workspace = workspaces.find(
      (option) => option.id === agent.workspaceId && option.serverId === agent.serverId,
    );
    return workspace ? JSON.stringify([workspace.serverId, workspace.id]) : null;
  };

  const firstWorkspace = selectedWorkspaces[0] ?? null;
  const preview = isWorkflow
    ? workflowPreview
    : renderPreview(
        command.template,
        values,
        firstWorkspace?.id,
        workspaces.map((option) => ({ id: option.id, name: option.name })),
      );

  const { foreground, foregroundMuted } = theme.colors;
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const monoFont = monoFontFamily(typography);

  const toggleWorkspace = (key: string) => {
    setResults(null);
    setSelectedKeys((previous) =>
      previous.includes(key) ? previous.filter((candidate) => candidate !== key) : [...previous, key],
    );
  };

  const toggleAgent = (agent: DialogAgentOption) => {
    setResults(null);
    const key = agentKey(agent);
    setSelectedAgentKeys((previous) =>
      previous.includes(key) ? previous.filter((candidate) => candidate !== key) : [...previous, key],
    );
  };

  /**
   * Workspaces that still need a *new* agent: the selected ones minus those
   * already covered by a selected existing agent. Selecting an agent therefore
   * replaces the new-agent run for its workspace instead of duplicating it.
   */
  const newAgentWorkspaceKeys = selectedKeys.filter((key) => {
    const covered = selectedAgents.some((agent) => workspaceKeyForAgent(agent) === key);
    return !covered;
  });
  const targetCount = Math.max(newAgentWorkspaceKeys.length + selectedAgents.length, 1);
  const agentTargetCount = selectedAgents.length;
  // A workflow has no provider of its own — each prompt step uses its stored one.
  const providerValid = isShell || isWorkflow || isFullModelRef(provider);
  const canRun = !busy && providerValid;
  const runLabel = busy
    ? "Running…"
    : isWorkflow
      ? targetCount > 1
        ? `Run workflow on ${targetCount} targets`
        : "Run workflow"
      : isShell
        ? `Run in terminal on ${targetCount}`
        : targetCount > 1
          ? `Run on ${targetCount} targets`
          : agentTargetCount > 0
            ? "Send to agent"
            : "Run";

  const handleRun = () => {
    if (!canRun) return;
    const targets: BatchTarget[] = planTargets({
      selectedWorkspaceKeys: selectedKeys,
      selectedAgents: selectedAgents.map((agent) => ({
        id: agent.id,
        serverId: agent.serverId,
        workspaceKey: workspaceKeyForAgent(agent),
      })),
      provider: isWorkflow ? undefined : provider || undefined,
      newWorktree,
      workflow: isWorkflow,
      activeTurnBehavior: selectedAgents.length > 0 ? activeTurn : undefined,
    });
    setBusy(true);
    setResults(null);
    void onRun({ values, targets })
      .then((items) => setResults(items))
      .catch((error: unknown) =>
        setResults([
          {
            key: "error",
            workspaceName: "",
            hostLabel: "",
            ok: false,
            kind: isShell ? "terminal" : "new-agent",
            error: error instanceof Error ? error.message : String(error),
          },
        ]),
      )
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: foreground }, uiFont ? { fontFamily: uiFont } : null, { fontSize: font(16) }]}>
        {command.name}
      </Text>
      <Text style={[styles.subtitle, { color: foregroundMuted, fontSize: font(12) }]}>
        {isWorkflow
          ? `Runs ${command.steps.length} ${command.steps.length === 1 ? "step" : "steps"} in order on each selected workspace (${targetCount}). Steps keep their own providers and defaults.`
          : isShell
          ? `Runs in a new terminal on each selected workspace (${targetCount}).`
          : agentTargetCount > 0
            ? `Sends the prompt to ${agentTargetCount} ${agentTargetCount === 1 ? "existing agent" : "existing agents"}${newAgentWorkspaceKeys.length > 0 ? ` and creates ${newAgentWorkspaceKeys.length} new ${newAgentWorkspaceKeys.length === 1 ? "agent" : "agents"}` : ""}.`
            : targetCount > 1
              ? `Creates a new agent on each of the ${targetCount} selected workspaces.`
              : command.scope === "workspace"
                ? "Runs in the selected workspace."
                : "Creates a new agent in the selected workspace."}
      </Text>

      {merged.length > 0 ? (
        <>
          <Text style={[styles.label, { color: foregroundMuted }]}>Inputs</Text>
          {merged.map((variable) => {
            const setValue = (text: string) =>
              setValues((previous) => ({ ...previous, [variable.name]: text }));
            return (
              <View key={variable.name} style={styles.field}>
                <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>
                  {variable.prompt || variable.name}
                  {variable.kind === "workspace" ? " · workspace" : variable.kind === "file" ? " · file" : ""}
                </Text>

                {variable.kind === "workspace" ? (
                  <>
                    {workspaces.length === 0 ? (
                      <Text style={[styles.hint, { color: foregroundMuted }]}>
                        No workspaces loaded — type the value below.
                      </Text>
                    ) : (
                      <View style={styles.row}>
                        {workspaces.map((option) => {
                          const active = (values[variable.name] ?? "") === option.name;
                          return (
                            <Pressable
                              key={`${option.serverId}:${option.id}`}
                              style={[styles.chip, { borderColor: theme.colors.border }, active && styles.chipActive]}
                              onPress={() => setValue(option.name)}
                            >
                              <Text style={[styles.chipText, { color: foreground }]} numberOfLines={1}>
                                {active ? "✓ " : ""}{option.name}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    )}
                    <Text style={[styles.hint, { color: foregroundMuted }]}>
                      Picks the workspace name; use {"{{"}workspace.path{"}}"} for its directory.
                    </Text>
                  </>
                ) : variable.kind === "file" ? (
                  <>
                    <View style={styles.row}>
                      <TextInput
                        style={[styles.input, styles.grow, { color: foreground, borderColor: theme.colors.border }]}
                        value={values[variable.name] ?? ""}
                        onChangeText={setValue}
                        placeholder={variable.defaultValue ?? "/absolute/path/to/file"}
                        placeholderTextColor={foregroundMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                      <Pressable
                        style={[styles.chip, { borderColor: theme.colors.border }]}
                        onPress={() =>
                          setBrowsingInput((current) => (current === variable.name ? null : variable.name))
                        }
                      >
                        <Text style={[styles.chipText, { color: foreground }]}>
                          {browsingInput === variable.name ? "Hide" : "Browse…"}
                        </Text>
                      </Pressable>
                    </View>
                    {browsingInput === variable.name ? (
                      firstWorkspace?.directory ? (
                        <FileBrowser
                          cwd={firstWorkspace.directory}
                          startPath={values[variable.name] || firstWorkspace.directory}
                          theme={theme}
                          font={font}
                          monoFont={monoFont}
                          onPick={(picked) => {
                            setValue(picked);
                            setBrowsingInput(null);
                          }}
                          onClose={() => setBrowsingInput(null)}
                        />
                      ) : (
                        <Text style={[styles.hint, { color: foregroundMuted }]}>
                          Browsing needs a workspace directory — select a local workspace or type the
                          path.
                        </Text>
                      )
                    ) : null}
                  </>
                ) : (
                  <TextInput
                    style={[styles.input, { color: foreground, borderColor: theme.colors.border }]}
                    value={values[variable.name] ?? ""}
                    onChangeText={setValue}
                    placeholder={variable.defaultValue ?? variable.name}
                    placeholderTextColor={foregroundMuted}
                  />
                )}
              </View>
            );
          })}
        </>
      ) : null}

      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>
          Workspaces{targetCount > 1 ? ` (${targetCount} selected)` : ""} — tap to select several
        </Text>
        {workspaces.length === 0 ? (
          <Text style={[styles.hint, { color: foregroundMuted }]}>
            No workspaces found — the run will use the server&apos;s best guess.
          </Text>
        ) : null}
        {groupedWorkspaces.map((group) => (
          <View key={group.label} style={styles.group}>
            {multiHost ? <Text style={[styles.groupLabel, { color: foregroundMuted }]}>{group.label}</Text> : null}
            <View style={styles.row}>
              {group.options.map((option) => {
                const key = JSON.stringify([option.serverId, option.id]);
                const active = selectedKeys.includes(key);
                return (
                  <Pressable
                    key={key}
                    style={[styles.chip, { borderColor: theme.colors.border }, active && styles.chipActive]}
                    onPress={() => toggleWorkspace(key)}
                  >
                    <Text style={[styles.chipText, { color: foreground }]} numberOfLines={1}>
                      {active ? "✓ " : ""}{option.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
      </View>

      {!isShell ? (
        <>
          {!isWorkflow ? (
          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>Provider / model</Text>
            <ProviderModelPicker
              providers={providers}
              value={provider}
              loading={modelsLoading}
              multiHost={multiHost}
              theme={theme}
              onChange={(next) => {
                setProvider(next);
                setResults(null);
              }}
            />
            {!providerValid ? (
              <Text style={[styles.hint, { color: theme.colors.statusDanger }]}>
                Pick a provider/model — Paseo requires the full format, e.g. cline/claude-opus-4-6.
              </Text>
            ) : null}
          </View>
          ) : null}
          {!isWorkflow ? (
          <View style={styles.field}>
            <Pressable style={styles.checkRow} onPress={() => setNewWorktree((value) => !value)}>
              <Text style={[styles.check, { color: foreground }]}>{newWorktree ? "☑" : "☐"}</Text>
              <Text style={[styles.checkLabel, { color: foreground }]}>Branch off into a new worktree</Text>
            </Pressable>
          </View>
          ) : null}
          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>
              Existing agents (optional) — pick one or more instead of creating new ones
            </Text>
            {agentsForTarget.length === 0 ? (
              <Text style={[styles.hint, { color: foregroundMuted }]}>
                {openAgents.length === 0
                  ? "No open agents on the selected hosts."
                  : "No open agents in the selected workspaces."}
              </Text>
            ) : (
              groupedAgents.map((group) => (
                <View key={group.label} style={styles.group}>
                  {multiHost ? (
                    <Text style={[styles.groupLabel, { color: foregroundMuted }]}>{group.label}</Text>
                  ) : null}
                  <View style={styles.row}>
                    {group.options.map((agent) => {
                      const active = selectedAgentKeys.includes(agentKey(agent));
                      return (
                        <Pressable
                          key={agentKey(agent)}
                          style={[styles.chip, { borderColor: theme.colors.border }, active && styles.chipActive]}
                          onPress={() => toggleAgent(agent)}
                        >
                          <Text style={[styles.chipText, { color: foreground }]} numberOfLines={1}>
                            {active ? "✓ " : ""}{agent.title ?? agent.id.slice(0, 10)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ))
            )}
            {selectedAgents.length > 0 ? (
              <Text style={[styles.hint, { color: foregroundMuted }]}>
                Each selected agent receives the rendered prompt; its workspace is not started again.
              </Text>
            ) : null}
          </View>
          {selectedAgents.length > 0 ? (
            <View style={styles.field}>
              <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>If the agent is busy</Text>
              <View style={styles.row}>
                <Pressable
                  style={[styles.chip, { borderColor: theme.colors.border }, activeTurn === "interrupt" && styles.chipActive]}
                  onPress={() => setActiveTurn("interrupt")}
                >
                  <Text style={[styles.chipText, { color: foreground }]}>Interrupt the turn</Text>
                </Pressable>
                <Pressable
                  style={[styles.chip, { borderColor: theme.colors.border }, activeTurn === "steer" && styles.chipActive]}
                  onPress={() => setActiveTurn("steer")}
                >
                  <Text style={[styles.chipText, { color: foreground }]}>Steer into it</Text>
                </Pressable>
              </View>
              <Text style={[styles.hint, { color: foregroundMuted }]}>
                Interrupt is the daemon default. Steer delivers the prompt into the running turn instead of stopping it.
              </Text>
            </View>
          ) : null}
        </>
      ) : null}

      <View style={styles.previewBox}>
        <Text style={[styles.previewLabel, { color: foregroundMuted }]}>
          {isWorkflow ? "Steps" : "Preview"}{firstWorkspace ? ` — ${firstWorkspace.name}` : ""}{targetCount > 1 ? ` (+${targetCount - 1} more)` : ""}
        </Text>
        <Text style={[styles.previewText, { color: foreground, fontSize: font(12) }, monoFont ? { fontFamily: monoFont } : null]}>
          {preview || "—"}
        </Text>
      </View>

      {results ? (
        <View style={styles.field}>
          {results.map((item) => (
            <Text
              key={item.key}
              style={[styles.resultLine, { color: item.ok ? foreground : theme.colors.statusDanger }]}
            >
              {item.ok ? "✓" : "✗"} {item.hostLabel.length > 0 ? `${item.hostLabel} / ` : ""}{item.workspaceName}
              {item.error ? ` — ${item.error}` : ""}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.row}>
        <Pressable style={[styles.button, styles.secondaryButton]} onPress={onCancel} disabled={busy}>
          <Text style={styles.buttonText}>{results ? "Close" : "Cancel"}</Text>
        </Pressable>
        {onSchedule ? (
          <Pressable
            style={[styles.button, styles.scheduleButton, (!isFullModelRef(provider) || busy) && styles.buttonDisabled]}
            disabled={!isFullModelRef(provider) || busy}
            onPress={() => setScheduling(true)}
          >
            <Text style={styles.buttonText}>Schedule…</Text>
          </Pressable>
        ) : null}
        <Pressable style={[styles.button, !canRun && styles.buttonDisabled]} disabled={!canRun} onPress={handleRun}>
          <Text style={styles.buttonText}>{runLabel}</Text>
        </Pressable>
      </View>

      {scheduling && onSchedule ? (
        <ScheduleDialog
          command={command}
          theme={theme}
          renderedPrompt={preview}
          provider={provider}
          workspaceName={firstWorkspace?.name ?? null}
          newWorktree={newWorktree}
          busy={busy}
          error={scheduleError}
          onCancel={() => {
            setScheduling(false);
            setScheduleError(null);
          }}
          onCreate={(input) => {
            setBusy(true);
            setScheduleError(null);
            void onSchedule({
              values,
              provider,
              workspaceId: firstWorkspace?.id,
              newWorktree,
              name: input.name,
              cron: input.cron,
              maxRuns: input.maxRuns,
              runOnCreate: input.runOnCreate,
            })
              .then((errorResult) => {
                if (errorResult === null) {
                  setScheduling(false);
                  onCancel();
                } else {
                  setScheduleError(errorResult);
                }
              })
              .catch((createError: unknown) =>
                setScheduleError(createError instanceof Error ? createError.message : String(createError)),
              )
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * Directory browser for `file` inputs (0.10.0). Backed by the
 * `command-center.browse` RPC, which lists directories through the local
 * daemon's file explorer; picking an entry fills the input with its path.
 */
function FileBrowser({
  cwd,
  startPath,
  theme,
  font,
  monoFont,
  onPick,
  onClose,
}: {
  cwd: string;
  startPath: string;
  theme: PluginTheme;
  font: (base: number) => number;
  monoFont: string | null;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const browseRpc = useRpc(browseFiles);
  const [dir, setDir] = useState(startPath);
  const [data, setData] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    browseRpc({ cwd, path: dir })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        if (result.error) setError(result.error);
      })
      .catch((browseError: unknown) => {
        if (!cancelled) setError(browseError instanceof Error ? browseError.message : String(browseError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [browseRpc, cwd, dir]);

  const parentOf = (value: string): string => {
    const clean = value.replace(/[\\/]+$/, "");
    const cut = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
    return cut > 0 ? clean.slice(0, cut) : clean;
  };

  const { foreground, foregroundMuted } = theme.colors;

  return (
    <View style={[styles.browser, { borderColor: theme.colors.border }]}>
      <View style={styles.row}>
        <Pressable
          style={[styles.chip, { borderColor: theme.colors.border }]}
          onPress={() => setDir(parentOf(data?.path ?? dir))}
        >
          <Text style={[styles.chipText, { color: foreground, fontSize: font(11) }]}>↑ Up</Text>
        </Pressable>
        <Text
          style={[
            styles.browserPath,
            { color: foregroundMuted, fontSize: font(11) },
            monoFont ? { fontFamily: monoFont } : null,
          ]}
          numberOfLines={1}
        >
          {data?.path ?? dir}
        </Text>
        <Pressable onPress={onClose}>
          <Text style={[styles.chipText, { color: foreground, fontSize: font(11) }]}>✕</Text>
        </Pressable>
      </View>
      {loading ? (
        <Text style={[styles.hint, { color: foregroundMuted }]}>Loading…</Text>
      ) : null}
      {error ? (
        <Text style={[styles.hint, { color: theme.colors.statusDanger }]}>{error}</Text>
      ) : null}
      {(data?.entries ?? []).slice(0, 100).map((entry) => (
        <Pressable
          key={entry.path}
          style={styles.browserRow}
          onPress={() => (entry.kind === "directory" ? setDir(entry.path) : onPick(entry.path))}
        >
          <Text style={[styles.chipText, { color: foreground, fontSize: font(11) }]} numberOfLines={1}>
            {entry.kind === "directory" ? "📁" : "📄"} {entry.name}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 4 },
  browser: { borderWidth: 1, borderRadius: 8, padding: 6, marginTop: 6, gap: 2 },
  browserRow: { paddingVertical: 3, paddingHorizontal: 2 },
  browserPath: { flex: 1 },
  grow: { flex: 1, minWidth: 180 },
  title: { fontSize: 16, fontWeight: "700" },
  subtitle: { fontSize: 12, opacity: 0.6, marginBottom: 6 },
  label: { marginTop: 10, fontSize: 12, opacity: 0.7 },
  field: { marginTop: 8 },
  fieldLabel: { fontSize: 12, opacity: 0.7, marginBottom: 3 },
  group: { marginTop: 4 },
  groupLabel: { fontSize: 11, opacity: 0.7, marginBottom: 2 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.4)",
    maxWidth: 220,
  },
  chipActive: { backgroundColor: "rgba(90,140,255,0.25)", borderColor: "rgba(90,140,255,0.8)" },
  chipText: { fontSize: 12 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  check: { fontSize: 14 },
  checkLabel: { fontSize: 13 },
  input: {
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.4)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  previewBox: {
    marginTop: 10,
    borderRadius: 8,
    backgroundColor: "rgba(128,128,128,0.12)",
    padding: 10,
  },
  previewLabel: { fontSize: 11, opacity: 0.6, marginBottom: 2 },
  previewText: { fontSize: 12, fontFamily: "monospace" },
  hint: { fontSize: 11, opacity: 0.7, marginTop: 2 },
  resultLine: { fontSize: 12, marginTop: 2 },
  button: {
    flex: 1,
    marginTop: 12,
    backgroundColor: "rgba(90,140,255,0.9)",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.5 },
  secondaryButton: { backgroundColor: "rgba(128,128,128,0.3)" },
  scheduleButton: { backgroundColor: "rgba(90,140,255,0.45)" },
  buttonText: { color: "white", fontWeight: "600" },
});
