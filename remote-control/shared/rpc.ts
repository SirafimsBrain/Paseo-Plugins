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
    z.object({ kind: z.literal("external"), pid: z.number().int(), binary: z.string() }),
  ]),
});
