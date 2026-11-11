import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { CommandDefinition, CommandVariable, CommandVariableKind } from "./commands";
import { inputVariablesOf } from "./template";

/** One input rendered by the run dialog, with its typed control. */
export interface ResolvedInput {
  name: string;
  prompt: string;
  defaultValue?: string;
  kind: CommandVariableKind;
}

/**
 * Inputs of a stored command: declared variables first (they carry the kind and
 * the prompt), then `{{input:…}}` names discovered in the template that were
 * never declared (a legacy or hand-edited command) as plain text inputs.
 * Workflows have no template of their own and therefore no run-dialog inputs.
 *
 * Pure and client-safe; the run dialog and the tests share it.
 */
export function resolveCommandInputs(command: CommandDefinition): ResolvedInput[] {
  if (command.type === "workflow") return [];
  const byName = new Map<string, ResolvedInput>();
  for (const variable of command.variables) {
    byName.set(variable.name, {
      name: variable.name,
      prompt: variable.prompt,
      defaultValue: variable.defaultValue,
      kind: variable.kind,
    });
  }
  for (const discovered of inputVariablesOf(command.template)) {
    if (byName.has(discovered.name)) continue;
    byName.set(discovered.name, {
      name: discovered.name,
      prompt: discovered.name,
      defaultValue: discovered.defaultValue,
      kind: "text",
    });
  }
  return [...byName.values()];
}

/**
 * The editor's view of a template's inputs: every `{{input:…}}` name with the
 * kind the user picked (or the stored kind), preserving stored prompts and
 * defaults. Template defaults win over stored ones, because the token is what
 * the preview renders when the field is untouched.
 */
export function declarationsForTemplate(
  template: string,
  stored: CommandVariable[],
  kinds: Record<string, CommandVariableKind>,
): CommandVariable[] {
  const storedByName = new Map(stored.map((variable) => [variable.name, variable]));
  return inputVariablesOf(template).map((discovered) => {
    const previous = storedByName.get(discovered.name);
    return {
      name: discovered.name,
      prompt: previous?.prompt ?? discovered.name,
      defaultValue: discovered.defaultValue ?? previous?.defaultValue,
      kind: kinds[discovered.name] ?? previous?.kind ?? "text",
    };
  });
}

/**
 * Directory browser for `file` inputs (0.10.0).
 *
 * The plugin API (`PaseoApi`) has no file listing, but the daemon's
 * `DaemonClient.listDirectory(cwd, path)` — already used by the schedule bridge
 * — does. This RPC exposes a read-only listing of one directory; it answers for
 * the **local** daemon's filesystem only, because the plugin server has one
 * daemon connection. Remote-host targets keep a typed path.
 */
export const browseFiles = defineRpc({
  name: "command-center.browse",
  input: z.object({
    /** Workspace directory the browse starts from. */
    cwd: z.string().min(1),
    /** Absolute or cwd-relative directory to list. */
    path: z.string().min(1),
  }),
  output: z.object({
    path: z.string(),
    entries: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        kind: z.enum(["file", "directory"]),
      }),
    ),
    error: z.string().nullable(),
  }),
});

export type BrowseResult = z.infer<typeof browseFiles.output>;
