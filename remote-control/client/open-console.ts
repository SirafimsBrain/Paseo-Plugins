export interface ConsoleOpeners {
  readonly openBrowser?: (input: { url: string; workspaceId: string }) => void;
  readonly openExternal: (url: string) => Promise<void>;
  readonly listWorkspaceIds?: () => Promise<readonly string[]>;
}

export interface ConsoleOpenOutcome {
  readonly via: "browser" | "external";
  readonly workspaceId: string | null;
}

export function isOpenableConsoleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The console creates workspace terminals, so it needs to know which
 * workspace it belongs to: that workspace is where the terminals become tabs.
 */
export function withWorkspaceParam(url: string, workspaceId: string): string {
  if (workspaceId.length === 0) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("workspaceId", workspaceId);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Extra console params (stage 0.25.11, G3): the screen passes the action it
 * was opened with — `/remote new` and the "New remote connection" Command
 * Center item land on the connection form instead of the Sessions list.
 */
export function withConsoleParams(url: string, params: Record<string, string> = {}): string {
  try {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      if (value.length > 0) parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export async function openConsoleUrl(
  url: string,
  openers: ConsoleOpeners,
  preferredWorkspaceId?: string,
  params: Record<string, string> = {},
): Promise<ConsoleOpenOutcome> {
  if (!isOpenableConsoleUrl(url)) {
    throw new Error(`refusing to open a non-http console URL: ${url}`);
  }

  const openBrowser = openers.openBrowser;
  if (openBrowser) {
    const workspaceId = await resolveWorkspaceId(openers, preferredWorkspaceId);
    if (workspaceId !== null) {
      try {
        openBrowser({ url: withConsoleParams(withWorkspaceParam(url, workspaceId), params), workspaceId });
        return { via: "browser", workspaceId };
      } catch {
        // fall through
      }
    }
  }

  await openers.openExternal(withConsoleParams(url, params));
  return { via: "external", workspaceId: null };
}

async function resolveWorkspaceId(
  openers: ConsoleOpeners,
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
