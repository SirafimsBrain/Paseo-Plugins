import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings, useRpc } from "@getpaseo/plugin/client";
import { memoryFlashSettings } from "../shared/settings";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  clineMcpStatus,
  codexMcpStatus,
  generateApiKey,
  httpStatus,
  listApiKeys,
  registerCodexMcp,
  unregisterCodexMcp,
  cursorMcpStatus,
  registerCursorMcp,
  unregisterCursorMcp,
  installSkill,
  memoryStats,
  purgeMemories,
  registerAllAgentMcp,
  registerClineMcp,
  revokeApiKey,
  skillPreview,
  skillStatus,
  unregisterClineMcp,
  uninstallSkill,
} from "../shared/memories";
import type { ApiKey, ApiKeyScope, HttpStatus } from "../shared/memories";
import { interfaceFontFamily, monoFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

/**
 * Plugin settings screen (Paseo Settings → Plugins → Memory Flash).
 *
 * Sections:
 * - Integration: MCP injection into Paseo-created agents.
 * - Skill (requirement 6): install the memory skill into every connected
 *   agent family with one click, per target.
 * - Database: stats and a guarded purge.
 */

type SkillRow = {
  id: string;
  label: string;
  path: string;
  detected: boolean;
  installed: boolean;
  upToDate: boolean | null;
};

/**
 * True while a restart triggered by the host/port inputs is still in flight —
 * the settings value has moved on, the live socket has not caught up yet.
 */
function httpRestartPending(status: HttpStatus): boolean {
  return (
    status.boundHost !== status.host.trim() || status.boundPort !== status.port
  );
}

type AgentMcpStatus = {
  path: string;
  detected: boolean;
  installed: boolean;
  upToDate: boolean | null;
  command: string | null;
  args: string[] | null;
  /** Live spawn check (Cline only). */
  live?: boolean | null;
};

type AgentMcpAgent = {
  id: string;
  label: string;
  register: (input: Record<string, never>) => Promise<{ ok: boolean; error: string | null } | null>;
  unregister: (input: Record<string, never>) => Promise<{ ok: boolean; error: string | null } | null>;
};

export function MemoryFlashSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(memoryFlashSettings);
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const uiFontStyle = uiFont ? { fontFamily: uiFont } : null;
  const mono = monoFontFamily(typography);
  const monoStyle = mono ? { fontFamily: mono } : null;
  const fg = theme.colors.foreground;
  const fgMuted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;
  const danger = theme.colors.statusDanger;
  const border = theme.colors.border;

  const skillStatusRpc = useRpc(skillStatus);
  const skillInstallRpc = useRpc(installSkill);
  const skillUninstallRpc = useRpc(uninstallSkill);
  const statsRpc = useRpc(memoryStats);
  const purgeRpc = useRpc(purgeMemories);
  const skillPreviewRpc = useRpc(skillPreview);
  const clineStatusRpc = useRpc(clineMcpStatus);
  const clineRegisterRpc = useRpc(registerClineMcp);
  const clineUnregisterRpc = useRpc(unregisterClineMcp);
  const cursorStatusRpc = useRpc(cursorMcpStatus);
  const cursorRegisterRpc = useRpc(registerCursorMcp);
  const cursorUnregisterRpc = useRpc(unregisterCursorMcp);
  const codexStatusRpc = useRpc(codexMcpStatus);
  const codexRegisterRpc = useRpc(registerCodexMcp);
  const codexUnregisterRpc = useRpc(unregisterCodexMcp);
  const registerAllRpc = useRpc(registerAllAgentMcp);
  const apiKeysRpc = useRpc(listApiKeys);
  const generateKeyRpc = useRpc(generateApiKey);
  const revokeKeyRpc = useRpc(revokeApiKey);
  const httpStatusRpc = useRpc(httpStatus);

  const agentMcpAgents: AgentMcpAgent[] = [
    {
      id: "cline",
      label: "Cline",
      register: clineRegisterRpc,
      unregister: clineUnregisterRpc,
    },
    {
      id: "cursor",
      label: "Cursor",
      register: cursorRegisterRpc,
      unregister: cursorUnregisterRpc,
    },
    {
      id: "codex",
      label: "Codex CLI",
      register: codexRegisterRpc,
      unregister: codexUnregisterRpc,
    },
  ];

  const [skillDoc, setSkillDoc] = useState<string>("");
  useEffect(() => {
    void skillPreviewRpc({}).then((result) => setSkillDoc(result.markdown)).catch(() => undefined);
  }, [skillPreviewRpc]);

  const [skillRows, setSkillRows] = useState<SkillRow[]>([]);
  const [skillMessage, setSkillMessage] = useState<string | null>(null);
  const [agentMcps, setAgentMcps] = useState<Record<string, AgentMcpStatus | null>>({});
  const [agentMcpMessage, setAgentMcpMessage] = useState<string | null>(null);
  const [dbSummary, setDbSummary] = useState<string | null>(null);
  const [purgeTag, setPurgeTag] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  // --- remote access (HTTP endpoint + API keys) ---
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [http, setHttp] = useState<HttpStatus | null>(null);
  const [keyLabel, setKeyLabel] = useState("");
  const [keyTtl, setKeyTtl] = useState("0");
  const [keyScope, setKeyScope] = useState<ApiKeyScope>("read_write");
  const [remoteMessage, setRemoteMessage] = useState<string | null>(null);
  /** Secret shown exactly once, right after generation. */
  const [revealed, setRevealed] = useState<{ url: string; secret: string; label: string } | null>(null);

  const reloadSkills = useCallback(() => {
    void skillStatusRpc({}).then((result) => setSkillRows(result.targets)).catch(() => undefined);
  }, [skillStatusRpc]);

  const reloadAgentMcps = useCallback(() => {
    void Promise.all([clineStatusRpc({}), cursorStatusRpc({}), codexStatusRpc({})])
      .then(([cline, cursor, codex]) => setAgentMcps({ cline, cursor, codex }))
      .catch(() => undefined);
  }, [clineStatusRpc, cursorStatusRpc, codexStatusRpc]);

  const reloadRemoteAccess = useCallback(() => {
    void apiKeysRpc({}).then((result) => setApiKeys(result.keys)).catch(() => undefined);
    void httpStatusRpc({}).then(setHttp).catch(() => undefined);
  }, [apiKeysRpc, httpStatusRpc]);

  // Host and port are patched per keystroke, so each edit used to queue its own
  // 400 ms status poll — typing "0.0.0.0" fired seven. One debounced reload
  // per burst keeps the status line in step with the last value.
  const remoteAccessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRemoteAccessReload = useCallback(() => {
    if (remoteAccessTimer.current !== null) clearTimeout(remoteAccessTimer.current);
    remoteAccessTimer.current = setTimeout(() => {
      remoteAccessTimer.current = null;
      reloadRemoteAccess();
    }, 400);
  }, [reloadRemoteAccess]);

  useEffect(
    () => () => {
      if (remoteAccessTimer.current !== null) clearTimeout(remoteAccessTimer.current);
    },
    [],
  );

  useEffect(() => {
    reloadSkills();
    reloadAgentMcps();
    reloadRemoteAccess();
    void statsRpc({}).then((snapshot) => {
      setDbSummary(`${snapshot.total} memories · ${(snapshot.dbSizeBytes / 1024).toFixed(1)} KiB`);
    }).catch(() => undefined);
  }, [reloadSkills, reloadAgentMcps, reloadRemoteAccess, statsRpc]);

  if (settings.status === "loading") {
    return (
      <View style={styles.container}>
        <Text style={{ color: fg, fontSize: font(13), ...uiFontStyle }}>Loading settings…</Text>
      </View>
    );
  }
  if (settings.status !== "ready") {
    return (
      <View style={styles.container}>
        <Text style={{ color: danger, fontSize: font(12) }}>Settings are invalid: {settings.error}</Text>
        <Pressable onPress={() => void settings.reset()}>
          <Text style={{ color: accent, fontSize: font(12), textDecorationLine: "underline" }}>Reset to defaults</Text>
        </Pressable>
      </View>
    );
  }

  const values = settings.values;
  const patch = (partial: Partial<typeof values>) => {
    void settings.save({ ...values, ...partial }, settings.revision);
  };

  const install = async (row: SkillRow) => {
    setSkillMessage(null);
    const result = await skillInstallRpc({ targetId: row.id }).catch(() => null);
    setSkillMessage(result?.ok ? `Skill installed: ${result.path}` : (result?.error ?? "Install failed."));
    reloadSkills();
  };

  const uninstall = async (row: SkillRow) => {
    setSkillMessage(null);
    const result = await skillUninstallRpc({ targetId: row.id }).catch(() => null);
    setSkillMessage(result?.ok ? `Skill removed from ${row.label}.` : (result?.error ?? "Uninstall failed."));
    reloadSkills();
  };

  const installAll = async () => {
    setSkillMessage(null);
    const failures: string[] = [];
    for (const row of skillRows) {
      const result = await skillInstallRpc({ targetId: row.id }).catch(() => null);
      if (!result?.ok) failures.push(row.label);
    }
    setSkillMessage(
      failures.length === 0
        ? "Skill installed into every detected agent location."
        : `Installed with failures: ${failures.join(", ")}`,
    );
    reloadSkills();
  };

  const registerAgentMcp = async (agent: AgentMcpAgent) => {
    setAgentMcpMessage(null);
    const result = await agent.register({}).catch(() => null);
    setAgentMcpMessage(
      result?.ok
        ? `memory-flash registered in ${agent.label}'s MCP config.`
        : (result?.error ?? "Registration failed."),
    );
    reloadAgentMcps();
  };

  const unregisterAgentMcp = async (agent: AgentMcpAgent) => {
    setAgentMcpMessage(null);
    const result = await agent.unregister({}).catch(() => null);
    setAgentMcpMessage(
      result?.ok
        ? `memory-flash removed from ${agent.label}'s MCP config.`
        : (result?.error ?? "Removal failed."),
    );
    reloadAgentMcps();
  };

  const registerAllAgentMcps = async () => {
    setAgentMcpMessage(null);
    const result = await registerAllRpc({}).catch(() => null);
    if (!result) {
      setAgentMcpMessage("Registration failed.");
      return;
    }
    const failed = result.results.filter((entry) => !entry.ok);
    setAgentMcpMessage(
      failed.length === 0
        ? `Registered memory-flash in ${result.results.map((entry) => entry.agent).join(", ")}.`
        : `Registered with failures: ${failed
            .map((entry) => `${entry.agent}${entry.error ? ` (${entry.error})` : ""}`)
            .join(", ")}.`,
    );
    reloadAgentMcps();
  };

  /**
   * Generates a remote-access key. The secret is returned once and shown
   * once in the block below — it is never persisted, so it cannot be
   * recovered afterwards, only re-issued.
   */
  const generateKey = async () => {
    setRemoteMessage(null);
    const label = keyLabel.trim();
    if (label.length === 0) {
      setRemoteMessage("Give the key a name (e.g. laptop-office) so you can recognize it later.");
      return;
    }
    const ttl = Number.parseInt(keyTtl, 10);
    const result = await generateKeyRpc({
      label,
      ttlDays: Number.isFinite(ttl) && ttl > 0 ? ttl : 0,
      scope: keyScope,
    }).catch(() => null);
    if (!result?.ok || !result.secret) {
      setRemoteMessage(result?.error ?? "Could not generate the key.");
      return;
    }
    setRevealed({
      // `url` is already dialable: a wildcard bind was replaced with a real
      // LAN/Wi-Fi address on the server side.
      url:
        http?.url ??
        `http://${http?.host ?? "127.0.0.1"}:${http?.port ?? 8787}/mcp`,
      secret: result.secret,
      label,
    });
    setKeyLabel("");
    setKeyTtl("0");
    reloadRemoteAccess();
  };

  const revokeKey = async (key: ApiKey) => {
    setRemoteMessage(null);
    const result = await revokeKeyRpc({ id: key.id }).catch(() => null);
    setRemoteMessage(
      result?.ok
        ? `Key ${key.label} revoked — clients using it are refused immediately.`
        : (result?.error ?? "Revoke failed."),
    );
    reloadRemoteAccess();
  };

  const purgeByTag = async () => {    setMessage(null);
    const tag = purgeTag.trim();
    if (tag.length === 0) {
      setMessage("Enter a tag to purge.");
      return;
    }
    const result = await purgeRpc({ tags: [tag], project: null, kind: null, confirm: "DELETE" }).catch((cause: unknown) => null);
    setMessage(result ? `Purged ${result.removed} memories with tag "${tag}".` : "Purge failed (see plugin logs).");
    setPurgeTag("");
  };

  return (
    <ScrollView style={styles.container}>
      {settings.saveError ? (
        <Text style={{ color: danger, fontSize: font(12), ...uiFontStyle }}>{settings.saveError}</Text>
      ) : null}
      <SettingsCard>
        <SettingsSection title="Integration">
          <SettingsSwitch
            label="Inject MCP server into new agents"
            hint="Adds the memory-flash MCP server to every agent created through Paseo (all providers)."
            value={values.injectIntoAgents}
            onValueChange={(enabled: boolean) => patch({ injectIntoAgents: enabled })}
          />
          <SettingsInput
            label="MCP server name"
            hint="Name reported to agents in the MCP handshake."
            initialValue={values.mcpServerName}
            onChangeText={(text: string) => patch({ mcpServerName: text })}
          />
          <SettingsInput
            label="Default agent id"
            hint="Recorded on memories saved by agents that do not identify themselves."
            initialValue={values.defaultAgentId}
            placeholder="(none)"
            onChangeText={(text: string) => patch({ defaultAgentId: text })}
          />
          <SettingsInput
            label="History per memory"
            hint="Content revisions kept per memory (10–200)."
            initialValue={String(values.historyPerMemory)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text, 10);
              if (Number.isFinite(parsed) && String(parsed) === text.trim()) {
                patch({ historyPerMemory: parsed });
              }
            }}
          />
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection title="Agent skill" info="Teaches agents when and how to use the shared memory.">
          <SettingsAction label="Install" actionLabel="Install into all agents" onPress={() => void installAll()} />
          {skillRows.map((row) => (
            <View key={row.id} style={styles.skillRow}>
              <View style={styles.skillInfo}>
                <Text style={{ color: fg, fontSize: font(12), ...uiFontStyle }}>{row.label}</Text>
                <Text style={{ color: fgMuted, fontSize: font(10), ...uiFontStyle }} numberOfLines={1}>
                  {row.installed ? (row.upToDate ? "installed · up to date" : "installed · outdated") : row.detected ? "detected · not installed" : "not installed"}
                </Text>
              </View>
              <View style={styles.skillActions}>
                <Pressable onPress={() => void install(row)} style={[styles.skillButton, { borderColor: accent }]}>
                  <Text style={{ color: accent, fontSize: font(11), ...uiFontStyle }}>{row.installed && !row.upToDate ? "Update" : "Install"}</Text>
                </Pressable>
                {row.installed ? (
                  <Pressable onPress={() => void uninstall(row)} style={[styles.skillButton, { borderColor: danger }]}>
                    <Text style={{ color: danger, fontSize: font(11), ...uiFontStyle }}>Remove</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ))}
          {skillMessage ? <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>{skillMessage}</Text> : null}
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection
          title="Agent MCP registration"
          info="Cline, Cursor and Codex CLI ignore stdio MCP servers delivered through the agent session and read them from their own config files — register the server there directly (other servers in each file are preserved).">
          <SettingsAction
            label="Register"
            actionLabel="Register for all local agent configs"
            onPress={() => void registerAllAgentMcps()}
          />
          {agentMcpAgents.map((agent) => {
            const status = agentMcps[agent.id];
            return (
              <View key={agent.id} style={styles.skillRow}>
                <View style={styles.skillInfo}>
                  <Text style={{ color: fg, fontSize: font(12), ...uiFontStyle }}>{agent.label}</Text>
                  {status ? (
                    <>
                      <Text style={{ color: fgMuted, fontSize: font(10), ...uiFontStyle }} numberOfLines={2}>
                        {status.path}
                        {"\n"}
                        {status.installed
                          ? (status.upToDate ? "installed · up to date" : "installed · outdated — re-register to update")
                          : status.detected ? "config detected · not registered" : "not detected on this host"}
                      </Text>
                      {status.live === false ? (
                        <Text style={{ color: danger, fontSize: font(10), ...uiFontStyle }} numberOfLines={2}>
                          live check failed — the registered command does not answer the MCP handshake
                        </Text>
                      ) : null}
                    </>
                  ) : (
                    <Text style={{ color: fgMuted, fontSize: font(10), ...uiFontStyle }}>Checking…</Text>
                  )}
                </View>
                <View style={styles.skillActions}>
                  <Pressable onPress={() => void registerAgentMcp(agent)} style={[styles.skillButton, { borderColor: accent }]}>
                    <Text style={{ color: accent, fontSize: font(11), ...uiFontStyle }}>
                      {status?.installed ? "Re-register" : "Register"}
                    </Text>
                  </Pressable>
                  {status?.installed ? (
                    <Pressable onPress={() => void unregisterAgentMcp(agent)} style={[styles.skillButton, { borderColor: danger }]}>
                      <Text style={{ color: danger, fontSize: font(11), ...uiFontStyle }}>Remove</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          })}
          {agentMcpMessage ? <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>{agentMcpMessage}</Text> : null}
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection
          title="Remote access (HTTP + API key)"
          info="Serves the same MCP tools over HTTP so machines other than this one can read and write the shared memory. Every request must carry Authorization: Bearer <key>; the key is generated here, shown once, and only its hash is stored. Remote clients are the memory-flash-client plugin — or any MCP client you paste the copy block into."
        >
          <SettingsSwitch
            label="Serve MCP over HTTP"
            hint="Starts an HTTP endpoint on the interface below. Local agents keep using the stdio server and need no key."
            value={values.httpEnabled}
            onValueChange={(enabled: boolean) => {
              patch({ httpEnabled: enabled });
              scheduleRemoteAccessReload();
            }}
          />
          <SettingsInput
            label="Bind address"
            hint="127.0.0.1 keeps the endpoint private to this machine. Use a Tailscale/LAN address to reach it remotely — never bind the whole internet without a firewall and HTTPS."
            initialValue={values.httpHost}
            onChangeText={(text: string) => {
              patch({ httpHost: text });
              scheduleRemoteAccessReload();
            }}
          />
          <SettingsInput
            label="Port"
            hint="TCP port for the HTTP endpoint (default 8787)."
            initialValue={String(values.httpPort)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text, 10);
              if (Number.isFinite(parsed) && String(parsed) === text.trim()) {
                patch({ httpPort: parsed });
                scheduleRemoteAccessReload();
              }
            }}
          />
          <Text style={{ color: http?.listening ? theme.colors.statusSuccess : http?.error ? danger : fgMuted, fontSize: font(12), ...uiFontStyle }}>
            {http?.listening
              ? httpRestartPending(http)
                ? `restarting — still on ${http.bindUrl ?? http.url}`
                : `listening on ${http.bindUrl ?? http.url}`
              : http?.error
                ? `not listening — ${http.error}`
                : values.httpEnabled
                  ? "starting…"
                  : "disabled"}
          </Text>
          {values.httpHost !== "127.0.0.1" && values.httpHost !== "localhost" ? (
            <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>
              The endpoint is reachable from other machines on the network the address belongs to. Keep it on a VPN (e.g. Tailscale) or behind a firewall.
            </Text>
          ) : null}
          {http?.wildcard ? (
            <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>
              {values.httpHost} is a wildcard: the socket accepts connections on every interface, but it is not an address you can dial. Remote clients use {http.url} — copy that URL, not the one above.
            </Text>
          ) : null}

          {revealed !== null ? (
            <View style={[styles.secretBox, { borderColor: accent }]}>
              <Text style={{ color: fg, fontSize: font(12), fontWeight: "600" as const, ...uiFontStyle }}>
                Copy now — this secret is shown once and cannot be recovered
              </Text>
              <Text style={{ color: fgMuted, fontSize: font(11), marginTop: 4, ...monoStyle }} selectable>
                URL:    {revealed.url}
              </Text>
              <Text style={{ color: fgMuted, fontSize: font(11), ...monoStyle }} selectable>
                Header: Authorization: Bearer {revealed.secret}
              </Text>
              <Pressable onPress={() => setRevealed(null)} style={[styles.skillButton, { borderColor: border, marginTop: 6 }]}>
                <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>Hide</Text>
              </Pressable>
            </View>
          ) : null}

          <Text style={{ color: fg, fontSize: font(12), fontWeight: "600" as const, marginTop: 8, ...uiFontStyle }}>
            API keys ({http?.keyCount ?? 0} active)
          </Text>
          {apiKeys.map((key) => (
            <View key={key.id} style={styles.skillRow}>
              <View style={styles.skillInfo}>
                <Text style={{ color: fg, fontSize: font(12), ...uiFontStyle }}>{key.label}</Text>
                <Text style={{ color: fgMuted, fontSize: font(10), ...monoStyle }} numberOfLines={1}>
                  {key.id} · {key.prefix}… · {key.scopes.join(", ")}
                </Text>
                <Text style={{ color: fgMuted, fontSize: font(10), ...uiFontStyle }}>
                  created {key.createdAt}
                  {key.lastUsedAt ? ` · last used ${key.lastUsedAt}` : " · never used"}
                  {key.expiresAt ? ` · expires ${key.expiresAt}` : " · never expires"}
                </Text>
                {key.revokedAt ? (
                  <Text style={{ color: danger, fontSize: font(10), ...uiFontStyle }}>revoked {key.revokedAt}</Text>
                ) : null}
              </View>
              <View style={styles.skillActions}>
                {key.revokedAt === null ? (
                  <Pressable onPress={() => void revokeKey(key)} style={[styles.skillButton, { borderColor: danger }]}>
                    <Text style={{ color: danger, fontSize: font(11), ...uiFontStyle }}>Revoke</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ))}
          {apiKeys.length === 0 ? (
            <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>
              No keys yet. Generate one per remote machine so access can be revoked per host.
            </Text>
          ) : null}
          <SettingsInput
            label="New key — name"
            hint="Where the key will be used, e.g. laptop-office or builder-2."
            initialValue={keyLabel}
            placeholder="laptop-office"
            onChangeText={setKeyLabel}
          />
          <SettingsInput
            label="New key — lifetime (days)"
            hint="0 means the key never expires."
            initialValue={keyTtl}
            placeholder="0"
            onChangeText={setKeyTtl}
          />
          <SettingsSelect
            label="New key — scope"
            hint="read allows search and read tools only; read_write also allows saving and deleting memories."
            value={keyScope}
            options={[
              { label: "read_write (full access)", value: "read_write" },
              { label: "read only", value: "read" },
            ]}
            onValueChange={(scope: ApiKeyScope) => setKeyScope(scope)}
          />
          <SettingsAction label="New key" actionLabel="Generate API key" onPress={() => void generateKey()} />
          {remoteMessage ? (
            <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>{remoteMessage}</Text>
          ) : null}
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection title="Database" info="The shared SQLite memory file on this host.">
          <Text style={{ color: fgMuted, fontSize: font(12), ...uiFontStyle }}>
            {dbSummary ?? "Counting…"} — $PASEO_HOME/plugins/memory-flash/memory.db
          </Text>
          <Text style={{ color: fgMuted, fontSize: font(11), marginTop: 4, ...uiFontStyle }} numberOfLines={6}>
            {skillDoc ? `${skillDoc.slice(0, 220)}…` : ""}
          </Text>
          <SettingsInput
            label="Purge by tag"
            hint="Deletes every memory carrying this tag. Runs immediately."
            initialValue={purgeTag}
            placeholder="tag"
            onChangeText={setPurgeTag}
          />
          <SettingsAction label="Purge" actionLabel={`Purge tag "${purgeTag.trim() || "…"}"`} onPress={() => void purgeByTag()} />
          {message ? <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>{message}</Text> : null}
        </SettingsSection>
      </SettingsCard>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 8 },
  skillRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6, borderTopWidth: 1, borderTopColor: "rgba(128,128,128,0.25)" },
  skillInfo: { flex: 1 },
  skillActions: { flexDirection: "row", gap: 8 },
  skillButton: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  secretBox: { borderWidth: 1, borderRadius: 8, padding: 10, marginTop: 8 },
});
