import { acpxProvider } from "./acpx";
import { clineProvider } from "./cline";
import { kiloProvider } from "./kilo";
import { opencodeProvider } from "./opencode";
import { qwenProvider } from "./qwen";
import type { ProviderAdapter } from "./types";

/**
 * Every coding agent whose sessions this plugin can list and delete.
 *
 * To support a new agent, add one module in this directory exporting a
 * `ProviderAdapter` and append it below. Agents that ship their own session
 * commands should reuse `createCliProvider` (see `opencode.ts`).
 */
export const providers: readonly ProviderAdapter[] = [
  clineProvider,
  opencodeProvider,
  kiloProvider,
  qwenProvider,
  acpxProvider,
];

export function providerById(id: string): ProviderAdapter | null {
  return providers.find((provider) => provider.id === id) ?? null;
}
