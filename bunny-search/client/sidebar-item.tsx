import { useCallback, useEffect, useState } from "react";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import {
  connectionStatus,
  statusStream,
  type ConnectionStatus,
} from "../shared/contracts";
import { SCREEN_ID } from "./screen-id";

/**
 * Sidebar header row for the Bunny Search screen, with a live status dot (0.8.7).
 *
 * The dot answers "is my web search working?" without opening anything: green when the
 * last connection test passed, red when it failed, muted before the first test. It is
 * fed by the same `statusStream` subscription the screen uses, so a test run in
 * Settings updates the sidebar immediately, and by one `connectionStatus` read on
 * mount for the case where no event has been pushed yet.
 *
 * The dot renders in `SidebarRow.trailing`, beside the row's pressable, so pressing the
 * row still opens the screen and pressing the dot does nothing.
 */

/** One event of `bunny-search.status-stream` carries a complete status snapshot. */
interface StatusEvent {
  status: ConnectionStatus | null;
}

export function BunnySearchSidebarItem({
  currentScreen,
  openScreen,
  theme,
}: PluginSidebarItemProps) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const statusRpc = useRpc(connectionStatus);

  const onEvent = useCallback((event: StatusEvent) => {
    if (event.status) setStatus(event.status);
  }, []);
  useSubscription(statusStream, {}, onEvent);

  useEffect(() => {
    void statusRpc({})
      .then((result) => setStatus(result))
      .catch(() => undefined);
  }, [statusRpc]);

  const lastCheck = status?.lastCheck ?? null;
  const color = lastCheck
    ? lastCheck.ok
      ? theme.colors.statusSuccess
      : theme.colors.statusDanger
    : theme.colors.foregroundMuted;

  return (
    <SidebarRow
      icon="Globe"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
      trailing={
        <View
          accessibilityLabel={
            lastCheck
              ? lastCheck.ok
                ? "Web search connected"
                : "Web search connection failed"
              : "Web search not checked yet"
          }
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }}
        />
      }
    />
  );
}
