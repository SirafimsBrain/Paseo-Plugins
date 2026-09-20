import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listSessions, deleteSession, deleteSessions } from "./shared/session-manager";
import { listAcpSessions, deleteAcpSession, deleteAcpSessionsBatch } from "./server/session-manager";

export default function contribute(server: PluginServerContext) {
  server.handle(listSessions, listAcpSessions);
  server.handle(deleteSession, deleteAcpSession);
  server.handle(deleteSessions, deleteAcpSessionsBatch);
  return () => {};
}
