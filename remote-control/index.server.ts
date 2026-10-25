import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ConsoleEndpoint } from "./server/http-lifecycle";
import { consoleUrl, state } from "./shared/rpc";
import { resolvePluginVersion } from "./server/paths";

export default function contribute(server: PluginServerContext): () => void {
  const endpoint = new ConsoleEndpoint({ log: (m) => console.log(m), logError: (m) => console.error(m) });

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
    await endpoint.dispose();
  };
}
