import { openExternalUrl, usePaseo } from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

/**
 * Opens the search service's web interface.
 *
 * On Electron hosts (the Paseo desktop app) the URL opens
 * inside Paseo's own browser tab (`navigation.openBrowser`),
 * so the user stays in the app. Everywhere else — and when
 * no workspace can be resolved for the in-app browser — it
 * falls back to the client platform's external opener.
 */
export async function openSearchInterfaceUrl(
  url: string,
  props: PluginSurfaceProps,
  paseo: ReturnType<typeof usePaseo>,
): Promise<void> {
  const openBrowser = props.navigation?.openBrowser;
  if (openBrowser) {
    try {
      const { entries } = await paseo.workspaces.list();
      const workspaceId = entries[0]?.id;
      if (workspaceId) {
        openBrowser({ url, workspaceId });
        return;
      }
    } catch {
      // Fall through to the external opener.
    }
  }
  await openExternalUrl(url);
}
