/**
 * "Open dashboard" decision logic (PLAN.md stage F2, `__doc.md` §6).
 *
 * Pure over **injected** openers — no React, no React Native, no SDK imports —
 * so the rule that matters is pinned by `tests/open-dashboard.test.ts`: prefer
 * Paseo's own workspace browser (`navigation.openBrowser`, Electron only), fall
 * back to the platform's external opener everywhere else, and never swallow the
 * URL when the host advertises a browser it cannot actually open.
 *
 * Why the openers are injected instead of imported: `client/slash.ts` set the
 * precedent (pure module + thin wiring), and for a hard reason — the SDK's
 * `@getpaseo/plugin/client` build exports `openExternalUrl` only from its
 * TypeScript source, so a test importing it in Node would see `undefined`.
 * `client/dashboard-screen.tsx` does the wiring.
 */

/**
 * Host capabilities the decision needs. The component builds this from
 * `PluginSurfaceProps.navigation`, `openExternalUrl` and `paseo.workspaces`.
 */
export interface DashboardOpeners {
  /**
   * `props.navigation?.openBrowser` — present only on Electron hosts, where the
   * browser runs locally and `serverId` selects the workspace ownership.
   */
  readonly openBrowser?: (input: { url: string; workspaceId: string }) => void;
  /** `openExternalUrl` — the platform opener, available everywhere. */
  readonly openExternal: (url: string) => Promise<void>;
  /**
   * Workspace ids known to this client, so a caller without a workspace context
   * (a global command, a screen without params) can still use the in-app
   * browser. Best effort: a failure simply means "no workspace".
   */
  readonly listWorkspaceIds?: () => Promise<readonly string[]>;
}

/** Which opener actually ran, and for which workspace. */
export interface DashboardOpenOutcome {
  /** `browser` = Paseo's in-app tab, `external` = the OS browser. */
  readonly via: "browser" | "external";
  /** Workspace that owns the in-app tab; `null` for the external opener. */
  readonly workspaceId: string | null;
}

/**
 * Only absolute `http`/`https` URLs may be handed to an opener. The URL comes
 * from the plugin's own server, so this is a cheap invariant rather than a
 * threat model: a future refactor that forwards a user-supplied string cannot
 * turn into a `javascript:`/`file:` navigation.
 */
export function isOpenableDashboardUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Opens the dashboard URL with the best available opener.
 *
 * Order (ADR-1): the in-app browser wins on Electron because the user stays in
 * Paseo and the tab is owned by the workspace; the external opener is the
 * fallback for every other host, for a host whose `openBrowser` throws, and for
 * a client that cannot name a workspace. Throws only for a URL that is not
 * openable at all — the caller turns that into a visible message.
 */
export async function openDashboardUrl(
  url: string,
  openers: DashboardOpeners,
  preferredWorkspaceId?: string,
): Promise<DashboardOpenOutcome> {
  if (!isOpenableDashboardUrl(url)) {
    throw new Error(`refusing to open a non-http dashboard URL: ${url}`);
  }

  const openBrowser = openers.openBrowser;
  if (openBrowser) {
    const workspaceId = await resolveWorkspaceId(openers, preferredWorkspaceId);
    if (workspaceId !== null) {
      try {
        openBrowser({ url, workspaceId });
        return { via: "browser", workspaceId };
      } catch {
        // A host that advertises the browser but cannot open it must not lose
        // the URL: fall through to the external opener.
      }
    }
  }

  await openers.openExternal(url);
  return { via: "external", workspaceId: null };
}

/** Preferred id first, then the first workspace this client knows; else null. */
async function resolveWorkspaceId(
  openers: DashboardOpeners,
  preferredWorkspaceId?: string,
): Promise<string | null> {
  if (preferredWorkspaceId !== undefined && preferredWorkspaceId.length > 0) {
    return preferredWorkspaceId;
  }
  if (!openers.listWorkspaceIds) return null;
  try {
    const ids = await openers.listWorkspaceIds();
    return ids.find((id) => id.length > 0) ?? null;
  } catch {
    return null;
  }
}
