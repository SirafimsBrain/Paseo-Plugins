import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { VerifyVaultResult } from "./shared/contracts";
import {
  agentIntegrationStatus,
  notePreviewSchema,
  openInObsidian,
  readNote,
  reindexVault,
  searchVaultRpc,
  statusStream,
  testEnrichment,
  vaultStatus,
  verifyVault,
} from "./shared/contracts";
import { searchNotesForAttachment } from "./shared/attachments";
import { obsidianBridgeSettings, runtimeSettingsOf, type RuntimeSettings } from "./shared/settings";
import { readSavedMcpServers } from "./server/agent-record";
import { createObsidianTools } from "./server/agent-tools";
import { normalizeRoleDir } from "./server/dirs";
import { embedQuery } from "./server/embed/query";
import { fuzzySearch } from "./server/enrichment";
import { VaultIndexer } from "./server/indexer";
import { createObsidianApi, ObsidianApi } from "./server/obsidian-api";
import { INJECTED_SERVER_NAME, mcpServerCommand, resolveInstalledMcpEntry } from "./server/mcp-launch";
import { ensureStableEntry, healStaleSavedEntries } from "./server/mcp-stable";
import {
  INJECTION_METADATA_KEY,
  injectionMarker,
  readInjectionMarker,
  withInjectionMarker,
  type AgentMetadata,
  type InjectionMode,
} from "./server/injection";
import {
  agentSkillStatus,
  installAgentSkill,
  removeAgentSkill,
  skillStatuses,
  verifyAgentSkill,
} from "./server/agent-skill";
import { clineMcpStatus, registerClineMcp, unregisterClineMcp } from "./server/cline-mcp";
import {
  agentConfigCoversProvider,
  kiloMcpStatus,
  opencodeMcpStatus,
  registerKiloMcp,
  registerOpencodeMcp,
  unregisterKiloMcp,
  unregisterOpencodeMcp,
} from "./server/opencode-mcp";
import { openRuntime } from "./server/mcp-tools";
import { searchIndex } from "./server/search";
import { parseSettingsFile } from "./server/settings-file";
import { writeSettingsMirror } from "./server/settings-mirror";
import { decideSessionOpen, needsCapabilityProbe } from "./server/session-open";
import { checkVault, readVaultNote } from "./server/vault";
import * as path from "node:path";

