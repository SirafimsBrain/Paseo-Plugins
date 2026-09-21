import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listSessions, deleteSession, deleteSessions } from "./shared/session-manager";
import {
  listAgentSessions,
  deleteAgentSession,
  deleteAgentSessionsBatch,
} from "./server/session-manager";

export default function contribute(server: PluginServerContext) {
  server.handle(listSessions, listAgentSessions);
  server.handle(deleteSession, deleteAgentSession);
  server.handle(deleteSessions, deleteAgentSessionsBatch);
  return () => {};
}
