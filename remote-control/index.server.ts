import * as fs from "node:fs";
import * as path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { ConsoleEndpoint } from "./server/http-lifecycle";
import {
  consoleUrl,
  connectionLaunch,
  connectionsList,
  exportBundle,
  exportStatus,
  state,
  vaultSetup,
  vaultUnlock,
  vaultLock,
  workspaceActivity,
} from "./shared/rpc";
import { activityStream, type ActivityReason, type ActivitySnapshot } from "./shared/activity";
import {
  activitySnapshot,
  clearActivity,
  publishActivity,
  setActivityProvider,
  subscribeActivity,
} from "./server/activity";
import { buildExportBundle } from "./server/transfer";
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
    // Stage 1.1.0: setup, unlock and lock (including the auto-lock timer) move
    // the "storage: unlocked" line in every open panel, not just the one that
    // asked.
    onChange: () => publishActivity("vault"),
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
    onChange: () => publishActivity("terminals"),
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
  // pushed over SSE, so the table updates without waiting for its poll. The
  // same moment feeds the plugin subscription (stage 1.1.0), which is what the
  // Paseo-side panels read.
  sessions.onChange = (list) => {
    endpoint.broadcast("sessions", { sessions: list });
    publishActivity("sessions");
  };

  endpoint.sync({ enabled: true, port: currentSettings.consolePort, accessToken: "" });
  void endpoint.settled();

  // One snapshot builder for every producer (stage 1.1.0): the terminal service,
  // the session registry, the vault and the console endpoint all answer here,
  // and `remote-control.activity` pushes the result to every client.
  const buildSnapshot = (reason: ActivityReason): ActivitySnapshot => {
    const v = vault.status();
    return {
      at: new Date().toISOString(),
      reason,
      listening: endpoint.status().listening,
      consoleUrl: endpoint.url(),
      vault: { initialized: v.initialized, unlocked: v.unlocked, entries: v.entries.length },
      terminals: terminals.liveTerminals().map((terminal) => ({
        id: terminal.id,
        workspaceId: terminal.workspaceId,
        name: terminal.name,
        connectionId: terminal.connectionId,
        kind: terminal.kind,
        startedAt: terminal.startedAt,
      })),
      sessions: sessions.list().map((session) => ({
        id: session.id,
        kind: session.kind,
        name: session.name,
        connectionId: session.connectionId,
        workspaceId: session.workspaceId,
        target: session.target,
        state: session.state,
        exitCode: session.exitCode,
        startedAt: session.startedAt,
        exitedAt: session.exitedAt,
      })),
    };
  };
  setActivityProvider(buildSnapshot);

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
    const api = capture(context);
    const connection = store.getConnection(input.connectionId);
    if (!connection) throw new Error(`Connection not found: ${input.connectionId}`);
    // Stage 1.1.0 (Paseo 0.16.0 plugin metadata): the workspace remembers the
    // connection it was last opened for, so the badge, the New workspace item
    // and any other plugin can tell where this workspace belongs. Best effort
    // only — a host that rejects the patch does not fail the launch.
    const stamp = () =>
      api.workspaces
        .ref(input.workspaceId)
        .setMetadata({
          "remote-control": {
            connectionId: connection.id,
            connectionName: connection.name,
            protocol: connection.protocol,
            host: connection.host,
            at: new Date().toISOString(),
          },
        })
        .catch(() => undefined);
    if (connection.protocol === "ssh") {
      const terminal = await terminals.open({
        workspaceId: input.workspaceId,
        connectionId: connection.id,
      });
      await stamp();
      return { kind: "terminal" as const, terminalId: terminal.id, name: terminal.name };
    }
    const launched = await launchExternalWindow(connection, {
      vault,
      sessions,
      workspaceId: input.workspaceId,
      rdpBinary: currentSettings.rdpBinary,
      vncBinary: currentSettings.vncBinary,
      log: (message) => console.log(message),
    });
    await stamp();
    return {
      kind: "external" as const,
      pid: launched.pid,
      binary: launched.binary,
      ...(launched.sessionId ? { sessionId: launched.sessionId } : {}),
    };
  });

  // --- Live activity (Paseo 0.16.0 subscriptions, stage 1.1.0) -------------
  // Pushes the current snapshot on subscribe and again on every change, so the
  // panel, the screen and the workspace badge stop polling `state`.
  server.handle(activityStream, async (_input, context) => {
    let closed = false;
    const initial = activitySnapshot("snapshot");
    if (initial) await context.push(initial);
    const unsubscribe = subscribeActivity((snapshot) => {
      if (closed) return;
      void context.push(snapshot).catch((cause: unknown) => {
        console.warn(
          `[remote-control] activity push failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      });
    });
    const stop = () => {
      closed = true;
      unsubscribe();
    };
    if (context.signal.aborted) stop();
    else context.signal.addEventListener("abort", stop, { once: true });
  });

  // Per-workspace counts for the sidebar row badge (stage 1.1.0): the ssh
  // terminals this plugin opened in the workspace plus the RDP/VNC windows the
  // console launched from it.
  server.handle(workspaceActivity, (input, context) => {
    capture(context);
    const ssh = terminals.liveSsh(input.workspaceId);
    const windows = sessions
      .list()
      .filter((session) => session.state === "running" && session.workspaceId === input.workspaceId);
    const newest = ssh[ssh.length - 1] ?? null;
    const connectionId = newest?.connectionId ?? windows[windows.length - 1]?.connectionId ?? null;
    const connection = connectionId ? store.getConnection(connectionId) : null;
    return {
      sessions: ssh.length + windows.length,
      connectionName: connection?.name ?? null,
      host: connection?.host ?? null,
    };
  });

  // Binary export (stage 1.1.0): the same bundle /api/export serves, written to
  // a file on the daemon host and handed back as bytes, so a client never has
  // to round-trip a large JSON file through a base64 string. A byte payload can
  // only be the whole RPC value, so the written file is reported separately.
  let lastExport: { path: string; bytes: number; at: string } | null = null;
  server.handle(exportBundle, async (input, context) => {
    capture(context);
    const result = await buildExportBundle(store, vault, {
      passphrase: input.passphrase ?? "",
      pluginVersion: resolvePluginVersion(),
    });
    const directory = path.join(paseoHome, "plugins", "remote-control", "exports");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, result.filename);
    fs.writeFileSync(file, result.content, { mode: 0o600 });
    const bytes = Buffer.from(result.content, "utf8");
    lastExport = { path: file, bytes: bytes.byteLength, at: new Date().toISOString() };
    return bytes;
  });

  server.handle(exportStatus, (input, context) => {
    capture(context);
    return lastExport;
  });

  console.log(`[remote-control] plugin ready (version ${resolvePluginVersion()})`);

  return async () => {
    setActivityProvider(null);
    clearActivity();
    vault.lock();
    terminals.dispose();
    sessions.dispose();
    store.close();
    await endpoint.dispose();
  };
}
