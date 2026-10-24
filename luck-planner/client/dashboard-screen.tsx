import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PluginScreenProps,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { openExternalUrl, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { dashboardStatus, type DashboardStatus } from "../shared/rpc";
import { openDashboardUrl, type DashboardOpeners } from "./open-dashboard";
import { scaledFont } from "./host-font-scale";
import { useHostFontScale } from "./use-host-typography";

/**
 * "Open dashboard" action (PLAN.md stage F2, `__doc.md` §6).
 *
 * Two entry points, one code path:
 * - the **workspace panel** button calls {@link openDashboard} directly (it
 *   already knows the project and its workspace);
 * - the **⌘K item** opens the {@link LUCK_PLANNER_DASHBOARD_SCREEN_ID} screen,
 *   which calls the same function on mount. A Command Center callback has no
 *   `navigation` (only surfaces/panels/screens do), so a screen is the only
 *   SDK-supported way for a ⌘K item to reach Paseo's own browser; it also gives
 *   the user a visible "opened / why not" card with the URL.
 *
 * The decision itself lives in the pure `client/open-dashboard.ts`; this module
 * is the thin, host-facing glue (it is the one place that imports
 * `openExternalUrl` and `paseo`).
 */

/** Screen id of the ⌘K "Open dashboard" card. */
export const LUCK_PLANNER_DASHBOARD_SCREEN_ID = "luck-planner-dashboard";

/** What the screen reads from its URL params. */
export const DASHBOARD_PROJECT_PARAM = "projectKey";
export const DASHBOARD_WORKSPACE_PARAM = "workspaceId";

/** Result of {@link openDashboard}, rendered verbatim by both entry points. */
export interface DashboardOpenReport {
  /** `browser`/`external` = opened; `unavailable`/`error` = not opened. */
  outcome: "browser" | "external" | "unavailable" | "error";
  /** The URL that was (or would have been) opened; null when unknown. */
  url: string | null;
  /** One-line human message for the UI. */
  message: string;
}

export interface DashboardOpenRequest {
  /** Canonical project key of the workspace (ADR-2). */
  projectKey: string;
  /** Workspace whose tab should host the dashboard, when known. */
  workspaceId?: string;
  /** `useRpc(dashboardStatus)` of the calling component. */
  readStatus: (input: { projectKey: string }) => Promise<DashboardStatus>;
  /** Props of the calling surface/panel/screen — for `navigation`. */
  props: PluginSurfaceProps;
  /** `usePaseo()` of the calling component — for the workspace list. */
  paseo: ReturnType<typeof usePaseo>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Resolves the dashboard URL for `projectKey` and hands it to the best opener
 * (in-app browser on Electron, external opener otherwise). Never throws: every
 * failure becomes a report the UI can show, because a dashboard that refuses to
 * open must say *why* (disabled, not listening, no workspace).
 */
export async function openDashboard(
  request: DashboardOpenRequest,
): Promise<DashboardOpenReport> {
  let status: DashboardStatus;
  try {
    status = await request.readStatus({ projectKey: request.projectKey });
  } catch (cause) {
    return {
      outcome: "error",
      url: null,
      message: `Could not reach the plugin server: ${messageOf(cause)}`,
    };
  }

  if (!status.enabled) {
    return {
      outcome: "unavailable",
      url: null,
      message:
        "The dashboard HTTP server is off — enable it in Paseo Settings → Plugins → Luck Planner.",
    };
  }
  if (!status.listening || status.url === null) {
    return {
      outcome: "unavailable",
      url: null,
      message:
        status.error ??
        "The dashboard server is not listening — check its port in the plugin settings.",
    };
  }

  const openers: DashboardOpeners = {
    openBrowser: request.props.navigation?.openBrowser,
    openExternal: (url) => openExternalUrl(url),
    listWorkspaceIds: async () => {
      const { entries } = await request.paseo.workspaces.list();
      return entries.map((entry: { id: string }) => entry.id);
    },
  };

  try {
    const result = await openDashboardUrl(status.url, openers, request.workspaceId);
    return {
      outcome: result.via,
      url: status.url,
      message:
        result.via === "browser"
          ? "Opened in a Paseo browser tab."
          : "Opened in your external browser.",
    };
  } catch (cause) {
    return { outcome: "error", url: status.url, message: messageOf(cause) };
  }
}

/** Status colour for a report outcome. */
function reportColor(
  outcome: DashboardOpenReport["outcome"],
  colors: PluginScreenProps["theme"]["colors"],
): string {
  switch (outcome) {
    case "browser":
    case "external":
      return colors.statusSuccess;
    case "unavailable":
      return colors.statusWarning;
    default:
      return colors.statusDanger;
  }
}

/**
 * ⌘K target: opens the dashboard once on mount and keeps the address visible so
 * the tab can be reopened (or copied) after the fact.
 */
export function LuckPlannerDashboardScreen(props: PluginScreenProps) {
  const { theme, params, layout } = props;
  const fontScale = useHostFontScale();
  const font = (base: number) => scaledFont(base, fontScale);
  const paseo = usePaseo();
  const statusRpc = useRpc(dashboardStatus);
  // Phones and narrow windows get the compact spacing the host asks for.
  const compact = layout.compact;
  const containerStyle = { padding: compact ? 12 : 16 };

  const projectKey = params[DASHBOARD_PROJECT_PARAM] ?? "";
  const workspaceId = params[DASHBOARD_WORKSPACE_PARAM] || undefined;

  const [report, setReport] = useState<DashboardOpenReport | null>(null);
  const [opening, setOpening] = useState(false);
  const autoOpened = useRef(false);

  const run = useCallback(async () => {
    setOpening(true);
    try {
      setReport(
        await openDashboard({
          projectKey,
          workspaceId,
          readStatus: (input) => statusRpc(input),
          props,
          paseo,
        }),
      );
    } finally {
      setOpening(false);
    }
  }, [paseo, projectKey, props, statusRpc, workspaceId]);

  useEffect(() => {
    // Once per mounted screen: reopening on every render would spawn a tab per
    // keystroke of an unrelated setting. The button below reopens on demand.
    if (autoOpened.current) return;
    autoOpened.current = true;
    if (projectKey.length === 0) return;
    void run();
  }, [projectKey, run]);

  const colors = theme.colors;
  const fg = colors.foreground;
  const fgMuted = colors.foregroundMuted;
  const border = colors.border;
  const accent = colors.accent;

  if (projectKey.length === 0) {
    return (
      <View style={[styles.container, containerStyle]}>
        <Text style={{ color: fgMuted, fontSize: font(13) }}>
          Open this screen from a workspace (⌘K → “Open luck-planner dashboard”)
          so the dashboard knows which project to show.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, containerStyle]}>
      <Text style={{ color: fg, fontSize: font(15), fontWeight: "600" }}>
        Luck Planner dashboard
      </Text>
      <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 4 }}>
        {projectKey}
      </Text>

      <View style={[styles.card, { borderColor: border }]}>
        {opening && report === null ? (
          <Text style={{ color: fgMuted, fontSize: font(13) }}>Opening…</Text>
        ) : report ? (
          <Text
            style={{ color: reportColor(report.outcome, colors), fontSize: font(13) }}
          >
            {report.message}
          </Text>
        ) : (
          <Text style={{ color: fgMuted, fontSize: font(13) }}>
            The dashboard opens in a browser tab.
          </Text>
        )}
        {report?.url ? (
          // The address is a real link: on a host where the in-app tab did not
          // open (or was closed), one tap reaches the dashboard in the system
          // browser.
          <ExternalLink
            href={report.url}
            accessibilityLabel="Open the dashboard in your browser"
          >
            <Text
              selectable
              numberOfLines={3}
              style={{ color: accent, fontSize: font(11), marginTop: 6 }}
            >
              {report.url}
            </Text>
          </ExternalLink>
        ) : null}
      </View>

      <Pressable
        accessibilityRole="button"
        disabled={opening}
        onPress={() => void run()}
        style={[styles.button, { borderColor: border }]}
      >
        <Text style={{ color: accent, fontSize: font(13), opacity: opening ? 0.5 : 1 }}>
          {opening ? "Opening…" : "Open again"}
        </Text>
      </Pressable>

      <Text style={{ color: fgMuted, fontSize: font(11), marginTop: 12 }}>
        The dashboard is served by the plugin on 127.0.0.1 and protected by the
        access token in the URL. If it does not open, check “Serve the dashboard
        HTTP endpoint” in Paseo Settings → Plugins → Luck Planner.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  card: {
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    marginTop: 12,
  },
  button: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 12,
    alignSelf: "flex-start",
  },
});
