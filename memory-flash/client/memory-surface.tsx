import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  deleteMemory,
  delegateTask,
  getMemory,
  installSkill,
  listMemories,
  listRemoteHosts,
  listTags,
  memoryStats,
  purgeMemories,
  restoreRevision,
  saveMemory,
  saveRemoteHost,
  searchMemories,
  deleteRemoteHost,
  checkRemoteHost,
  skillStatus,
} from "../shared/memories";
import type { Memory, MemoryKind, RemoteHost, SkillStatusTarget } from "../shared/memories";
import { interfaceFontFamily, monoFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

type Tab = "memories" | "history" | "hosts";

const KINDS: MemoryKind[] = ["decision", "procedure", "handoff", "bugfix", "pattern", "pitfall", "reference", "note"];

/** A skill status row as returned by the RPC (SkillStatusTarget). */
type SkillRow = SkillStatusTarget;

export function MemorySurface({ theme }: PluginSurfaceProps) {
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const mono = monoFontFamily(typography);
  const uiFontStyle = uiFont ? { fontFamily: uiFont } : null;
  const monoStyle = mono ? { fontFamily: mono } : null;
  const fg = theme.colors.foreground;
  const fgMuted = theme.colors.foregroundMuted;
  const border = theme.colors.border;
  const accent = theme.colors.accent;
  const danger = theme.colors.statusDanger;

  const listRpc = useRpc(listMemories);
  const searchRpc = useRpc(searchMemories);
  const tagsRpc = useRpc(listTags);
  const statsRpc = useRpc(memoryStats);
  const saveRpc = useRpc(saveMemory);
  const deleteRpc = useRpc(deleteMemory);
  const getRpc = useRpc(getMemory);
  const restoreRpc = useRpc(restoreRevision);
  const purgeRpc = useRpc(purgeMemories);
  const delegateRpc = useRpc(delegateTask);
  const paseo = usePaseo();
  const skillStatusRpc = useRpc(skillStatus);
  const skillInstallRpc = useRpc(installSkill);
  const hostsRpc = useRpc(listRemoteHosts);
  const hostSaveRpc = useRpc(saveRemoteHost);
  const hostDeleteRpc = useRpc(deleteRemoteHost);
  const hostCheckRpc = useRpc(checkRemoteHost);

  const [tab, setTab] = useState<Tab>("memories");
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  // --- memories tab state ---
  const [query, setQuery] = useState("");
  const [activeKind, setActiveKind] = useState<MemoryKind | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [searchResults, setSearchResults] = useState<Array<{ memory: Memory; snippet: string | null }>>([]);
  const [loading, setLoading] = useState(true);

  // --- editor state ---
  const [editing, setEditing] = useState<Memory | null>(null);
  const [creating, setCreating] = useState(false);
  const [editKind, setEditKind] = useState<MemoryKind>("note");
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editProject, setEditProject] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  // --- history viewer state ---
  const [viewingId, setViewingId] = useState<number | null>(null);
  const [viewingMemory, setViewingMemory] = useState<Memory | null>(null);
  const [viewingHistory, setViewingHistory] = useState<Array<{ id: number; revision: number; title: string; changedAt: string; changedBy: string | null; changeKind: string }>>([]);

  // --- delegation state ---
  const [delegateAgent, setDelegateAgent] = useState("");
  const [delegateInstruction, setDelegateInstruction] = useState("");
  const [delegateMessage, setDelegateMessage] = useState<string | null>(null);
  const [agentOptions, setAgentOptions] = useState<Array<{ id: string; label: string }>>([]);

  // Live agent list from Paseo (requirement 9: deep integration) — fills the
  // delegation picker with open agents and their provider/title.
  useEffect(() => {
    if (tab !== "history") return;
    let cancelled = false;
    void paseo.agents
      .list()
      .then((result) => {
        if (cancelled) return;
        const options: Array<{ id: string; label: string }> = [];
        for (const entry of result.entries) {
          const record = entry as unknown as {
            id?: string;
            title?: string | null;
            provider?: string;
            status?: string;
            archivedAt?: string | null;
          };
          if (!record.id) continue;
          if (record.archivedAt) continue;
          if (record.status === "closed") continue;
          options.push({ id: record.id, label: record.title || `${record.provider ?? "agent"} · ${record.id.slice(0, 8)}` });
        }
        setAgentOptions(options);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tab, reloadKey, paseo]);

  // --- hosts tab state ---
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [hostName, setHostName] = useState("");
  const [hostAddress, setHostAddress] = useState("");
  const [hostUser, setHostUser] = useState("");
  const [hostPort, setHostPort] = useState("22");
  const [hostMessage, setHostMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const effectiveQuery = query.trim();
    const work = effectiveQuery.length > 0
      ? searchRpc({
          query: effectiveQuery,
          tags: activeTag ? [activeTag] : [],
          kinds: activeKind ? [activeKind] : [],
          project: null,
          agentId: null,
          tagMode: "any",
          limit: 30,
        }).then((result) => {
          if (!cancelled) {
            setSearchResults(result.results.map((entry) => ({ memory: entry.memory, snippet: entry.snippet })));
            setMemories([]);
          }
        })
      : listRpc({
          query: "",
          tags: activeTag ? [activeTag] : [],
          kinds: activeKind ? [activeKind] : [],
          project: null,
          agentId: null,
          tagMode: "any",
          limit: 50,
          offset: 0,
        }).then((result) => {
          if (!cancelled) {
            setMemories(result.memories);
            setSearchResults([]);
          }
        });
    void work
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, query, activeKind, activeTag, listRpc, searchRpc]);

  useEffect(() => {
    if (tab !== "hosts") return;
    void hostsRpc({}).then((result) => setHosts(result.hosts)).catch(() => undefined);
  }, [tab, reloadKey, hostsRpc]);

  const refreshTags = useCallback(() => {
    void tagsRpc({}).catch(() => undefined);
  }, [tagsRpc]);

  const openEditor = (memory: Memory | null) => {
    setCreating(memory === null);
    setEditing(memory);
    setSaveError(null);
    setEditKind(memory?.kind ?? "note");
    setEditTitle(memory?.title ?? "");
    setEditContent(memory?.content ?? "");
    setEditTags(memory?.tags.join(", ") ?? "");
    setEditProject(memory?.project ?? "");
  };

  const closeEditor = () => {
    setEditing(null);
    setCreating(false);
    setSaveError(null);
  };

  const submitEditor = async () => {
    if (editTitle.trim().length === 0 || editContent.trim().length === 0) {
      setSaveError("Title and content are required.");
      return;
    }
    const input = {
      kind: editKind,
      title: editTitle.trim(),
      content: editContent,
      tags: editTags.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0),
      project: editProject.trim() || null,
      agentId: editing?.agentId ?? null,
      changedBy: "paseo-ui",
    };
    const result = await saveRpc(editing ? { id: editing.id, input } : { input }).catch(
      (cause: unknown) => null,
    );
    if (!result || !result.ok) {
      setSaveError(result?.error ?? "Save failed.");
      return;
    }
    closeEditor();
    refreshTags();
    reload();
  };

  const removeMemory = async (memory: Memory) => {
    await deleteRpc({ id: memory.id }).catch(() => undefined);
    refreshTags();
    reload();
  };

  const openHistory = async (memory: Memory) => {
    const result = await getRpc({ id: memory.id }).catch(() => null);
    if (!result) return;
    setViewingMemory(result.memory);
    setViewingHistory(result.history);
    setViewingId(memory.id);
  };

  const restore = async (revisionId: number) => {
    await restoreRpc({ revisionId }).catch(() => undefined);
    if (viewingId !== null) {
      const result = await getRpc({ id: viewingId }).catch(() => null);
      if (result) {
        setViewingMemory(result.memory);
        setViewingHistory(result.history);
      }
    }
    refreshTags();
    reload();
  };

  const sendDelegation = async () => {
    setDelegateMessage(null);
    if (delegateAgent.trim().length === 0 || delegateInstruction.trim().length === 0) {
      setDelegateMessage("Agent id and instruction are required.");
      return;
    }
    const result = await delegateRpc({
      agentId: delegateAgent.trim(),
      instruction: delegateInstruction.trim(),
      memoryIds: viewingId !== null ? [viewingId] : [],
    }).catch((cause: unknown) => null);
    setDelegateMessage(result?.ok ? "Task sent to the agent." : (result?.error ?? "Delegation failed."));
    if (result?.ok) setDelegateInstruction("");
  };

  const addHost = async () => {
    setHostMessage(null);
    if (hostName.trim().length === 0 || hostAddress.trim().length === 0) {
      setHostMessage("Name and host are required.");
      return;
    }
    const port = Number.parseInt(hostPort, 10);
    const result = await hostSaveRpc({
      host: {
        id: "",
        name: hostName.trim(),
        transport: "paseo-ssh",
        host: hostAddress.trim(),
        port: Number.isFinite(port) && port > 0 ? port : 22,
        user: hostUser.trim(),
        enabled: true,
      },
    }).catch(() => null);
    if (!result || !result.ok) {
      setHostMessage(result?.error ?? "Save failed.");
      return;
    }
    setHostName("");
    setHostAddress("");
    setHostUser("");
    setHostPort("22");
    reload();
  };

  const checkHost = async (host: RemoteHost) => {
    const result = await hostCheckRpc({ id: host.id }).catch(() => null);
    if (!result) return;
    setHostMessage(
      result.ok
        ? `${host.name}: reachable. Remote memory DB: ${result.remoteDbPath}`
        : `${host.name}: ${result.status} — ${result.error ?? "unreachable"}`,
    );
    reload();
  };

  const removeHost = async (host: RemoteHost) => {
    await hostDeleteRpc({ id: host.id }).catch(() => undefined);
    reload();
  };

  const installSkillFor = async (row: SkillRow) => {
    await skillInstallRpc({ targetId: row.id }).catch(() => undefined);
    reload();
  };

  const stats = statsRpc;

  const rows: Array<{ memory: Memory; snippet: string | null }> =
    searchResults.length > 0
      ? searchResults
      : memories.map((memory) => ({ memory, snippet: null }));

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "memories", label: "Memories" },
    { id: "history", label: "History & tasks" },
    { id: "hosts", label: "Remote hosts" },
  ];

  return (
    <View style={styles.container}>
      <View style={[styles.tabRow, { borderBottomColor: border }]}>
        {tabs.map((entry) => (
          <Pressable key={entry.id} onPress={() => setTab(entry.id)} style={styles.tabButton}>
            <Text
              style={[
                styles.tabText,
                { color: tab === entry.id ? accent : fgMuted, fontSize: font(13) },
                uiFontStyle,
              ]}
            >
              {entry.label}
            </Text>
          </Pressable>
        ))}
        <View style={styles.spacer} />
        <Pressable onPress={() => openEditor(null)} style={[styles.smallButton, { borderColor: accent }]}>
          <Text style={{ color: accent, fontSize: font(12), ...uiFontStyle }}>+ New memory</Text>
        </Pressable>
      </View>

      {tab === "memories" ? (
        <View style={styles.flex}>
          <View style={styles.controls}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search memories…"
              placeholderTextColor={fgMuted}
              style={[styles.input, { borderColor: border, color: fg, fontSize: font(13) }, uiFontStyle]}
            />
          </View>
          <View style={styles.chipRow}>
            <Chip label="All" active={activeKind === null} onPress={() => setActiveKind(null)} color={accent} fg={fg} font={font} uiFontStyle={uiFontStyle} />
            {KINDS.map((kind) => (
              <Chip key={kind} label={kind} active={activeKind === kind} onPress={() => setActiveKind(kind)} color={accent} fg={fg} font={font} uiFontStyle={uiFontStyle} />
            ))}
          </View>
          <TagRow tagsRpc={tagsRpc} activeTag={activeTag} onSelect={setActiveTag} accent={accent} fg={fg} font={font} uiFontStyle={uiFontStyle} />
          {loading ? (
            <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 8, ...uiFontStyle }}>Loading…</Text>
          ) : rows.length === 0 ? (
            <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 8, ...uiFontStyle }}>No memories yet. Agents write here through the memory-flash MCP tools.</Text>
          ) : (
            <ScrollView style={styles.flex}>
              {rows.map(({ memory, snippet }) => (
                <View key={memory.id} style={[styles.card, { borderColor: border }]}>
                  <Text style={[{ color: fg, fontSize: font(14), fontWeight: "600" as const }, uiFontStyle]}>
                    #{memory.id} [{memory.kind}] {memory.title}
                  </Text>
                  <Text style={{ color: fgMuted, fontSize: font(11), marginTop: 2, ...uiFontStyle }}>
                    {memory.project ? `${memory.project} · ` : ""}
                    {memory.agentId ? `${memory.agentId} · ` : ""}
                    rev {memory.revision} · {memory.updatedAt}
                  </Text>
                  {memory.tags.length > 0 ? (
                    <Text style={{ color: accent, fontSize: font(11), marginTop: 2, ...uiFontStyle }}>{memory.tags.join(" · ")}</Text>
                  ) : null}
                  <Text style={[{ color: fgMuted, fontSize: font(12), marginTop: 4 }, monoStyle]} numberOfLines={snippet ? 4 : 3}>
                    {snippet ?? memory.content}
                  </Text>
                  <View style={styles.cardActions}>
                    <ActionButton label="Open" onPress={() => void openHistory(memory)} accent={accent} font={font} uiFontStyle={uiFontStyle} />
                    <ActionButton label="Edit" onPress={() => openEditor(memory)} accent={accent} font={font} uiFontStyle={uiFontStyle} />
                    <ActionButton label="Delete" onPress={() => void removeMemory(memory)} accent={danger} font={font} uiFontStyle={uiFontStyle} />
                  </View>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      ) : null}

      {tab === "history" ? (
        <ScrollView style={styles.flex}>
          <Text style={[styles.sectionTitle, { color: fg, fontSize: font(15) }, uiFontStyle]}>Memory history</Text>
          <Text style={{ color: fgMuted, fontSize: font(12), ...uiFontStyle }}>
            Every change (create/update/delete) is kept per memory. Open a memory from the Memories tab to view and restore its revisions.
          </Text>
          <Text style={[styles.sectionTitle, { color: fg, fontSize: font(15), marginTop: 16 }, uiFontStyle]}>Statistics</Text>
          <StatsView stats={stats} fg={fg} fgMuted={fgMuted} font={font} uiFontStyle={uiFontStyle} />
          <Text style={[styles.sectionTitle, { color: fg, fontSize: font(15), marginTop: 16 }, uiFontStyle]}>Delegate a maintenance task</Text>
          <Text style={{ color: fgMuted, fontSize: font(12), ...uiFontStyle }}>
            Give a running agent a task to clean up or reorganize memories through its MCP tools (e.g. "merge duplicate auth notes, delete outdated ones").
          </Text>
          {agentOptions.length > 0 ? (
            <View style={styles.chipRow}>
              {agentOptions.slice(0, 8).map((option) => (
                <Chip
                  key={option.id}
                  label={option.label}
                  active={delegateAgent === option.id}
                  onPress={() => setDelegateAgent(option.id)}
                  color={accent}
                  fg={fg}
                  font={font}
                  uiFontStyle={uiFontStyle}
                />
              ))}
            </View>
          ) : null}
          <TextInput
            value={delegateAgent}
            onChangeText={setDelegateAgent}
            placeholder="Agent id (pick above or paste)"
            placeholderTextColor={fgMuted}
            style={[styles.input, { borderColor: border, color: fg, fontSize: font(13), marginTop: 8 }, uiFontStyle]}
          />
          <TextInput
            value={delegateInstruction}
            onChangeText={setDelegateInstruction}
            placeholder="What should the agent do with the memories?"
            placeholderTextColor={fgMuted}
            multiline
            style={[styles.input, styles.multiline, { borderColor: border, color: fg, fontSize: font(13) }, uiFontStyle]}
          />
          <Pressable onPress={() => void sendDelegation()} style={[styles.primaryButton, { backgroundColor: accent }]}>
            <Text style={{ color: theme.colors.accentForeground, fontSize: font(13), ...uiFontStyle }}>Send task to agent</Text>
          </Pressable>
          {delegateMessage ? <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 4, ...uiFontStyle }}>{delegateMessage}</Text> : null}
        </ScrollView>
      ) : null}

      {tab === "hosts" ? (
        <ScrollView style={styles.flex}>
          <Text style={[styles.sectionTitle, { color: fg, fontSize: font(15) }, uiFontStyle]}>Remote Paseo hosts</Text>
          <Text style={{ color: fgMuted, fontSize: font(12), ...uiFontStyle }}>
            Connect to remote machines running the Paseo server over the standard Paseo SSH transport. Each host keeps its own shared memory database (~/.paseo/plugins/memory-flash/memory.db). TCP and relay transports are stubs for future work.
          </Text>
          {hosts.map((host) => (
            <View key={host.id} style={[styles.card, { borderColor: border }]}>
              <Text style={{ color: fg, fontSize: font(13), ...uiFontStyle }}>
                {host.name} — {host.transport} · {host.user ? `${host.user}@` : ""}{host.host}:{host.port}
              </Text>
              <Text style={{ color: host.status === "ok" ? theme.colors.statusSuccess : host.status === "error" ? danger : fgMuted, fontSize: font(11), marginTop: 2, ...uiFontStyle }}>
                {host.status}{host.lastError ? ` — ${host.lastError}` : ""}
              </Text>
              <View style={styles.cardActions}>
                <ActionButton label="Check" onPress={() => void checkHost(host)} accent={accent} font={font} uiFontStyle={uiFontStyle} />
                <ActionButton label="Remove" onPress={() => void removeHost(host)} accent={danger} font={font} uiFontStyle={uiFontStyle} />
              </View>
            </View>
          ))}
          <Text style={[styles.sectionTitle, { color: fg, fontSize: font(14), marginTop: 12 }, uiFontStyle]}>Add host (Paseo SSH)</Text>
          <View style={styles.hostFormRow}>
            <TextInput value={hostName} onChangeText={setHostName} placeholder="Name" placeholderTextColor={fgMuted} style={[styles.input, styles.flex, { borderColor: border, color: fg, fontSize: font(13) }, uiFontStyle]} />
            <TextInput value={hostAddress} onChangeText={setHostAddress} placeholder="Host / IP" placeholderTextColor={fgMuted} style={[styles.input, styles.flex, { borderColor: border, color: fg, fontSize: font(13) }, uiFontStyle]} />
          </View>
          <View style={styles.hostFormRow}>
            <TextInput value={hostUser} onChangeText={setHostUser} placeholder="SSH user (optional)" placeholderTextColor={fgMuted} style={[styles.input, styles.flex, { borderColor: border, color: fg, fontSize: font(13) }, uiFontStyle]} />
            <TextInput value={hostPort} onChangeText={setHostPort} placeholder="22" placeholderTextColor={fgMuted} style={[styles.input, styles.hostPort, { borderColor: border, color: fg, fontSize: font(13) }, uiFontStyle]} />
          </View>
          <Pressable onPress={() => void addHost()} style={[styles.primaryButton, { backgroundColor: accent }]}>
            <Text style={{ color: theme.colors.accentForeground, fontSize: font(13), ...uiFontStyle }}>Add host</Text>
          </Pressable>
          {hostMessage ? <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 4, ...uiFontStyle }}>{hostMessage}</Text> : null}
        </ScrollView>
      ) : null}

      {/* Editor modal */}
      {(creating || editing !== null) ? (
        <View style={[styles.modalBackdrop]}>
          <View style={[styles.modal, { backgroundColor: theme.colors.surface1, borderColor: border }]}>
            <Text style={{ color: fg, fontSize: font(15), fontWeight: "600" as const, ...uiFontStyle }}>
              {creating ? "New memory" : `Edit memory #${editing?.id}`}
            </Text>
            <View style={styles.chipRow}>
              {KINDS.map((kind) => (
                <Chip key={kind} label={kind} active={editKind === kind} onPress={() => setEditKind(kind)} color={accent} fg={fg} font={font} uiFontStyle={uiFontStyle} />
              ))}
            </View>
            <TextInput value={editTitle} onChangeText={setEditTitle} placeholder="Title" placeholderTextColor={fgMuted} style={[styles.input, { borderColor: border, color: fg, fontSize: font(13) }, uiFontStyle]} />
            <TextInput value={editContent} onChangeText={setEditContent} placeholder="Content" placeholderTextColor={fgMuted} multiline style={[styles.input, styles.multiline, { borderColor: border, color: fg, fontSize: font(13) }, monoStyle]} />
            <TextInput value={editTags} onChangeText={setEditTags} placeholder="tags, comma-separated" placeholderTextColor={fgMuted} style={[styles.input, { borderColor: border, color: fg, fontSize: font(13) }, uiFontStyle]} />
            <TextInput value={editProject} onChangeText={setEditProject} placeholder="Project (optional)" placeholderTextColor={fgMuted} style={[styles.input, { borderColor: border, color: fg, fontSize: font(13) }, uiFontStyle]} />
            {saveError ? <Text style={{ color: danger, fontSize: font(12), ...uiFontStyle }}>{saveError}</Text> : null}
            <View style={styles.cardActions}>
              <Pressable onPress={() => void submitEditor()} style={[styles.primaryButton, { backgroundColor: accent }]}>
                <Text style={{ color: theme.colors.accentForeground, fontSize: font(13), ...uiFontStyle }}>Save</Text>
              </Pressable>
              <Pressable onPress={closeEditor} style={[styles.smallButton, { borderColor: border }]}>
                <Text style={{ color: fgMuted, fontSize: font(13), ...uiFontStyle }}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {/* History viewer modal */}
      {viewingId !== null && viewingMemory !== null ? (
        <View style={styles.modalBackdrop}>
          <View style={[styles.modal, styles.modalWide, { backgroundColor: theme.colors.surface1, borderColor: border }]}>
            <Text style={{ color: fg, fontSize: font(15), fontWeight: "600" as const, ...uiFontStyle }}>
              #{viewingMemory.id} [{viewingMemory.kind}] {viewingMemory.title}
            </Text>
            <Text style={[{ color: fgMuted, fontSize: font(12), marginTop: 4 }, monoStyle]}>{viewingMemory.content}</Text>
            <Text style={[styles.sectionTitle, { color: fg, fontSize: font(14), marginTop: 12 }, uiFontStyle]}>Revisions</Text>
            <ScrollView style={styles.flex}>
              {viewingHistory.map((entry) => (
                <View key={entry.id} style={[styles.historyRow, { borderColor: border }]}>
                  <Text style={{ color: fg, fontSize: font(12), ...uiFontStyle }}>
                    rev {entry.revision} · {entry.changeKind} · {entry.changedAt}{entry.changedBy ? ` · ${entry.changedBy}` : ""}
                  </Text>
                  <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>{entry.title}</Text>
                  <ActionButton label="Restore" onPress={() => void restore(entry.id)} accent={accent} font={font} uiFontStyle={uiFontStyle} />
                </View>
              ))}
              {viewingHistory.length === 0 ? (
                <Text style={{ color: fgMuted, fontSize: font(12), ...uiFontStyle }}>No revisions recorded yet.</Text>
              ) : null}
            </ScrollView>
            <Pressable onPress={() => setViewingId(null)} style={[styles.smallButton, { borderColor: border, alignSelf: "flex-end" }]}>
              <Text style={{ color: fgMuted, fontSize: font(13), ...uiFontStyle }}>Close</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Chip({ label, active, onPress, color, fg, font, uiFontStyle }: {
  label: string;
  active: boolean;
  onPress: () => void;
  color: string;
  fg: string;
  font: (base: number) => number;
  uiFontStyle: { fontFamily: string } | null;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active ? { borderColor: color } : null]}>
      <Text style={{ color: active ? color : fg, fontSize: font(11), ...uiFontStyle }}>{label}</Text>
    </Pressable>
  );
}

function ActionButton({ label, onPress, accent, font, uiFontStyle }: {
  label: string;
  onPress: () => void;
  accent: string;
  font: (base: number) => number;
  uiFontStyle: { fontFamily: string } | null;
}) {
  return (
    <Pressable onPress={onPress} style={styles.actionButton}>
      <Text style={{ color: accent, fontSize: font(12), ...uiFontStyle }}>{label}</Text>
    </Pressable>
  );
}

function TagRow({ tagsRpc, activeTag, onSelect, accent, fg, font, uiFontStyle }: {
  tagsRpc: (input: Record<string, never>) => Promise<{ tags: Array<{ tag: string; count: number }> }>;
  activeTag: string | null;
  onSelect: (tag: string | null) => void;
  accent: string;
  fg: string;
  font: (base: number) => number;
  uiFontStyle: { fontFamily: string } | null;
}) {
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  useEffect(() => {
    void tagsRpc({}).then((result) => setTags(result.tags)).catch(() => undefined);
  }, [tagsRpc]);
  if (tags.length === 0) return null;
  return (
    <View style={styles.chipRow}>
      {tags.slice(0, 16).map((entry) => (
        <Chip
          key={entry.tag}
          label={`${entry.tag} (${entry.count})`}
          active={activeTag === entry.tag}
          onPress={() => onSelect(activeTag === entry.tag ? null : entry.tag)}
          color={accent}
          fg={fg}
          font={font}
          uiFontStyle={uiFontStyle}
        />
      ))}
    </View>
  );
}

function StatsView({ stats, fg, fgMuted, font, uiFontStyle }: {
  stats: (input: Record<string, never>) => Promise<{
    total: number;
    byKind: Array<{ kind: string; count: number }>;
    byAgent: Array<{ agentId: string; count: number }>;
    byProject: Array<{ project: string; count: number }>;
    topTags: Array<{ tag: string; count: number }>;
    dbSizeBytes: number;
  }>;
  fg: string;
  fgMuted: string;
  font: (base: number) => number;
  uiFontStyle: { fontFamily: string } | null;
}) {
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof stats>> | null>(null);
  useEffect(() => {
    void stats({}).then(setSnapshot).catch(() => undefined);
  }, [stats]);
  if (!snapshot) return null;
  return (
    <View>
      <Text style={{ color: fg, fontSize: font(13), ...uiFontStyle }}>
        {snapshot.total} memories · {(snapshot.dbSizeBytes / 1024).toFixed(1)} KiB
      </Text>
      <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 2, ...uiFontStyle }}>
        Kinds: {snapshot.byKind.map((entry) => `${entry.kind} (${entry.count})`).join(", ") || "—"}
      </Text>
      {snapshot.byAgent.length > 0 ? (
        <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 2, ...uiFontStyle }}>
          Agents: {snapshot.byAgent.map((entry) => `${entry.agentId} (${entry.count})`).join(", ")}
        </Text>
      ) : null}
      {snapshot.byProject.length > 0 ? (
        <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 2, ...uiFontStyle }}>
          Projects: {snapshot.byProject.map((entry) => `${entry.project} (${entry.count})`).join(", ")}
        </Text>
      ) : null}
      <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 2, ...uiFontStyle }}>
        Top tags: {snapshot.topTags.slice(0, 10).map((entry) => `${entry.tag} (${entry.count})`).join(", ") || "—"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12 },
  flex: { flex: 1 },
  spacer: { flex: 1 },
  tabRow: { flexDirection: "row", alignItems: "center", borderBottomWidth: 1, paddingBottom: 6, gap: 12 },
  tabButton: { paddingVertical: 4 },
  tabText: { fontWeight: "600" },
  controls: { marginTop: 8 },
  input: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6 },
  multiline: { minHeight: 72, textAlignVertical: "top" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, borderColor: "transparent" },
  card: { borderWidth: 1, borderRadius: 8, padding: 10, marginTop: 8 },
  cardActions: { flexDirection: "row", gap: 14, marginTop: 6 },
  actionButton: { paddingVertical: 2 },
  smallButton: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  primaryButton: { borderRadius: 6, paddingHorizontal: 12, paddingVertical: 7, marginTop: 8, alignSelf: "flex-start" },
  sectionTitle: { fontWeight: "600", marginBottom: 4 },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", padding: 16 },
  modal: { width: "100%", maxWidth: 560, maxHeight: "85%", borderWidth: 1, borderRadius: 10, padding: 14 },
  modalWide: { maxHeight: "90%" },
  historyRow: { borderTopWidth: 1, paddingVertical: 6, gap: 2 },
  hostFormRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  hostPort: { maxWidth: 80 },
});
