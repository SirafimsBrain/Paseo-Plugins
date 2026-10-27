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
