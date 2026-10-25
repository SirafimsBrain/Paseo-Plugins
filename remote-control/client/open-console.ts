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

export async function openConsoleUrl(
  url: string,
  openers: ConsoleOpeners,
  preferredWorkspaceId?: string,
): Promise<ConsoleOpenOutcome> {
  if (!isOpenableConsoleUrl(url)) {
    throw new Error(`refusing to open a non-http console URL: ${url}`);
  }

  const openBrowser = openers.openBrowser;
  if (openBrowser) {
    const workspaceId = await resolveWorkspaceId(openers, preferredWorkspaceId);
    if (workspaceId !== null) {
      try {
        openBrowser({ url, workspaceId });
        return { via: "browser", workspaceId };
      } catch {
        // fall through
      }
    }
  }

  await openers.openExternal(url);
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
