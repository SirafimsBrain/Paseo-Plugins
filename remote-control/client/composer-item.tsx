import { useEffect, useState } from "react";
import type { PluginComposerItemProps } from "@getpaseo/plugin/client";
import { useComposer, useRpc } from "@getpaseo/plugin/client";
import { Action } from "@getpaseo/plugin/client/ui";
import { connectionShellLine, type ConnectionRow } from "./connection-tree";
import { connectionsList } from "../shared/rpc";

/**
 * "Connect to host" in the composer (stage 1.1.0, Paseo 0.16.0
 * `addComposerItem`).
 *
 * Takes the ssh connections from the library and inserts the line that opens
 * one — `ssh -p 2222 user@host` — at the cursor. The useful case is an agent
 * that should run something on that machine: the prompt can now say where,
 * without the user retyping a host and a port.
 *
 * RDP/VNC have no shell line (the plugin launches their windows), so they are
 * left out. The list is read once per composer: connections change in the
 * console, not while a prompt is being typed.
 */

/** More than this and the composer row would be all buttons. */
const MAX_ACTIONS = 3;

export function RemoteControlComposerItem(_props: PluginComposerItemProps) {
  const composer = useComposer();
  const connectionsRpc = useRpc(connectionsList);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    connectionsRpc({})
      .then((list) => {
        if (cancelled) return;
        setConnections(list.connections.filter((connection) => connectionShellLine(connection) !== null));
      })
      .catch(() => {
        // No library yet, or the daemon is reconnecting: no actions to offer.
      });
    return () => {
      cancelled = true;
    };
  }, [connectionsRpc]);

  if (connections.length === 0) return null;

  return (
    <>
      {connections.slice(0, MAX_ACTIONS).map((connection) => {
        const line = connectionShellLine(connection);
        if (line === null) return null;
        return (
          <Action
            key={connection.id}
            title={`Insert ${line}`}
            icon="Terminal"
            onPress={() => composer.insertText(line)}
          />
        );
      })}
    </>
  );
}
