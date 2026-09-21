import * as path from "node:path";
import { asRecord, asString, listDirectories, listFiles, paseoHome, readJson } from "./util";

export interface PaseoAgentLink {
  id: string;
  title: string | null;
  archived: boolean;
  provider: string | null;
}

/**
 * Paseo stores one JSON record per agent in `$PASEO_HOME/agents/<workspace>/`,
 * and that record points at the provider's native session id. Indexing those
 * ids lets the plugin warn before deleting a session a Paseo agent still
 * refers to, which would break resume for that agent.
 */
export function readPaseoAgentLinks(): Map<string, PaseoAgentLink> {
  const links = new Map<string, PaseoAgentLink>();
  const root = path.join(paseoHome(), "agents");

  for (const workspaceDir of listDirectories(root)) {
    for (const file of listFiles(workspaceDir, ".json")) {
      const record = asRecord(readJson(file));
      if (!record) continue;
      const id = asString(record["id"]) ?? path.basename(file, ".json");
      const link: PaseoAgentLink = {
        id,
        title: asString(record["title"]),
        archived: Boolean(record["archivedAt"]),
        provider: asString(record["provider"]),
      };
      for (const sessionId of sessionIdsOf(record)) {
        if (!links.has(sessionId)) links.set(sessionId, link);
      }
    }
  }

  return links;
}

function sessionIdsOf(record: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const candidates = [asRecord(record["persistence"]), asRecord(record["runtimeInfo"])];
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const key of ["sessionId", "nativeHandle"]) {
      const value = asString(candidate[key]);
      if (value) ids.add(value);
    }
  }
  return [...ids];
}
