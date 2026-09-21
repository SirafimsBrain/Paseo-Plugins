import * as fs from "node:fs";
import * as path from "node:path";
import { providerById } from "./providers/registry";
import { paseoHome, safeFileSegment } from "./util";

/**
 * "Export before delete" writes one file per session into the Paseo home
 * directory, so the transcripts of a destructive cleanup stay recoverable
 * without the plugin asking for a file picker it cannot show.
 */
export function exportDirectory(): string {
  return path.join(paseoHome(), "session-manager-exports");
}

export interface ExportOutcome {
  exported: boolean;
  path: string | null;
  bytes: number | null;
  error: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function exportAgentSession(input: {
  provider: string;
  id: string;
}): Promise<ExportOutcome> {
  const adapter = providerById(input.provider);
  if (!adapter) {
    return { exported: false, path: null, bytes: null, error: `Unknown provider "${input.provider}"` };
  }
  if (!adapter.exportSession) {
    return {
      exported: false,
      path: null,
      bytes: null,
      error: `${adapter.label} does not support export; the session can only be deleted`,
    };
  }

  const directory = exportDirectory();
  const outPath = path.join(
    directory,
    `${adapter.id}-${safeFileSegment(input.id)}.${adapter.exportExtension ?? "json"}`,
  );

  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    return { exported: false, path: null, bytes: null, error: messageOf(error) };
  }

  try {
    const result = await adapter.exportSession({ id: input.id, outPath });
    if (!result.ok) {
      return { exported: false, path: null, bytes: null, error: result.error };
    }
    return { exported: true, path: outPath, bytes: result.bytes, error: null };
  } catch (error) {
    return { exported: false, path: null, bytes: null, error: messageOf(error) };
  }
}
