import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { VaultStatus } from "../shared/contracts";
import type { RuntimeSettings } from "../shared/settings";
import { resolveRoleDirs } from "./dirs";
import { parseNote } from "./parse";
import { indexPathFor, resolveVaultRoot } from "./paths";
import { scanVault, type ScanOutcome } from "./scan";
import { BridgeStore } from "./store";
import { isExcluded, isIncluded, isMarkdownPath, looksLikeVault } from "./vault";

/**
 * Owns the vault index for the plugin process.
 *
 * Nothing here is triggered by an agent: the indexer starts with the plugin,
 * reconfigures when the user changes settings, and otherwise works on its own
 * queue and timer. A missing `vaultPath` keeps it idle — that is the "ask
 * before the first scan" gate, expressed in code: no path, no index, no write.
 */

export interface IndexerState {
  lastScanAt: string | null;
  lastChangeAt: string | null;
  error: string | null;
  indexRunning: boolean;
  watching: boolean;
}

export class VaultIndexer {
  private store: BridgeStore | null = null;
  private root: string | null = null;
  private watcher: fs.FSWatcher | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private pending = new Set<string>();
  private pendingTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  private disposed = false;
  private settings: RuntimeSettings | null = null;
  private state: IndexerState = {
    lastScanAt: null,
    lastChangeAt: null,
    error: null,
    indexRunning: false,
    watching: false,
  };

  constructor(private readonly readSettings: () => Promise<RuntimeSettings>) {}

  /** Starts (or restarts) the indexer from the current settings. */
  async start(): Promise<void> {
    await this.reconfigure();
  }

  async stop(): Promise<void> {
    this.disposed = true;
    this.closeResources();
  }

  /**
   * Applies new settings: a changed vault path, include/exclude list or
   * tokenizer closes and reopens the index, then a scan runs.
   */
  async reconfigure(): Promise<void> {
    const settings = await this.readSettings();
    this.settings = settings;
    const wantedRoot = settings.vaultPath.trim();

    if (wantedRoot.length === 0) {
      this.closeResources();
      this.state.error = null;
      return;
    }

    // `~` and home-relative values are accepted; `path.resolve` alone would
    // depend on the daemon's working directory.
    const resolvedRoot = resolveVaultRoot(wantedRoot);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(resolvedRoot).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      this.closeResources();
      this.state.error = `Vault path '${wantedRoot}' is not a readable directory.`;
      return;
    }

    const rootChanged = this.root !== resolvedRoot;
    if (rootChanged || !this.store) {
      this.closeResources();
      this.root = resolvedRoot;
      try {
        this.store = new BridgeStore(indexPathFor(resolvedRoot), {
          stemming: settings.ftsStemming,
        });
      } catch (cause) {
        this.store = null;
        this.state.error = `Could not open the index: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
        return;
      }
    }

    this.state.error = null;
    if (!settings.indexingEnabled) {
      this.stopWatching();
      return;
    }

    await this.scanNow();
    this.startWatching();
    this.scheduleReconcile(settings.reconcileMinutes);
  }

  /** Runs one scan on the plugin queue (also used by the reindex RPC). */
  async scanNow(): Promise<ScanOutcome | null> {
    if (!this.store || !this.root || !this.settings) return null;
    if (this.scanning) return null;
    this.scanning = true;
    this.state.indexRunning = true;
    try {
      const outcome = scanVault({
        root: this.root,
        store: this.store,
        settings: this.settings,
        force: true,
        log: (message) => console.warn(`[obsidian-bridge] ${message}`),
      });
      this.state.lastScanAt = new Date().toISOString();
      this.state.error = null;
      return outcome;
    } catch (cause) {
      this.state.error = `Indexing failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      console.error(`[obsidian-bridge] ${this.state.error}`);
      return null;
    } finally {
      this.scanning = false;
      this.state.indexRunning = false;
    }
  }

