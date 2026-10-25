import * as fs from "node:fs";
import * as path from "node:path";
import { moduleDirectory } from "./module-dir";

const PLUGIN_ID = "remote-control";

function paseoHome(): string {
  return process.env.PASEO_HOME ?? path.join(process.env.HOME ?? "", ".paseo");
}

function configuredPluginRoot(): string | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(paseoHome(), "config.json"), "utf8"),
    ) as { plugins?: Record<string, { path?: unknown }> };
    const entry = raw.plugins?.[PLUGIN_ID];
    if (entry && typeof entry.path === "string" && entry.path.length > 0) {
      return entry.path;
    }
  } catch {
    // fall through
  }
  return null;
}

function candidateRoots(): string[] {
  const roots: string[] = [];
  roots.push(path.join(moduleDirectory(), ".."));
  const configured = configuredPluginRoot();
  if (configured !== null) roots.push(configured);
  return roots;
}

export function resolveConsoleDir(): string {
  const candidates = candidateRoots().map((root) => path.join(root, "dist", "console"));
  let existing: string | null = null;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
    if (existing === null) existing = candidate;
  }
  return existing ?? candidates[0] ?? path.join(process.cwd(), "dist", "console");
}

export function resolvePluginVersion(): string {
  const candidates = candidateRoots().map((root) => path.join(root, "package.json"));
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // try next
    }
  }
  return "0.0.0";
}
