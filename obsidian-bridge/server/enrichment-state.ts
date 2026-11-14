import * as fs from "node:fs";
import * as path from "node:path";
import { pluginDataDir } from "./paths";

/**
 * Live vault-event subscription state, shared with the MCP server.
 *
 * The event streams belong to the plugin process: each agent spawns its own
 * stdio MCP server, and that process has no subscription of its own. Without a
 * record on disk `obsidian_status` could only guess, and it used to report
 * `events: false` even while four streams were connected. The plugin writes
 * the state here on every transition (probe result, subscription, last event,
 * stop) and the MCP server reads it, so an agent's answer describes the plugin
 * that owns the vault rather than its own short-lived process.
 */

export interface EnrichmentEventState {
  /** True while the plugin holds vault event streams open. */
  events: boolean;
  /** ISO timestamp of the last vault event the plugin received. */
  lastEventAt: string | null;
}

export const EMPTY_EVENT_STATE: EnrichmentEventState = { events: false, lastEventAt: null };

/** `$PASEO_HOME/plugins/obsidian-bridge/enrichment-state.json`. */
export function enrichmentStatePath(): string {
  return path.join(pluginDataDir(), "enrichment-state.json");
}

/** Best effort: a failed write must never break enrichment itself. */
export function writeEnrichmentState(state: EnrichmentEventState): void {
  const target = enrichmentStatePath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(
      temp,
      JSON.stringify({ events: state.events, lastEventAt: state.lastEventAt }),
      { encoding: "utf-8", mode: 0o600 },
    );
    fs.renameSync(temp, target);
  } catch {
    // The status is diagnostics only; reads fall back to "unknown events".
  }
}

/** Reads the plugin's last published state; missing or broken = nothing live. */
export function readEnrichmentState(filePath: string = enrichmentStatePath()): EnrichmentEventState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...EMPTY_EVENT_STATE };
    }
    const record = parsed as Record<string, unknown>;
    return {
      events: record.events === true,
      lastEventAt: typeof record.lastEventAt === "string" ? record.lastEventAt : null,
    };
  } catch {
    return { ...EMPTY_EVENT_STATE };
  }
}
