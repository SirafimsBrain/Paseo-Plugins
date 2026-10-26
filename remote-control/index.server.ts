import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ConsoleEndpoint } from "./server/http-lifecycle";
import { consoleUrl, state, vaultSetup, vaultUnlock, vaultLock } from "./shared/rpc";
import { resolvePluginVersion } from "./server/paths";
import { SessionRegistry } from "./server/sessions";
import { VaultService } from "./server/vault";

export default function contribute(server: PluginServerContext): () => void {
  const registry = new SessionRegistry();
  const vault = new VaultService({ log: (m) => console.log(m) });

  const endpoint = new ConsoleEndpoint({
    log: (m) => console.log(m),
    logError: (m) => console.error(m),
    resolveSession: (id) => registry.getPty(id) ?? null,
    sessions: registry,
    vault,
    onServerStarted: (httpServer) => {
      registry.setOnEvent((event) => {
        httpServer.broadcastSse(event.type, event);
      });
    },
  });

  endpoint.sync({ enabled: true, port: 0, accessToken: "" });
  void endpoint.settled();

  server.handle(consoleUrl, () => ({ url: endpoint.url() }));
  server.handle(state, () => {
    const status = endpoint.status();
    const v = vault.status();
    return {
      consoleUrl: status.url,
      listening: status.listening,
      version: resolvePluginVersion(),
      transport: status.transport,
      transportConnections: status.transportConnections,
      vault: { initialized: v.initialized, unlocked: v.unlocked, entries: v.entries.length },
    };
  });
  server.handle(vaultSetup, async (input) => {
    const result = await vault.setup(input.password, input.keyId);
    return result;
  });
  server.handle(vaultUnlock, async (input) => {
    return await vault.unlock(input.password);
  });
  server.handle(vaultLock, async () => {
    vault.lock();
    return { ok: true };
  });

  console.log(`[remote-control] plugin ready (version ${resolvePluginVersion()})`);

  return async () => {
    vault.lock();
    registry.dispose();
    await endpoint.dispose();
  };
}
