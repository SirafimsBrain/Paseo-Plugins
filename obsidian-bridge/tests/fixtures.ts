import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The suite models a standalone MCP process: without Paseo workspace context
// the planning root is the configured directory itself. Workspace scoping is
// covered separately in tests/plan-workspace.test.ts, which sets the env back.
delete process.env.PASEO_WORKSPACE_ID;
delete process.env.PASEO_AGENT_CWD;
delete process.env.OBSIDIAN_PROJECT_NAME;

/**
 * Throwaway vault + Paseo home for tests. Both live under a fresh temp
 * directory, so no test ever touches the real vault, the real index or the
 * real daemon home.
 */
export interface TestWorkspace {
  home: string;
  vault: string;
  write(relPath: string, content: string): string;
  remove(relPath: string): void;
  cleanup(): void;
}

export function makeWorkspace(notes: Record<string, string> = {}): TestWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-bridge-"));
  const home = path.join(root, "paseo-home");
  const vault = path.join(root, "vault");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  process.env.PASEO_HOME = home;

  const write = (relPath: string, content: string): string => {
    const target = path.join(vault, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf-8");
    return target;
  };
  for (const [relPath, content] of Object.entries(notes)) write(relPath, content);

  return {
    home,
    vault,
    write,
    remove(relPath: string) {
      fs.rmSync(path.join(vault, relPath), { force: true });
    },
    cleanup() {
      delete process.env.PASEO_HOME;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Settings for a workspace, with every default filled in. */
export function runtimeSettings(vault: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    vaultPath: vault,
    inboxDir: "Inbox",
    outDir: "Documentation",
    rawDir: "raw",
    planRoot: "Workspaces",
    allowedExtensions: ".md",
    indexingEnabled: true,
    includeFolders: "",
    excludeGlobs: ".obsidian/**, .trash/**, .git/**, .smart-env/**",
    ftsStemming: false,
    reconcileMinutes: 10,
    maxResults: 10,
    searchBudgetChars: 8000,
    snippetChars: 600,
    readOnly: false,
    maxWriteChars: 200_000,
    // Off by default: unit tests must never download or load a real model.
    semanticSearch: false,
    embeddingModel: "Xenova/multilingual-e5-small",
    embeddingDtype: "q8",
    embeddingIdleMinutes: 10,
    obsidianApiEnabled: false,
    obsidianApiUrl: "https://127.0.0.1:27124",
    obsidianApiKey: "",
    ...overrides,
  } as {
    vaultPath: string;
    inboxDir: string;
    outDir: string;
    rawDir: string;
    planRoot: string;
    allowedExtensions: string;
    indexingEnabled: boolean;
    includeFolders: string;
    excludeGlobs: string;
    ftsStemming: boolean;
    reconcileMinutes: number;
    maxResults: number;
    searchBudgetChars: number;
    snippetChars: number;
    readOnly: boolean;
    maxWriteChars: number;
    semanticSearch: boolean;
    embeddingModel: string;
    embeddingDtype: string;
    embeddingIdleMinutes: number;
    obsidianApiEnabled: boolean;
    obsidianApiUrl: string;
    obsidianApiKey: string;
  };
}
