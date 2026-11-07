import * as path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { ConsoleEndpoint } from "./server/http-lifecycle";
import {
  consoleUrl,
  connectionLaunch,
  connectionsList,
  state,
  vaultSetup,
  vaultUnlock,
  vaultLock,
} from "./shared/rpc";
import { resolvePluginVersion } from "./server/paths";
import { launchExternalWindow } from "./server/protocols/external";
import { ExternalSessionRegistry } from "./server/sessions";
import { Store } from "./server/store";
import { TerminalService } from "./server/terminals";
import { VaultService } from "./server/vault";
import { defaultSshConfigPath } from "./server/ssh-config";
import { loadSettings, saveSettings, validateSettingsPatch } from "./server/settings";

export default function contribute(server: PluginServerContext): () => void {
  const paseoHome = process.env.PASEO_HOME ?? path.join(process.env.HOME ?? "", ".paseo");
  const store = new Store({ dbPath: `${paseoHome}/plugins/remote-control/remote-control.db` });

  // Settings live in the store (stage 0.25.11, G2): the console port, the
  // vault auto-lock, the pass store directory and the client overrides are
  // read once here and kept in `currentSettings`; every save applies them.
  let currentSettings = loadSettings(store, { storeDir: path.join(paseoHome, "pass-store") });

  const vault = new VaultService({
    storeDir: currentSettings.storeDir,
    autoLockMs: currentSettings.autoLockMinutes * 60_000,
    log: (m) => console.log(m),
  });

  // The Paseo SDK (terminals, workspaces) reaches plugin code only through
  // the RPC handler context. Every handler below refreshes it, and the
  // console is always opened right after a `console-url` call, so the
  // TerminalService has a live API by the time a terminal is requested.
  let paseo: PaseoApi | null = null;
  const capture = (context: { paseo: PaseoApi }): PaseoApi => {
    paseo = context.paseo;
    return paseo;
  };

  const terminals = new TerminalService({
    paseo: () => paseo,
    store,
    vault,
  });
  // RDP/VNC windows are detached desktop processes, not Paseo terminals: the
  // registry makes them visible and killable in the console's Sessions view.
  const sessions = new ExternalSessionRegistry();

  const endpoint = new ConsoleEndpoint({
    log: (m) => console.log(m),
    logError: (m) => console.error(m),
    terminals,
    sessions,
    store,
    vault,
    sshConfigPath: defaultSshConfigPath(),
    settings: {
      load: () => currentSettings,
      save: (patch) => {
        const previous = currentSettings;
        const next = saveSettings(store, validateSettingsPatch(previous, patch));
        currentSettings = next;
        vault.setAutoLockMs(next.autoLockMinutes * 60_000);
        if (next.storeDir !== previous.storeDir) vault.reconfigureStore(next.storeDir);
        const restart = next.consolePort !== previous.consolePort;
        if (restart) {
          // ConsoleEndpoint debounces and restarts the listener (0.25.11).
          endpoint.sync({ enabled: true, port: next.consolePort, accessToken: "" });
        }
        return { settings: next, restart };
      },
    },
  });

  // Live Sessions view (G1): a registered/killed/pruned RDP or VNC window is
  // pushed over SSE, so the table updates without waiting for its poll.
  sessions.onChange = (list) => endpoint.broadcast("sessions", { sessions: list });

  endpoint.sync({ enabled: true, port: currentSettings.consolePort, accessToken: "" });
  void endpoint.settled();

  server.handle(consoleUrl, (input, context) => {
    capture(context);
    return { url: endpoint.url() };
  });
  server.handle(state, (input, context) => {
    capture(context);
    const status = endpoint.status();
    const v = vault.status();
    return {
      consoleUrl: status.url,
      listening: status.listening,
      version: resolvePluginVersion(),
      vault: { initialized: v.initialized, unlocked: v.unlocked, entries: v.entries.length },
    };
  });
  server.handle(vaultSetup, async (input, context) => {
    capture(context);
    return await vault.setup(input.password, input.keyId);
  });
  server.handle(vaultUnlock, async (input, context) => {
    capture(context);
    return await vault.unlock(input.password);
  });
  server.handle(vaultLock, (input, context) => {
    capture(context);
    vault.lock();
    return { ok: true };
  });
  server.handle(connectionsList, (input, context) => {
    capture(context);
    return {
      groups: store.listGroups().map((group) => ({
        id: group.id,
        name: group.name,
        parentId: group.parentId,
      })),
      connections: store.listConnections().map((connection) => ({
        id: connection.id,
        groupId: connection.groupId,
        name: connection.name,
        protocol: connection.protocol,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        hasPassword: Boolean(connection.secretRefs?.passwordSecret ?? connection.secretRefs?.password),
      })),
    };
  });
  server.handle(connectionLaunch, async (input, context) => {
    capture(context);
    const connection = store.getConnection(input.connectionId);
    if (!connection) throw new Error(`Connection not found: ${input.connectionId}`);
    if (connection.protocol === "ssh") {
      const terminal = await terminals.open({
        workspaceId: input.workspaceId,
        connectionId: connection.id,
      });
      return { kind: "terminal" as const, terminalId: terminal.id, name: terminal.name };
    }
    const launched = await launchExternalWindow(connection, {
      vault,
      sessions,
      rdpBinary: currentSettings.rdpBinary,
      vncBinary: currentSettings.vncBinary,
      log: (message) => console.log(message),
    });
    return {
      kind: "external" as const,
      pid: launched.pid,
      binary: launched.binary,
      ...(launched.sessionId ? { sessionId: launched.sessionId } : {}),
    };
  });

  console.log(`[remote-control] plugin ready (version ${resolvePluginVersion()})`);

  return async () => {
    vault.lock();
    terminals.dispose();
    sessions.dispose();
    store.close();
    await endpoint.dispose();
  };
}
