/**
 * Memory policy (owner decision, 0.3.0).
 *
 * - up to 2 GB RSS: normal, nothing is shown;
 * - 2–4 GB RSS: reported as a warning in the panel and in status output;
 * - the project never imposes a hard memory limit — even above 4 GB it is a
 *   stronger warning, not a refusal to work.
 *
 * The numbers are deliberately constants: they describe a product decision,
 * not a tunable of the deployment.
 */

export const MEMORY_NORMAL_BYTES = 2 * 1024 ** 3;
export const MEMORY_WARN_BYTES = 4 * 1024 ** 3;

export type MemoryLevel = "ok" | "warning" | "high";

export interface MemoryReport {
  rssMb: number;
  level: MemoryLevel;
  note: string | null;
}

export function memoryReport(rssBytes: number): MemoryReport {
  const rssMb = Math.round(rssBytes / 1024 / 1024);
  if (rssBytes < MEMORY_NORMAL_BYTES) return { rssMb, level: "ok", note: null };
  if (rssBytes < MEMORY_WARN_BYTES) {
    return {
      rssMb,
      level: "warning",
      note:
        `The plugin process is using ${rssMb} MB. Up to 2 GB is unremarkable for ` +
        "in-process embeddings; 2–4 GB is a warning, not a limit of this plugin.",
    };
  }
  return {
    rssMb,
    level: "high",
    note:
      `The plugin process is using ${rssMb} MB, above the 4 GB warning band. ` +
      "This is still not a hard limit of the plugin — it is a signal to check the " +
      "machine, close other agents, or turn semantic search off.",
  };
}
