import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ConsoleEndpoint } from "./server/http-lifecycle";
import { consoleUrl, state } from "./shared/rpc";
import { resolvePluginVersion } from "./server/paths";
import { SessionRegistry } from "./server/sessions";

export default function contribute(server: PluginServerContext): () => void {
  const registry = new SessionRegistry();

  const endpoint = new ConsoleEndpoint({
    log: (m) => console.log(m),
    logError: (m) => console.error(m),
    resolveSession: (id) => registry.getPty(id) ?? null,
    sessions: registry,
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
    return {
      consoleUrl: status.url,
      listening: status.listening,
      version: resolvePluginVersion(),
      transport: status.transport,
      transportConnections: status.transportConnections,
    };
  });

  console.log(`[remote-control] plugin ready (version ${resolvePluginVersion()})`);

  return async () => {
    registry.dispose();
    await endpoint.dispose();
  };
}
