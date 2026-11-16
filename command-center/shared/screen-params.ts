/**
 * Deep links through screen params (0.6.0, recommendation §12.3 item 4).
 *
 * `openScreen({ screenId, params })` carries a `Record<string, string>` into
 * `PluginScreenProps.params` (SDK 0.13+). The Command Center screen accepts:
 *
 * - `view=library|history|schedules|dashboard` — the tab to open;
 * - `command=<command id>` — focus that command in the library;
 * - `schedule=<schedule id>` — focus that schedule in the schedules tab;
 * - `run=<command id>` — open the run dialog prefilled for that command
 *   (0.13.0), so a favourite command is one link away from a run.
 *
 * Pure module (no React, no host imports) so the parsing rules are unit-tested
 * and the `/cc` slash command, the Command Center items and future callers all
 * share one definition of a valid link.
 */

export type ScreenView = "library" | "history" | "schedules" | "dashboard";

export interface ScreenParams {
  view: ScreenView;
  /** Command id to focus in the library; null = no focus. */
  commandId: string | null;
  /** Schedule id to focus in the schedules tab; null = no focus. */
  scheduleId: string | null;
  /** Command id whose run dialog opens prefilled (0.13.0); null = none. */
  runCommandId: string | null;
}

export const SCREEN_ID = "command-center";

/** Params for opening the screen on a tab, optionally focusing one item. */
export function screenParams(
  view: ScreenView,
  focus?: { commandId?: string; scheduleId?: string; runCommandId?: string },
): ScreenParams {
  return {
    view,
    commandId: focus?.commandId ?? null,
    scheduleId: focus?.scheduleId ?? null,
    runCommandId: focus?.runCommandId ?? null,
  };
}

/**
 * Parse raw `PluginScreenParams` into a validated {@link ScreenParams}.
 * Unknown views and empty values degrade to the defaults, so a hand-edited
 * link never breaks the screen.
 */
export function parseScreenParams(params: Record<string, string> | undefined): ScreenParams {
  const raw = params ?? {};
  const view = raw["view"];
  const parsedView: ScreenView =
    view === "history" || view === "schedules" || view === "dashboard" || view === "library"
      ? view
      : "library";
  const commandId = nonEmpty(raw["command"]);
  const scheduleId = nonEmpty(raw["schedule"]);
  const runCommandId = nonEmpty(raw["run"]);
  return {
    view: parsedView,
    // A schedule focus only makes sense on the schedules tab, a command focus
    // only on the library; keep both anyway (the caller may switch tabs), but
    // never carry empty strings as ids.
    commandId,
    scheduleId,
    runCommandId,
  };
}

/**
 * Screen header title for a deep link (0.13.0): `PluginScreenTitle` may be a
 * function of the params, so a link to a history or a schedule reads as that
 * place instead of the generic name.
 */
export function screenTitle(params: Record<string, string> | undefined): string {
  const parsed = parseScreenParams(params);
  if (parsed.runCommandId) return "Command Center — Run";
  if (parsed.view === "history") return "Command Center — History";
  if (parsed.view === "schedules") return "Command Center — Schedules";
  if (parsed.view === "dashboard") return "Command Center — Dashboard";
  return "Command Center";
}

/** The `openScreen` payload for a parsed/equal screen params value. */
export function toOpenScreenParams(params: ScreenParams): Record<string, string> {
  const out: Record<string, string> = { view: params.view };
  if (params.commandId) out["command"] = params.commandId;
  if (params.scheduleId) out["schedule"] = params.scheduleId;
  if (params.runCommandId) out["run"] = params.runCommandId;
  return out;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
