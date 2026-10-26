import { z } from "zod";

export const vaultStatusSchema = z.object({
  initialized: z.boolean(),
  unlocked: z.boolean(),
  entries: z.array(z.string()),
  storeDir: z.string(),
  gnupgHome: z.string(),
  keyId: z.string().nullable(),
  autoLockMs: z.number().int().nonnegative(),
});
export type VaultStatus = z.infer<typeof vaultStatusSchema>;
