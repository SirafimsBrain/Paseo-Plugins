import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  listSessions,
  deleteSession,
  deleteSessions,
  exportSession,
  refreshSession,
} from "./shared/session-manager";
import { sessionManagerSettings } from "./shared/settings";
import {
  invalidateListing,
  listAgentSessions,
  deleteAgentSession,
  deleteAgentSessionsBatch,
} from "./server/session-manager";
import { exportAgentSession } from "./server/exports";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(sessionManagerSettings);
  server.handle(listSessions, listAgentSessions);
  server.handle(deleteSession, deleteAgentSession);
  server.handle(deleteSessions, deleteAgentSessionsBatch);
  server.handle(exportSession, exportAgentSession);

  // The listing cache (30 s, see server/session-manager.ts) also carries the
  // "still running" and "due for cleanup" hints. Paseo 0.14.0 releases idle agent
  // runtimes after an hour and resumes them on the next prompt, so sessions now
  // close and reopen far more often — dropping the cache on every close keeps the
  // running flags honest instead of letting them age out (§18.3 item 1).
  const removeClosedHook = server.on("agent.closed", (event) => {
    invalidateListing();
    console.log(
      `[session-manager] agent closed (${event.agent.id}): listing cache invalidated`,
    );
  });

  // --- Refresh: reopen the session so its runtime state is recomputed ----------
  // `reload()` reruns `agent.session_open`; invalidating here means the next list
  // reads the recomputed state rather than the cached snapshot (§18.3 item 3).
  server.handle(refreshSession, async (input, { paseo }) => {
    try {
      const result = await paseo.agents.ref(input.agentId).reload();
      if (result === null) {
        return { ok: false, error: `Agent ${input.agentId} not found or not reloadable.` };
      }
      invalidateListing();
      console.log(
        `[session-manager] reloaded agent ${input.agentId}: listing cache invalidated`,
      );
      return { ok: true, error: null };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[session-manager] agent reload failed: ${message}`);
      return { ok: false, error: message };
    }
  });

  return () => {
    removeClosedHook();
  };
}
