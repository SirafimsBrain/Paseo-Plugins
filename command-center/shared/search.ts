import type { CommandDefinition } from "./commands";

/**
 * Client-side command search. All matching is case-insensitive; terms are
 * AND-ed (a command must contain every term). A term matches when it occurs
 * in the name, the category, the template body, or any declared variable
 * prompt — so searching "review" finds both the "PR review" command and one
 * that asks "review the changes" inside its prompt.
 */
export function commandMatchesQuery(command: CommandDefinition, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return true;
  const haystacks = commandHaystacks(command);
  for (const term of trimmed.split(/\s+/)) {
    if (term.length === 0) continue;
    if (!haystacks.some((haystack) => haystack.includes(term))) return false;
  }
  return true;
}

function commandHaystacks(command: CommandDefinition): string[] {
  const parts: string[] = [command.name, command.template];
  const category = (command as { category?: string | null }).category;
  if (typeof category === "string") parts.push(category);
  for (const variable of command.variables) parts.push(variable.prompt, variable.name);
  return parts.map((part) => part.toLowerCase());
}

/** True when the category passes the active filter (`null` shows everything). */
export function commandMatchesCategory(
  command: CommandDefinition,
  category: string | null,
): boolean {
  if (category === null) return true;
  const value = (command as { category?: string | null }).category;
  return typeof value === "string" && value === category;
}
