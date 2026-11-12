import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { VerifyVaultResult } from "./shared/contracts";
import {
  notePreviewSchema,
  readNote,
  reindexVault,
  searchVaultRpc,
  vaultStatus,
  verifyVault,
} from "./shared/contracts";
import { obsidianBridgeSettings, runtimeSettingsOf, type RuntimeSettings } from "./shared/settings";
import { readSavedMcpServers } from "./server/agent-record";
import { createObsidianTools } from "./server/agent-tools";
import { VaultIndexer } from "./server/indexer";
import { INJECTED_SERVER_NAME, mcpServerCommand } from "./server/mcp-launch";
import { dispatchTool, openRuntime } from "./server/mcp-tools";
import { searchIndex } from "./server/search";
import { parseSettingsFile } from "./server/settings-file";
import { writeSettingsMirror } from "./server/settings-mirror";
import { decideSessionOpen, needsCapabilityProbe } from "./server/session-open";
import { checkVault, readVaultNote } from "./server/vault";

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
    void indexer.reconfigure();
  });

  // -------------------------------------------------------------------------
  // Injection (inert)
  // -------------------------------------------------------------------------

  const agentTools = createObsidianTools(readRuntimeSettings);

  const removeOpenHook = server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    const values = await readRuntimeSettings().catch(() => null);
    const base = {
      reason: request.reason,
      purpose: request.purpose,
      provider: request.provider,
      injectIntoAgents: values !== null,
      serverName: INJECTED_SERVER_NAME,
      lookup: readSavedMcpServers(request.agentId),
      supportsMcpServers: null as boolean | null,
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

  server.handle(searchVaultRpc, async ({ query, limit, folder }) => {
    const runtimeSettings = await readRuntimeSettings();
    const opened = openRuntime(runtimeSettings);
    if ("error" in opened) {
      return {
        query,
        hits: [],
        text: opened.error,
        tookMs: 0,
        signals: [],
        note: opened.error,
      };
    }
    try {
      return searchIndex(opened.runtime.store, {
        query,
        limit,
        folder,
        budgetChars: runtimeSettings.searchBudgetChars,
        snippetChars: runtimeSettings.snippetChars,
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
      const note = readVaultNote(opened.runtime.root, path);
      if ("error" in note) {
        return notePreviewSchema.parse({ ...empty, content: note.error });
      }
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
        backlinks: opened.runtime.store.backlinksOf(path),
        content: note.text,
        truncated: note.truncated,
      });
    } finally {
      opened.runtime.store.close();
    }
  });

  // -------------------------------------------------------------------------

  return () => {
    removeSettingsListener();
    removeOpenHook();
    void indexer.stop();
    void dispatchTool; // kept for the bundle's shared tool layer
  };
}
