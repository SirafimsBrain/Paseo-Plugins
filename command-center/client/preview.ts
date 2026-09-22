import { renderTemplate } from "../shared/template";

/** Client-side preview: fills workspace context with the selected workspace. */
export function renderPreview(
  template: string,
  values: Record<string, string>,
  workspaceId: string | undefined,
  workspaces: { id: string; name: string }[],
): string {
  const workspace = workspaces.find((entry) => entry.id === workspaceId) ?? null;
  return renderTemplate(template, values, {
    workspaceName: workspace?.name ?? null,
    workspacePath: workspace ? `…/${workspace.name}` : null,
  }).trim();
}
