import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { ConsoleEndpoint } from "./server/http-lifecycle";
import { consoleUrl, state, vaultSetup, vaultUnlock, vaultLock } from "./shared/rpc";
import { resolvePluginVersion } from "./server/paths";
import { Store } from "./server/store";
import { TerminalService } from "./server/terminals";
import { VaultService } from "./server/vault";

export default function contribute(server: PluginServerContext): () => void {
  const vault = new VaultService({ log: (m) => console.log(m) });
  const store = new Store({ dbPath: `${process.env.PASEO_HOME ?? (process.env.HOME + "/.paseo")}/plugins/remote-control/remote-control.db` });

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

  const endpoint = new ConsoleEndpoint({
    log: (m) => console.log(m),
    logError: (m) => console.error(m),
    terminals,
    store,
    vault,
  });

  endpoint.sync({ enabled: true, port: 0, accessToken: "" });
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

  console.log(`[remote-control] plugin ready (version ${resolvePluginVersion()})`);

  return async () => {
    vault.lock();
    terminals.dispose();
    store.close();
    await endpoint.dispose();
  };
}
