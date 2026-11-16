/** The group and connection shapes every Remote Control surface renders. */
export interface GroupRow {
  id: string;
  name: string;
  parentId: string | null;
}

export interface ConnectionRow {
  id: string;
  groupId: string | null;
  name: string;
  protocol: "ssh" | "rdp" | "vnc";
  host: string;
  port: number | null;
  username: string;
  hasPassword: boolean;
}

/** `SSH · user@host:22`, the one-line summary under a connection's name. */
export function connectionTarget(connection: ConnectionRow): string {
  return `${connection.protocol.toUpperCase()} · ${connection.username ? `${connection.username}@` : ""}${connection.host}${
    connection.port ? `:${connection.port}` : ""
  }`;
}

/**
 * A shell line that opens this connection from a terminal on the daemon host.
 * Only ssh has one — RDP/VNC windows are launched by the plugin, not by a
 * command the user could paste.
 */
export function connectionShellLine(connection: ConnectionRow): string | null {
  if (connection.protocol !== "ssh") return null;
  const target = `${connection.username ? `${connection.username}@` : ""}${connection.host}`;
  return `ssh ${connection.port ? `-p ${connection.port} ` : ""}${target}`;
}

/** Groups in tree order with their nesting depth (orphans last, at depth 0). */
export function orderedGroups(groups: GroupRow[]): Array<{ group: GroupRow; depth: number }> {
  const children = new Map<string | null, GroupRow[]>();
  for (const group of groups) {
    const key = group.parentId ?? null;
    const list = children.get(key) ?? [];
    list.push(group);
    children.set(key, list);
  }
  const out: Array<{ group: GroupRow; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number): void => {
    for (const group of children.get(parentId) ?? []) {
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      out.push({ group, depth });
      walk(group.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const group of groups) {
    if (!seen.has(group.id)) out.push({ group, depth: 0 });
  }
  return out;
}
