import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { CommandDefinition, HistoryEntry } from "./commands";

/** Escapes text for HTML text nodes and attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface DashboardData {
  commands: CommandDefinition[];
  history: HistoryEntry[];
  now: Date;
}

function typeLabel(command: CommandDefinition): string {
  if (command.type === "workflow") return `workflow · ${command.steps.length} steps`;
  if (command.type === "shell") return "shell";
  return command.provider ?? "prompt";
}

/**
 * Server-rendered, read-only dashboard (roadmap §8 item 9, shipped in 0.12.0).
 *
 * The whole point is that a phone or another browser on the same machine can
 * *look* at the library and the run history without the Paseo app. It is
 * deliberately not an API: no forms, no actions, no writes. Pure and dependency
 * free, so `tests/dashboard.test.ts` can assert the output without sockets.
 */
export function renderDashboardHtml(data: DashboardData): string {
  const runs = data.history.slice(0, 50);
  const rows = data.commands
    .map(
      (command) => `<tr>
      <td class="name">${escapeHtml(command.favorite ? `★ ${command.name}` : command.name)}</td>
      <td class="badge">${escapeHtml(typeLabel(command))}</td>
      <td>${escapeHtml(command.category ?? "—")}</td>
      <td class="num">${command.useCount}</td>
    </tr>`,
    )
    .join("\n");

  const historyRows = runs
    .map(
      (entry) => `<tr class="${entry.ok ? "ok" : "failed"}">
      <td class="when">${escapeHtml(new Date(entry.at).toLocaleString())}</td>
      <td class="name">${escapeHtml(entry.commandName)}</td>
      <td class="badge">${escapeHtml(entry.ok ? entry.kind : "failed")}</td>
      <td class="rendered">${escapeHtml(entry.error ?? entry.rendered)}</td>
    </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="10">
<title>Command Center</title>
<style>
  :root { color-scheme: light dark; --fg: #1b1b1f; --muted: #666; --bg: #fff; --line: #ddd; --ok: #1a7f4b; --fail: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --muted: #9a9aa5; --bg: #16161a; --line: #2c2c33; --ok: #6fd39b; --fail: #ff8a80; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  h1 { font-size: 18px; margin: 0 0 2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 24px 0 6px; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.name { font-weight: 600; }
  td.badge { color: var(--muted); font-size: 12px; white-space: nowrap; }
  td.rendered { font-family: ui-monospace, monospace; font-size: 12px; max-width: 52ch; overflow-wrap: anywhere; }
  tr.failed td { color: var(--fail); }
  tr.ok td.badge { color: var(--ok); }
  .empty { color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<h1>Command Center</h1>
<div class="sub">Read-only · ${data.commands.length} ${data.commands.length === 1 ? "command" : "commands"} · generated ${escapeHtml(data.now.toLocaleString())} · refreshes every 10 s</div>

<h2>Commands</h2>
${
  data.commands.length === 0
    ? '<p class="empty">No commands saved yet.</p>'
    : `<table>
<thead><tr><th>Name</th><th>Type</th><th>Category</th><th class="num">Runs</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
}

<h2>Recent runs</h2>
${
  runs.length === 0
    ? '<p class="empty">Nothing has run yet.</p>'
    : `<table>
<thead><tr><th>When</th><th>Command</th><th>Result</th><th>Rendered / error</th></tr></thead>
<tbody>
${historyRows}
</tbody>
</table>`
}
</body>
</html>`;
}

/**
 * Starts (lazily) the loopback dashboard and returns its URL, including the
 * one-time token. The token is generated per process: the page is read-only,
 * but the store contains prompt text and history, so an unauthenticated local
 * port would still be an information leak to any other local process.
 */
export const openDashboard = defineRpc({
  name: "command-center.dashboard",
  input: z.object({}),
  output: z.object({
    url: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
