import type { TerminalRef, WorkspaceRef } from "@getpaseo/plugin/client";

/**
 * Entity references for the sidebar view's navigation (stage 1.1.2, Paseo
 * 0.17.1 recommendation 1).
 *
 * `PluginSidebarViewProps.navigation` addresses workspaces and terminals by
 * `WorkspaceRef` / `TerminalRef` — `{ kind, key, hostId, id }` — and the host
 * only hands those out for the entities it is showing (`active.workspace`).
 * A live remote session, however, is known to this plugin by id alone, so the
 * ref is built here with the same identity the SDK's own `createEntityRefs`
 * produces: `key` is `JSON.stringify([hostId, id])` (`@getpaseo/plugin`,
 * `dist/client/refs.js`), and the object is frozen like the host's.
 *
 * The host id is the one the sidebar view was rendered for: remote sessions
 * belong to the workspace they were opened from, which lives on that host.
 * When no workspace is active there is no host id and the callers do not
 * offer the jump at all.
 */
export function workspaceRef(hostId: string, workspaceId: string): WorkspaceRef {
  return Object.freeze({
    kind: "workspace" as const,
    key: JSON.stringify([hostId, workspaceId]),
    hostId,
    id: workspaceId,
  });
}

export function terminalRef(hostId: string, terminalId: string): TerminalRef {
  return Object.freeze({
    kind: "terminal" as const,
    key: JSON.stringify([hostId, terminalId]),
    hostId,
    id: terminalId,
  });
}
