/**
 * Contract every agent session store implements.
 *
 * Adding support for a new coding agent means adding one module in this
 * directory that exports a `ProviderAdapter`, then registering it in
 * `registry.ts`. Nothing else in the plugin needs to change.
 */
export interface ProviderSession {
  id: string;
  title: string | null;
  cwd: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  sizeBytes: number | null;
  /** True while the owning agent process still runs this session. */
  running: boolean;
}

export interface ProviderListResult {
  sessions: ProviderSession[];
  /** The store or the agent CLI exists on this machine. */
  detected: boolean;
  /** Where the data came from: a session directory, database, or CLI path. */
  detail: string;
  /** Whether this adapter can delete sessions right now. */
  deletable: boolean;
  /**
   * Size of the whole store (database files, session directories, snapshots).
   * Database-backed stores cannot attribute bytes to a single session, so the
   * panel shows this number next to the provider instead of guessing per row.
   */
  storeBytes: number | null;
  error: string | null;
}

export interface ProviderDeleteResult {
  deleted: string[];
  failures: { id: string; error: string }[];
}

export type ProviderExportResult =
  | { ok: true; bytes: number }
  | { ok: false; error: string };

export interface ProviderAdapter {
  /** Stable store id, matches the Paseo provider id where one exists. */
  id: string;
  label: string;
  list(): Promise<ProviderListResult>;
  delete(ids: string[]): Promise<ProviderDeleteResult>;
  /**
   * Writes a standalone copy of one session to `outPath` so the transcript
   * survives a delete. Adapters that cannot dump a session omit this method.
   */
  exportSession?(input: { id: string; outPath: string }): Promise<ProviderExportResult>;
  /** File name extension of the dump produced by `exportSession`. */
  exportExtension?: string;
}