/**
 * Plugin server for Obsidian Bridge.
 *
 * Responsibilities:
 * 1. Register host-scoped settings (vault path, index policy, search budgets)
 *    — edited in Paseo Settings → Plugins → Obsidian Bridge, never by hand.
 * 2. Mirror those settings into a file the spawned MCP server can read.
 * 3. Own the index: scan, watch, reconcile. A missing vault path keeps the
 *    indexer idle, which is the "no path, no scan" gate.
 * 4. Contribute the MCP server (or the fallback agent tools) on
 *    `agent.open.before` — inertly: no probing, no scanning, no env changes
 *    (`__research.md` §2.7).
 * 5. Serve the plugin RPC surface for the knowledge-base panel.
 */

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(obsidianBridgeSettings);

  /**
   * Effective runtime settings: the host store when readable, the mirrored
   * file (plus env) otherwise, so a bad edit degrades instead of crashing.
   */
  async function readRuntimeSettings(): Promise<RuntimeSettings> {
    const state = await settings.read().catch(() => null);
    if (state?.status !== "ready") return parseSettingsFile();
    return runtimeSettingsOf(state.values);
  }

  async function mirrorSettings(): Promise<void> {
    try {
      const target = writeSettingsMirror(await readRuntimeSettings());
      console.log(`[obsidian-bridge] settings mirrored: ${target}`);
    } catch (cause) {
      console.warn(
        `[obsidian-bridge] could not write settings mirror: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }

  // Write once so the first agent already sees the user's configuration.
  void mirrorSettings();

  /**
   * The bundled server lives inside the versioned checkout, which
   * `paseo plugin update` replaces. An absolute path saved into an agent's
   * configuration (or into an OpenCode/Kilo/Cline config file) would then point
   * at a file that no longer exists, so every start publishes one stable copy
   * under the plugin's data directory and restores the files agents created by
   * an older version still name (0.9.11).
   */
  const installedBundle = resolveInstalledMcpEntry();
  ensureStableEntry(installedBundle);
  const healedEntries = healStaleSavedEntries(installedBundle, INJECTED_SERVER_NAME);
  if (healedEntries.length > 0) {
    console.log(
      `[obsidian-bridge] restored ${healedEntries.length} saved MCP entr${
        healedEntries.length === 1 ? "y" : "ies"
      } from an older checkout`,
    );
  }

  /**
   * Keeps the agent config-file registrations in step with the switch.
   *
   * Paseo 0.15.x refuses custom MCP servers on an OpenCode agent that uses the
   * shared local service and does not surface attached tools to OpenCode, so a
   * server in OpenCode's own config is what actually reaches those agents. It
   * also survives the idle-runtime release, which a launch-only contribution
   * does not. Only an agent whose config directory exists is touched, and no
   * file is created for a program that is not installed.
   */
  async function syncConfigRegistration(): Promise<void> {
    const state = await settings.read().catch(() => null);
    // Default on, matching the schema: an unreadable store must not silently
    // take the tools away from agents.
    const wanted = state?.status === "ready" ? state.values.registerOpencodeMcp !== false : true;
    const wantedCline = state?.status === "ready" ? state.values.registerClineMcp !== false : true;
    if (!wantedCline) {
      unregisterClineMcp();
    } else {
      const status = clineMcpStatus();
      if (status.detected && !(status.installed && status.upToDate === true)) {
        const result = registerClineMcp();
        if (!result.ok) console.warn(`[obsidian-bridge] Cline config not updated: ${result.error}`);
        else console.log(`[obsidian-bridge] Cline config carries the server: ${status.path}`);
      }
    }
    if (!wanted) {
      unregisterOpencodeMcp();
      unregisterKiloMcp();
      console.log("[obsidian-bridge] agent config registration removed");
      return;
    }
    const opencode = opencodeMcpStatus();
    if (opencode.detected && !(opencode.installed && opencode.upToDate === true)) {
      const result = registerOpencodeMcp();
      if (!result.ok) {
        console.warn(`[obsidian-bridge] OpenCode config not updated: ${result.error}`);
      } else {
        console.log(`[obsidian-bridge] OpenCode config carries the server: ${opencode.path}`);
      }
    }
    const kilo = kiloMcpStatus();
    if (kilo.detected && !(kilo.installed && kilo.upToDate === true)) {
      const result = registerKiloMcp();
      if (!result.ok) console.warn(`[obsidian-bridge] Kilo config not updated: ${result.error}`);
    }
  }

  /**
   * Installs (or removes) the plugin's agent skill.
   *
   * Paseo has no skill API, so the skill reaches agents as a `SKILL.md` in the
   * skills directory their runtime already scans. Only directories that exist
   * are touched, and a copy that already matches the checkout is left alone.
   */
  async function syncAgentSkill(): Promise<void> {
    const state = await settings.read().catch(() => null);
    const wanted = state?.status === "ready" ? state.values.installAgentSkill !== false : true;
    if (!wanted) {
      const { removed, errors } = removeAgentSkill();
      for (const dir of removed) console.log(`[obsidian-bridge] agent skill removed: ${dir}`);
      for (const error of errors) console.warn(`[obsidian-bridge] agent skill not removed: ${error}`);
      return;
    }
    const result = verifyAgentSkill();
    for (const target of result.repaired) console.log(`[obsidian-bridge] agent skill installed: ${target}`);
    for (const error of result.errors) console.warn(`[obsidian-bridge] agent skill not installed: ${error}`);
    if (result.checked.length === 0) {
      console.log("[obsidian-bridge] no agent skills directory found; skill not installed");
    } else if (result.repaired.length === 0 && result.errors.length === 0) {
      console.log(
        `[obsidian-bridge] agent skill verified: ${result.checked.length} director(ies), up to date`,
      );
    }
  }

  void syncConfigRegistration();
  void syncAgentSkill();

  /**
   * Currency check for the installed skill: the copies live in directories that
   * users and other tools also write to, and an agent must not be left running
   * on stale instructions. Anything that drifted is repaired and logged.
   */
  const skillCheckTimer = setInterval(() => {
    const result = verifyAgentSkill();
    for (const target of result.repaired) {
      console.log(`[obsidian-bridge] agent skill was stale and was repaired: ${target}`);
    }
    for (const error of result.errors) console.warn(`[obsidian-bridge] agent skill check failed: ${error}`);
    // The same check for the config files: a registration can point at a
    // checkout that a plugin update replaced, and that must heal without the
    // user opening settings.
    void syncConfigRegistration();
  }, 5 * 60_000);
  skillCheckTimer.unref?.();

  const indexer = new VaultIndexer(readRuntimeSettings);
  void indexer.start().catch((cause) => {
    console.error(
      `[obsidian-bridge] indexer start failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  });

  const removeSettingsListener = settings.subscribe(() => {
    void mirrorSettings();
    void syncConfigRegistration();
    void syncAgentSkill();
    void indexer.reconfigure();
  });

  // -------------------------------------------------------------------------
  // Injection (inert)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Creation (saved configuration)
  // -------------------------------------------------------------------------

  /**
   * A new agent is created through `agent.create.before`, which is the only
   * hook whose change is saved with the agent. `agent.open.before` cannot do
   * this reliably: it fires before Paseo writes the agent record, and a
   * capability probe on an agent that has not started answers `null`, so the
   * launch-only path degraded to attached tools that OpenCode and Cline never
   * surface (fixed in 0.4.3).
   */
  /** This plugin's marker for a hook result, merged into the agent metadata. */
  function markedMetadata(
    metadata: AgentMetadata | null | undefined,
    mode: InjectionMode,
    reason: string,
  ) {
    return withInjectionMarker(metadata, injectionMarker(mode, reason));
  }

  const removeCreateHook = server.addHook("agent.create.before", async ({ request }) => {
    const state = await settings.read().catch(() => null);
    if (state?.status !== "ready" || !state.values.injectIntoAgents) {
      return {
        ...request,
        metadata: markedMetadata(request.metadata, "skipped", "injectIntoAgents is off"),
      };
    }
    // A saved server on an OpenCode agent makes Paseo refuse the session when
    // the shared service is in use; the config-file registration covers it.
    if (agentConfigCoversProvider(request.config.provider).covered) {
      return {
        ...request,
        metadata: markedMetadata(
          request.metadata,
          "config",
          "the provider's config file already carries the server",
        ),
      };
    }
    const { command, args } = mcpServerCommand();
    request.config.mcpServers = {
      ...(request.config.mcpServers ?? {}),
      [INJECTED_SERVER_NAME]: { type: "stdio", command, args, alwaysLoad: true } as const,
    };
    console.log(
      `[obsidian-bridge] MCP saved for the new agent: ${command} ${args.join(" ")}`,
    );
    // `agent.create.before` may return metadata, so the marker travels with the
    // agent Paseo persists. The open hook cannot do this in its result (0.16.0).
    return {
      ...request,
      metadata: markedMetadata(request.metadata, "mcp", "saved the MCP server for the new agent"),
    };
  });

  const agentTools = createObsidianTools(readRuntimeSettings);

  const removeOpenHook = server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    const values = await readRuntimeSettings().catch(() => null);
    // How an earlier open provisioned this agent (0.9.11). A recorded `mcp` mode
    // makes the capability probe unnecessary: the provider already accepted a
    // server for this agent, and that answer cannot have changed.
    const known = readInjectionMarker(request.metadata);
    const base = {
      reason: request.reason,
      purpose: request.purpose,
      provider: request.provider,
      injectIntoAgents: values !== null,
      serverName: INJECTED_SERVER_NAME,
      lookup: readSavedMcpServers(request.agentId),
      configCovered: agentConfigCoversProvider(request.provider).covered,
      supportsMcpServers: null as boolean | null,
      knownMode: known?.mode ?? null,
    };
    if (values === null) return request;

    // The daemon is consulted only when an MCP contribution is still possible.
    let supportsMcpServers: boolean | null = null;
    if (needsCapabilityProbe(base)) {
      const snapshot = await paseo.agents
        .ref(request.agentId)
        .refresh()
        .catch(() => null);
      supportsMcpServers = snapshot?.agent.capabilities.supportsMcpServers ?? null;
    }

    const decision = decideSessionOpen({ ...base, supportsMcpServers });
    console.log(
      `[obsidian-bridge] session_open ${request.agentId} (${request.reason}/${request.purpose}): ${decision.why}`,
    );
    // The marker is written through the SDK, never returned: 0.16.0 lets this
    // hook change only `env`, `tools` and `mcpServers`, and a result that also
    // changes `metadata` fails the open (and every prompt after it).
    // Fire-and-forget, because awaiting a write to the agent being opened
    // deadlocks the open.
    const mode: InjectionMode = decision.injectMcp
      ? "mcp"
      : decision.attachTool
        ? "tool"
        : base.configCovered
          ? "config"
          : "skipped";
    if (request.purpose !== "history" && known?.mode !== mode) {
      const marker = injectionMarker(mode, decision.why);
      void paseo.agents
        .ref(request.agentId)
        .setMetadata({
          [INJECTION_METADATA_KEY]: {
            mode: marker.mode,
            reason: marker.reason,
            at: marker.at,
          },
        })
        .catch((cause: unknown) => {
          console.warn(
            `[obsidian-bridge] could not record the injection marker: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        });
    }

    if (!decision.injectMcp && !decision.attachTool) return request;

    const tools = decision.attachTool
      ? [...request.tools, ...agentTools]
      : request.tools;
    let mcpServers = request.mcpServers;
    if (decision.injectMcp) {
      const { command, args } = mcpServerCommand();
      mcpServers = {
        ...request.mcpServers,
        [INJECTED_SERVER_NAME]: { type: "stdio", command, args, alwaysLoad: true } as const,
      };
    }
    return { ...request, tools, mcpServers };
  });

  // -------------------------------------------------------------------------
  // RPC surface
  // -------------------------------------------------------------------------

  server.handle(vaultStatus, async () => indexer.status());

  // Live status stream (0.9.11, Paseo 0.16.0 `addSubscription`): a complete
  // snapshot on subscribe, then one per indexer change — a scan, a watched-note
  // flush, a reconcile or a settings edit — so the screen and the workspace tab
  // no longer poll and a finished reindex shows up on its own.
  server.handle(statusStream, async (_input, context) => {
    let closed = false;
    const emit = () => {
      if (closed) return;
      void context
        .push({ at: new Date().toISOString(), status: indexer.status() })
        .catch((cause: unknown) => {
          console.warn(
            `[obsidian-bridge] status stream push failed: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        });
    };
    emit();
    const unsubscribe = indexer.subscribeStatus(emit);
    const stop = () => {
      closed = true;
      unsubscribe();
    };
    if (context.signal.aborted) stop();
    else context.signal.addEventListener("abort", stop, { once: true });
  });

  // "Is the plugin actually installed for my agents?" — the settings screen
  // asks this directly instead of leaving the user to inspect config files.
  server.handle(agentIntegrationStatus, async () => {
    const opencode = opencodeMcpStatus();
    const kilo = kiloMcpStatus();
    const cline = clineMcpStatus();
    return {
      refreshedAt: new Date().toISOString(),
      configs: [
        {
          label: "OpenCode",
          path: opencode.path,
          detected: opencode.detected,
          installed: opencode.installed,
          upToDate: opencode.upToDate,
          error: null,
        },
        {
          label: "Kilo",
          path: kilo.path,
          detected: kilo.detected,
          installed: kilo.installed,
          upToDate: kilo.upToDate,
          error: null,
        },
        {
          label: "Cline",
          path: cline.path,
          detected: cline.detected,
          installed: cline.installed,
          upToDate: cline.upToDate,
          error: cline.error,
        },
      ],
      skills: skillStatuses(),
      skillSource: agentSkillStatus().source,
    };
  });

  server.handle(verifyVault, async ({ path }) => {
    const check = checkVault(path);
    const result: VerifyVaultResult = {
      ok: check.exists && check.isDirectory && check.markdownFiles > 0,
      path: check.path,
      exists: check.exists,
      isDirectory: check.isDirectory,
      isObsidianVault: check.isObsidianVault,
      markdownFiles: check.markdownFiles,
      capped: check.capped,
      sample: check.sample,
      error:
        check.error ??
        (check.exists && check.isDirectory && check.markdownFiles === 0
          ? "No Markdown files found in this directory."
          : null),
    };
    return result;
  });

  server.handle(searchVaultRpc, async ({ query, limit, folder, semantic }) => {
    const runtimeSettings = await readRuntimeSettings();
    const requestedFolder = (folder ?? "").trim();
    const normalizedFolder = requestedFolder.length === 0 ? "" : normalizeRoleDir(requestedFolder);
    if (normalizedFolder === null) {
      const note = `'${requestedFolder}' is not a folder inside the configured directory.`;
      return {
        query,
        hits: [],
        text: note,
        tookMs: 0,
        signals: [],
        note,
        enrichment: { enabled: runtimeSettings.obsidianApiEnabled, used: false, error: null },
      };
    }
    const opened = openRuntime(runtimeSettings);
    if ("error" in opened) {
      return {
        query,
        hits: [],
        text: opened.error,
        tookMs: 0,
        signals: [],
        note: opened.error,
        enrichment: { enabled: runtimeSettings.obsidianApiEnabled, used: false, error: null },
      };
    }
    try {
      const semanticWanted = semantic === undefined ? runtimeSettings.semanticSearch : semantic;
      const embedding =
        semanticWanted && query.length > 0 ? await embedQuery(runtimeSettings, query) : null;
      const fuzzy = await fuzzySearch(runtimeSettings, query, 20);
      return searchIndex(opened.runtime.store, {
        query,
        limit,
        folder: normalizedFolder,
        budgetChars: runtimeSettings.searchBudgetChars,
        snippetChars: runtimeSettings.snippetChars,
        dirs: opened.runtime.dirs,
        semantic: embedding?.vector
          ? { vector: embedding.vector, modelId: embedding.modelId }
          : null,
        fuzzy: fuzzy.hits,
        enrichment: { enabled: fuzzy.enabled, error: fuzzy.error },
      });
    } finally {
      opened.runtime.store.close();
    }
  });

  server.handle(reindexVault, async () => {
    const outcome = await indexer.scanNow();
    if (!outcome) {
      const status = indexer.status();
      return {
        ok: false,
        notes: status.indexedNotes,
        chunks: status.indexedChunks,
        tookMs: 0,
        error:
          status.error ??
          (status.configured
            ? "Indexing is disabled or already running."
            : "Set the vault path in Settings → Plugins → Obsidian Bridge first."),
      };
    }
    return {
      ok: true,
      notes: outcome.notes,
      chunks: outcome.chunks,
      tookMs: outcome.tookMs,
      error: null,
    };
  });

  server.handle(readNote, async ({ path }) => {
    const runtimeSettings = await readRuntimeSettings();
    const opened = openRuntime(runtimeSettings);
    const empty = {
      path,
      title: path,
      frontmatter: "",
      headings: [],
      tags: [],
      links: [],
      backlinks: [],
      content: "",
      truncated: false,
    };
    if ("error" in opened) return notePreviewSchema.parse(empty);
    try {
      const note = readVaultNote(opened.runtime.root, path, {
        allowedExtensions: runtimeSettings.allowedExtensions,
      });
      if ("error" in note) {
        return notePreviewSchema.parse({ ...empty, content: note.error });
      }
      const api = createObsidianApi(runtimeSettings);
      const authority = api ? await api.noteLinks(path) : null;
      return notePreviewSchema.parse({
        path: note.path,
        title: note.parsed.title,
        frontmatter: note.parsed.frontmatterRaw,
        headings: note.parsed.headings.map((heading) => ({
          level: heading.level,
          text: heading.text,
        })),
        tags: note.parsed.tags,
        links: opened.runtime.store
          .outgoingLinks(path)
          .map((link) => ({ target: link.raw_target, resolved: link.target_path })),
        backlinks: authority?.links?.backlinks ?? opened.runtime.store.backlinksOf(path),
        content: note.text,
        truncated: note.truncated,
      });
    } finally {
      opened.runtime.store.close();
    }
  });

  server.handle(openInObsidian, async ({ path: notePath }) => {
    const runtimeSettings = await readRuntimeSettings();
    const api = createObsidianApi(runtimeSettings);
    if (!api) {
      return {
        ok: false,
        error:
          "Obsidian enrichment is off. Enable it in Settings → Plugins → Obsidian Bridge and start Obsidian with the Local REST API plugin.",
      };
    }
    const opened = openRuntime(runtimeSettings);
    if ("error" in opened) return { ok: false, error: opened.error };
    try {
      // Refuse paths outside the configured directory (and `.obsidian/`)
      // before handing anything to the API.
      const note = readVaultNote(opened.runtime.root, notePath, {
        maxBytes: 1024,
        allowedExtensions: runtimeSettings.allowedExtensions,
      });
      if ("error" in note) return { ok: false, error: note.error };
    } finally {
      opened.runtime.store.close();
    }
    return api.openNote(notePath);
  });

  server.handle(testEnrichment, async () => {
    const runtimeSettings = await readRuntimeSettings();
    const api = new ObsidianApi({
      url: runtimeSettings.obsidianApiUrl,
      apiKey: runtimeSettings.obsidianApiKey,
    });
    return api.probe();
  });

  server.handle(searchNotesForAttachment, async ({ query }) => {
    const runtimeSettings = await readRuntimeSettings();
    const opened = openRuntime(runtimeSettings);
    if ("error" in opened) return { items: [] };
    try {
      const result = searchIndex(opened.runtime.store, {
        query,
        limit: 8,
        budgetChars: 4000,
        snippetChars: 300,
        dirs: opened.runtime.dirs,
      });
      const items: Array<{
        id: string;
        identifier: string;
        title: string;
        subtitle: string;
        url: string;
        text: string;
        resourceType: string;
      }> = [];
      for (const hit of result.hits) {
        const note = readVaultNote(opened.runtime.root, hit.path, {
          maxBytes: 4 * 1024 * 1024,
          allowedExtensions: runtimeSettings.allowedExtensions,
        });
        if ("error" in note) continue;
        const absolute = path.join(opened.runtime.root, hit.path);
        const text =
          note.text.length > 40_000
            ? `${note.text.slice(0, 40_000)}\n\n[truncated by Obsidian Bridge]`
            : note.text;
        items.push({
          id: hit.path,
          identifier: hit.path,
          title: hit.title,
          subtitle: `${hit.role}${hit.heading.length > 0 ? ` · ${hit.heading}` : ""}`,
          url: `obsidian://open?path=${encodeURIComponent(absolute)}`,
          text,
          resourceType: "obsidian-note",
        });
      }
      return { items };
    } finally {
      opened.runtime.store.close();
    }
  });

  // -------------------------------------------------------------------------

  return () => {
    clearInterval(skillCheckTimer);
    removeSettingsListener();
    removeCreateHook();
    removeOpenHook();
    // The config entry stays on shutdown. Paseo reloads the plugin on every
    // update, and a live OpenCode session drops a namespace that disappears
    // from its config mid-turn; a stale entry after an uninstall is the smaller
    // price, and the switch still removes it on request.
    void indexer.stop();
  };
}
