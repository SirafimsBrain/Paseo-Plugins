import { z } from "zod";
import { defineSettings } from "@getpaseo/plugin";

/**
 * Plugin settings (host-scoped, edited in Paseo Settings → Plugins →
 * Luck Planner from stage E4). The server registers the definition and
 * reads it live (the `agent.create` hook re-reads per creation, history
 * retention and the dashboard endpoint re-apply on `settings.subscribe`),
 * so a change takes effect without a daemon restart — only a plugin reload.
 * Defaults cover every field, so `schema.parse({})` is a complete settings
 * document (the memory-flash fresh-install round-trip rule).
 */
export const luckPlannerSettings = defineSettings({
  id: "luck-planner",
  scope: "host",
  version: 1,
  schema: z.object({
    /**
     * Inject the luck-planner MCP server into every agent created through
     * Paseo (via the `agent.create` before-hook). Agents created outside
     * Paseo use the MCP config in their own tool.
     */
    injectIntoAgents: z.boolean().default(true),
    /**
     * Server name the injected stdio server reports in `initialize`
     * (delivered through the MCP config's `env` as `LUCK_PLANNER_SERVER_NAME`;
     * the config key under which the server is registered stays
     * `luck-planner`, so tool-name prefixes never change).
     */
    mcpServerName: z.string().trim().min(1).max(60).default("luck-planner"),
    /**
     * Serve the dashboard HTTP endpoint at all (stage F1). On by default —
     * the dashboard is the point of the plugin — and the switch exists so a
     * user can close the listening socket without uninstalling. The endpoint
     * is loopback-only and token-protected either way (ADR-9).
     */
    httpEnabled: z.boolean().default(true),
    /**
     * Dashboard HTTP port (stage F1): a fixed port 1–65535, or `0` for auto —
     * the OS picks an ephemeral port. Defaults to 8899, which no other plugin
     * in this repo uses (memory-flash takes 8787). A busy port falls back to
     * an ephemeral one.
     */
    httpPort: z.number().int().min(0).max(65535).default(8899),
    /**
     * Access token for the dashboard HTTP API (ADR-8/ADR-9). Empty (the
     * default) means *auto*: the HTTP server generates a random per-plugin-
     * session token instead of exposing a well-known one. A non-empty value
     * pins the token verbatim; regenerate it from the settings screen.
     */
    accessToken: z.string().trim().max(256).default(""),
    /**
     * Audit-history retention in days (stage E4): rows older than this are
     * pruned at plugin load and on every settings change. `0` keeps the
     * append-only trail forever (the default — retention is opt-in).
     */
    historyRetentionDays: z.number().int().min(0).max(3650).default(0),
  }),
});

export type LuckPlannerSettings = z.infer<(typeof luckPlannerSettings)["schema"]>;

/** Schema defaults — used when settings are not `ready` yet (e.g. hook races). */
export function defaultSettings(): LuckPlannerSettings {
  return luckPlannerSettings.schema.parse({});
}

/**
 * Normalizes whatever the host reports as `ready` settings into a complete
 * document: fills the defaults for fields added after the settings doc was
 * written (the upgrade path — an old two-field doc must gain `httpEnabled`,
 * `httpPort`, `accessToken` and `historyRetentionDays` without a daemon
 * restart) and falls back to the defaults entirely when the values cannot be
 * parsed.
 */
export function normalizeSettings(values: unknown): LuckPlannerSettings {
  const parsed = luckPlannerSettings.schema.safeParse(values);
  return parsed.success ? parsed.data : defaultSettings();
}

/** Default dashboard HTTP port (also the `httpPort` schema default). */
export const DEFAULT_HTTP_PORT = 8899;

/**
 * Generates a fresh dashboard access token (`lp_` + 256 bits of hex) for
 * the settings screen's "Regenerate" action. Uses WebCrypto when present
 * (the Paseo webview always has it); the Math.random fallback exists only
 * so the helper never throws in an exotic runtime and is weaker by design.
 * Client/server neutral — no Node, no DOM APIs (rule of `shared/`).
 */
export function generateAccessToken(): string {
  const scope = globalThis as unknown as {
    crypto?: {
      randomUUID?(): string;
      getRandomValues?(array: Uint8Array): Uint8Array;
    };
  };
  const webcrypto = scope.crypto;
  if (webcrypto?.randomUUID) {
    const one = webcrypto.randomUUID().replace(/-/g, "");
    const two = webcrypto.randomUUID().replace(/-/g, "");
    return `lp_${one}${two}`;
  }
  if (webcrypto?.getRandomValues) {
    const bytes = webcrypto.getRandomValues(new Uint8Array(32));
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return `lp_${hex}`;
  }
  let fallback = "";
  for (let index = 0; index < 32; index += 1) {
    fallback += Math.floor(Math.random() * 16).toString(16);
  }
  return `lp_${fallback}`;
}