  /** Snapshot for the `obsidian-bridge.status` RPC. */
  status(): VaultStatus {
    const settings = this.settings;
    const emptyCounts = { notes: 0, chunks: 0, links: 0, unresolvedLinks: 0 };
    const attempt = <T,>(read: () => T, fallback: T): T => {
      try {
        return read();
      } catch {
        return fallback;
      }
    };
    const counts = this.store ? attempt(() => this.store!.counts(), emptyCounts) : emptyCounts;
    const size = this.store ? attempt(() => this.store!.sizeBytes(), 0) : 0;
    const lastScanMs = this.store
      ? attempt(() => this.store!.getMeta("last_scan_ms"), null)
      : null;
    const exists = this.root !== null;
    return {
      vaultPath: settings?.vaultPath ?? "",
      configured: settings !== null && settings.vaultPath.trim().length > 0,
      vaultExists: exists,
      isObsidianVault: this.root !== null && looksLikeVault(this.root),
      indexingEnabled: settings?.indexingEnabled ?? false,
      indexedNotes: counts.notes,
      indexedChunks: counts.chunks,
      indexedLinks: counts.links,
      unresolvedLinks: counts.unresolvedLinks,
      indexBytes: size,
      lastScanAt:
        this.state.lastScanAt ??
        (lastScanMs ? new Date(Number(lastScanMs)).toISOString() : null),
      lastChangeAt: this.state.lastChangeAt,
      watching: this.state.watching,
      indexRunning: this.state.indexRunning,
      readOnly: settings?.readOnly ?? true,
      directories: settings
        ? resolveRoleDirs(settings)
        : { workspace: "", inbox: null, out: null, raw: null },
      dbPath: this.root ? indexPathFor(this.root) : null,
      error: this.state.error,
    };
  }

  private startWatching(): void {
    if (!this.root || this.watcher || !this.settings?.indexingEnabled) return;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        const rel = typeof filename === "string" ? filename.replace(/\\/g, "/") : null;
        if (!rel || !isMarkdownPath(rel)) return;
        const settings = this.settings;
        if (!settings) return;
        if (!isIncluded(rel, settings.includeFolders)) return;
        if (isExcluded(rel, settings.excludeGlobs)) return;
        this.pending.add(rel);
        this.schedulePendingFlush();
      });
      this.watcher.on("error", (cause) => {
        this.state.error = `File watch lost: ${cause.message}`;
        this.stopWatching();
      });
      this.state.watching = true;
    } catch (cause) {
      // Recursive watch is unavailable on some platforms: the reconcile timer
      // still keeps the index current, just with a delay.
      this.state.watching = false;
      console.warn(
        `[obsidian-bridge] watch unavailable, relying on reconcile: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }

  private stopWatching(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // already closed
      }
      this.watcher = null;
    }
    this.state.watching = false;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pending.clear();
  }

  private scheduleReconcile(minutes: number): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    const interval = Math.max(1, minutes) * 60_000;
    this.reconcileTimer = setInterval(() => {
      if (this.disposed) return;
      void this.reconcile();
    }, interval);
    // Do not keep the process alive just for the timer.
    this.reconcileTimer.unref?.();
  }

  private async reconcile(): Promise<void> {
    if (!this.store || !this.root || !this.settings || this.scanning) return;
    this.scanning = true;
    this.state.indexRunning = true;
    try {
      scanVault({
        root: this.root,
        store: this.store,
        settings: this.settings,
        log: (message) => console.warn(`[obsidian-bridge] ${message}`),
      });
      this.state.lastScanAt = new Date().toISOString();
      this.state.error = null;
    } catch (cause) {
      this.state.error = `Reconcile failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    } finally {
      this.scanning = false;
      this.state.indexRunning = false;
    }
  }

  private schedulePendingFlush(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.flushPending();
    }, 1500);
    this.pendingTimer.unref?.();
  }

  private async flushPending(): Promise<void> {
    if (!this.store || !this.root || !this.settings) return;
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length === 0) return;

    let changed = false;
    for (const rel of paths) {
      const absolute = path.join(this.root, rel);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(absolute);
      } catch {
        stat = null;
      }
      try {
        if (!stat || !stat.isFile()) {
          this.store.deleteNote(rel);
          changed = true;
          continue;
        }
        const text = fs.readFileSync(absolute, "utf-8");
        this.store.upsertNote({
          relPath: rel,
          parsed: parseNote(text, rel),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          hash: crypto.createHash("sha1").update(text).digest("hex"),
        });
        changed = true;
      } catch (cause) {
        console.warn(
          `[obsidian-bridge] could not update ${rel}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
    }
    if (changed) {
      try {
        this.store.resolveLinks();
        this.state.lastChangeAt = new Date().toISOString();
        this.store.setMeta("last_scan_ms", String(Date.now()));
      } catch (cause) {
        this.state.error = `Link resolution failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
      }
    }
  }

  private closeResources(): void {
    this.stopWatching();
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.store) {
      try {
        this.store.close();
      } catch {
        // already closed
      }
      this.store = null;
    }
    this.root = null;
    this.state.watching = false;
  }
}
