import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  listSessions,
  deleteSession,
  deleteSessions,
  exportSession,
} from "./shared/session-manager";
import { sessionManagerSettings } from "./shared/settings";
import {
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
  return () => {};
}
