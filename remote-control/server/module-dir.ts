import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function moduleDirectory(): string {
  const meta = import.meta as { url?: string };
  if (typeof meta.url === "string" && meta.url.length > 0) {
    return path.dirname(fileURLToPath(meta.url));
  }
  return typeof __dirname === "string" ? __dirname : process.cwd();
}

export function modulePath(...segments: string[]): string {
  return path.join(moduleDirectory(), ...segments);
}
