import type { SessionManagerIntent } from "./intent";

/**
 * `/sessions` argument parsing (0.7.0).
 *
 * The slash command is the third way into the panel (sidebar, Command Center,
 * chat), and it reuses the intent channel those entry points already write: the
 * command only turns text into an intent and lets the panel apply it. Kept as a
 * pure function so the grammar is testable without a host.
 *
 *   /sessions                → panel, current filters
 *   /sessions old            → older than 30 days, those rows selected
 *   /sessions old 7          → older than 7 days
 *   /sessions archived       → archived Paseo agents only, selected
 *   /sessions settings       → the cleanup settings screen
 */
export interface SessionSlashResult {
  /** Intent to hand the panel, or null to open it unchanged. */
  intent: SessionManagerIntent | null;
  /** Open the plugin's settings screen instead of the panel. */
  openSettings: boolean;
}

const DEFAULT_OLD_DAYS = 30;

export function parseSessionArgs(raw: string): SessionSlashResult {
  const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { intent: null, openSettings: false };

  if (tokens.includes("settings") || tokens.includes("config")) {
    return { intent: null, openSettings: true };
  }

  const intent: SessionManagerIntent = {};
  if (tokens.includes("archived")) intent.archivedOnly = true;

  // `old 7` names the filter and its value in either order, so the number wins
  // wherever it sits in the argument.
  if (tokens.some((token) => /^(\d+|old|older|age)$/.test(token))) {
    const numeric = tokens.find((token) => /^\d+$/.test(token));
    const parsed = numeric === undefined ? DEFAULT_OLD_DAYS : Number.parseInt(numeric, 10);
    intent.ageDays = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OLD_DAYS;
  }

  if (intent.ageDays === undefined && intent.archivedOnly === undefined) {
    // An argument we do not know: open the panel rather than guess a filter.
    return { intent: null, openSettings: false };
  }
  // Both filters select what they show, matching the Command Center items.
  intent.selectShown = true;
  return { intent, openSettings: false };
}
