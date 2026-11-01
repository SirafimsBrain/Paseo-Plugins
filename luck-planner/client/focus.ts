/**
 * Client-side focus handoff for the workspace panel (0.35.1, recommendation
 * §10.8 item 5).
 *
 * `/luck-status` resolves the leaf it just moved, but `openPanel(id)` in
 * Paseo 0.14.0 carries no params channel (`PluginOpenPanelOptions` is only
 * `{ location }`, and `PluginWorkspacePanelParams` is an empty interface) —
 * the params contract of this plugin belongs to *screens*
 * (`openScreen({ screenId, params })`). So the request travels through this
 * mailbox instead: the slash command and the panel are registered by the
 * same client entry, therefore live in the same JS realm, and a module-level
 * slot is the shortest path between them.
 *
 * Semantics: a request is stored once and consumed once. A mounted panel is
 * notified through its subscription and takes the request; a panel that is
 * closed takes it the next time it mounts, so a command run with the panel
 * closed still lands on its record when the panel opens. Requests are keyed
 * by project (ADR-2): a request for another workspace's project is never
 * consumed by this panel.
 *
 * Pure module state — no React, no DOM, no SDK imports — so the whole
 * contract is unit-testable (tests/focus.test.ts).
 */

export interface FocusRequest {
  /** Canonical project key of the workspace (ADR-2). */
  projectKey: string;
  /** Node id the panel should select and reveal. */
  nodeId: string;
}

let pending: FocusRequest | null = null;
const listeners = new Set<() => void>();

/**
 * Records a focus request and wakes every subscribed panel. The pending
 * slot is kept until a panel *takes* it, so a request made while no panel
 * is mounted survives until one opens.
 */
export function requestFocus(projectKey: string, nodeId: string): void {
  pending = { projectKey, nodeId };
  for (const listener of [...listeners]) listener();
}

/**
 * Subscribes a panel to focus requests. The listener only signals — the
 * panel pulls the request with {@link takePendingFocus}, so a stale
 * subscriber that never pulls cannot consume anything by accident.
 */
export function subscribeFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Consumes the pending request when it targets `projectKey`; clears it in
 * every other case (a request for another project must not leak into the
 * next mount of this one).
 */
export function takePendingFocus(projectKey: string): FocusRequest | null {
  if (pending === null) return null;
  const request = pending;
  pending = null;
  return request.projectKey === projectKey ? request : null;
}
