import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ConsoleEndpoint } from "./server/http-lifecycle";
import { consoleUrl, state } from "./shared/rpc";
import { resolvePluginVersion } from "./server/paths";

export default function contribute(server: PluginServerContext): () => void {
  const endpoint = new ConsoleEndpoint({ log: (m) => console.log(m), logError: (m) => console.error(m) });

  endpoint.sync({ enabled: true, port: 0, accessToken: "" });
  void endpoint.settled();

  server.handle(consoleUrl, () => ({ url: endpoint.url() }));
  server.handle(state, () => ({
    consoleUrl: endpoint.url(),
    listening: endpoint.status().listening,
    version: resolvePluginVersion(),
  }));

  console.log(`[remote-control] plugin ready (version ${resolvePluginVersion()})`);

  return async () => {
    await endpoint.dispose();
  };
}
