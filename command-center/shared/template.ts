/**
 * Renders `{{...}}` tokens in a command template. Unknown tokens are left as-is
 * so a typo stays visible in the preview instead of silently disappearing.
 * Pure and client-safe: no Node APIs.
 */
export function renderTemplate(
  template: string,
  values: Record<string, string>,
  context: {
    workspaceName?: string | null;
    workspacePath?: string | null;
    date?: string;
    time?: string;
  } = {},
): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, raw: string) => {
    const token = raw.trim();

    if (token.startsWith("input:")) {
      const rest = token.slice("input:".length);
      const pipeAt = rest.indexOf("|");
      const name = (pipeAt === -1 ? rest : rest.slice(0, pipeAt)).trim();
      const fallback = pipeAt === -1 ? undefined : rest.slice(pipeAt + 1).trim();
      return values[name] ?? fallback ?? "";
    }

    if (token === "workspace.name") return context.workspaceName ?? "";
    if (token === "workspace.path") return context.workspacePath ?? "";
    if (token === "date") return context.date ?? new Date().toISOString().slice(0, 10);
    if (token === "time") return context.time ?? new Date().toTimeString().slice(0, 5);

    return `{{${token}}}`;
  });
}

/**
 * Names every `{{input:...}}` variable a template expects, so the run dialog can
 * build its form without a server round-trip. Ordered by first occurrence.
 */
export function inputVariablesOf(template: string): { name: string; defaultValue?: string }[] {
  const found: { name: string; defaultValue?: string }[] = [];
  const seen = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const token = (match[1] ?? "").trim();
    if (!token.startsWith("input:")) continue;
    const rest = token.slice("input:".length);
    const pipeAt = rest.indexOf("|");
    const name = (pipeAt === -1 ? rest : rest.slice(0, pipeAt)).trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    found.push(pipeAt === -1 ? { name } : { name, defaultValue: rest.slice(pipeAt + 1).trim() });
  }
  return found;
}

/**
 * Branch name for worktree mode "branch-off", which requires an explicit
 * branch name. Pure and client-safe so remote (multi-host) dispatch can reuse
 * the exact same naming as the daemon-side executor.
 */
export function worktreeBranchFor(commandName: string, nowMs: number = Date.now()): string {
  const slug =
    commandName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "command";
  return `command-center/${slug}-${nowMs.toString(36)}`;
}
