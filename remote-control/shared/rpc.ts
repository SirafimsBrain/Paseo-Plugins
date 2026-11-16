import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const consoleUrl = defineRpc({
  name: "remote-control.console-url",
  input: z.object({}),
  output: z.object({ url: z.string().nullable() }),
});

export const state = defineRpc({
  name: "remote-control.state",
  input: z.object({}),
  output: z.object({
    consoleUrl: z.string().nullable(),
    listening: z.boolean(),
    version: z.string(),
    vault: z.object({
      initialized: z.boolean(),
      unlocked: z.boolean(),
      entries: z.number().int().nonnegative(),
    }),
  }),
});

export const vaultSetup = defineRpc({
  name: "remote-control.vault.setup",
  input: z.object({ password: z.string().min(1), keyId: z.string().optional() }),
  output: z.object({ generated: z.boolean() }),
});

export const vaultUnlock = defineRpc({
  name: "remote-control.vault.unlock",
  input: z.object({ password: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});

export const vaultLock = defineRpc({
  name: "remote-control.vault.lock",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

// Connections as the sidebar panel shows them: the group tree plus flat
// connection rows (with the group they hang under and whether a password is
// stored in the vault for them).
export const connectionsList = defineRpc({
  name: "remote-control.connections.list",
  input: z.object({}),
  output: z.object({
    groups: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        parentId: z.string().nullable(),
      }),
    ),
    connections: z.array(
      z.object({
        id: z.string(),
        groupId: z.string().nullable(),
        name: z.string(),
        protocol: z.enum(["ssh", "rdp", "vnc"]),
        host: z.string(),
        port: z.number().int().nullable(),
        username: z.string(),
        hasPassword: z.boolean(),
      }),
    ),
  }),
});

// Per-workspace activity (stage 1.1.0): what the sidebar workspace row badge
// shows. `sessions` counts the live remote sessions (ssh terminals this plugin
// opened plus running RDP/VNC windows) that belong to this workspace, and the
// connection name is the newest one, so the badge can read "2 remote".
export const workspaceActivity = defineRpc({
  name: "remote-control.workspace.activity",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({
    sessions: z.number().int().nonnegative(),
    connectionName: z.string().nullable(),
    host: z.string().nullable(),
  }),
});

// Binary export (stage 1.1.0, Paseo 0.16.0 binary RPC payloads): writes the
// same bundle /api/export serves to a file on the daemon host and returns its
// bytes as `Uint8Array` — no base64 inflation for a backup that can be tens of
// megabytes once secrets are embedded. The protocol allows a byte payload only
// as the *whole* value of an RPC, so the file it wrote is reported by
// `exportStatus` instead of riding along in an object.
export const exportBundle = defineRpc({
  name: "remote-control.export",
  input: z.object({ passphrase: z.string().optional() }),
  output: z.instanceof(Uint8Array),
});

/** Where the last `remote-control.export` landed (null = nothing exported yet). */
export const exportStatus = defineRpc({
  name: "remote-control.export.status",
  input: z.object({}),
  output: z
    .object({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      at: z.string(),
    })
    .nullable(),
});

// Launch from the sidebar panel: ssh opens a Paseo terminal tab, rdp/vnc
// open their own desktop window on the daemon machine.
export const connectionLaunch = defineRpc({
  name: "remote-control.connections.launch",
  input: z.object({
    connectionId: z.string().min(1),
    workspaceId: z.string().min(1),
  }),
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("terminal"), terminalId: z.string(), name: z.string() }),
    z.object({
      kind: z.literal("external"),
      pid: z.number().int(),
      binary: z.string(),
      sessionId: z.string().optional(),
    }),
  ]),
});
