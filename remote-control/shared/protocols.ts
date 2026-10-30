// Protocol registry (stage D1, ADR-10). A protocol declares its default port,
// zod schema for its payload fields, and the capabilities the console uses to
// render the form and enable launchers. New protocols (ssh/rdp/vnc/...) plug
// in without touching the console core.
//
// Payload schemas are *loose* objects: they type-check the fields the plugin
// owns while preserving keys it does not know (`payload.auth` written by the
// connection test, keys imported from an older backup). Stage 0.22.10 — the
// RDP payload carries the full FreeRDP 3 option set ported from rdp-pilot
// (group order in server/protocols/external.ts mirrors its build_spawn()).

import { z } from "zod";
import { RDP_BPP, RDP_GDI, RDP_JPEG_QUALITY, RDP_KBD_TYPES, RDP_NETWORK, RDP_SEC, RDP_SOUND_MODES } from "./rdp-fields";

export { RDP_PAYLOAD_DEFAULTS } from "./rdp-fields";

export interface ProtocolDefinition {
  id: "ssh" | "rdp" | "vnc";
  defaultPort: number;
  /** Human label. */
  label: string;
  /** zod schema for the protocol-specific payload object. */
  payloadSchema: z.ZodTypeAny;
  /** Field names in payload that are secret references (resolved via vault). */
  secretFields: string[];
  /** Whether the plugin can launch this protocol today. */
  launchable: boolean;
}

export const sshPayloadSchema = z.looseObject({
  identitySecret: z.string().optional(),
  passwordSecret: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  strictHostKeyChecking: z.boolean().optional(),
});
export type SshPayload = z.infer<typeof sshPayloadSchema>;

// RDP payload (stage 0.22.10), a port of rdp-pilot's connection_fields().
// Keys are camelCase (repo convention), values mirror the Python choices
// exactly; an empty choice ("Automatic"/"Default") means "omit the option"
// and is therefore not part of the enums. Legacy keys kept for rows created
// before this stage and for imported backups: `width`/`height`/`fullscreen`
// (display), `cert` (explicit /cert:<value>), `extraArgs` (escape hatch).
export const rdpPayloadSchema = z.looseObject({
  // --- Main (non-display basics live on the connection row itself) ---
  domain: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  fullscreen: z.boolean().optional(),
  // --- Display ---
  dynamicResolution: z.boolean().optional(),
  bpp: z.enum(RDP_BPP).optional(),
  workarea: z.boolean().optional(),
  multimon: z.boolean().optional(),
  // --- Performance ---
  fonts: z.boolean().optional(),
  aero: z.boolean().optional(),
  windowDrag: z.boolean().optional(),
  menuAnims: z.boolean().optional(),
  themes: z.boolean().optional(),
  wallpaper: z.boolean().optional(),
  gdi: z.enum(RDP_GDI).optional(),
  // --- Redirection ---
  clipboard: z.boolean().optional(),
  drives: z.boolean().optional(),
  homeDrive: z.boolean().optional(),
  printers: z.boolean().optional(),
  smartcards: z.boolean().optional(),
  serial: z.string().optional(),
  sound: z.enum(RDP_SOUND_MODES).optional(),
  microphone: z.boolean().optional(),
  // --- Security ---
  sec: z.enum(RDP_SEC).optional(),
  certIgnore: z.boolean().optional(),
  certName: z.string().optional(),
  cert: z.string().optional(),
  // --- Keyboard ---
  kbdLayout: z.string().optional(),
  kbdType: z.enum(RDP_KBD_TYPES).optional(),
  // --- Network ---
  network: z.enum(RDP_NETWORK).optional(),
  compression: z.boolean().optional(),
  // --- Codecs ---
  rfx: z.boolean().optional(),
  nsc: z.boolean().optional(),
  jpeg: z.boolean().optional(),
  jpegQuality: z.enum(RDP_JPEG_QUALITY).optional(),
  // --- Escape hatch ---
  extraArgs: z.array(z.string()).optional(),
});
export type RdpPayload = z.infer<typeof rdpPayloadSchema>;

export const vncPayloadSchema = z.looseObject({
  viewOnly: z.boolean().optional(),
  fullscreen: z.boolean().optional(),
});
export type VncPayload = z.infer<typeof vncPayloadSchema>;

export const PROTOCOLS: Record<string, ProtocolDefinition> = {
  ssh: {
    id: "ssh",
    defaultPort: 22,
    label: "SSH",
    payloadSchema: sshPayloadSchema,
    secretFields: ["identitySecret", "passwordSecret"],
    launchable: true,
  },
  rdp: {
    id: "rdp",
    defaultPort: 3389,
    label: "RDP",
    payloadSchema: rdpPayloadSchema,
    secretFields: ["passwordSecret"],
    launchable: false,
  },
  vnc: {
    id: "vnc",
    defaultPort: 5900,
    label: "VNC",
    payloadSchema: vncPayloadSchema,
    secretFields: ["passwordSecret"],
    launchable: false,
  },
};

export function getProtocol(id: string): ProtocolDefinition | undefined {
  return PROTOCOLS[id];
}

export function defaultPortFor(id: string): number {
  return PROTOCOLS[id]?.defaultPort ?? 0;
}

/**
 * Validate a payload against its protocol schema and return it normalized
 * (unknown keys preserved). Throws a human-readable Error — the HTTP layer
 * turns it into a 400.
 */
export function validatePayload(protocol: string, payload: unknown): Record<string, unknown> {
  const definition = getProtocol(protocol);
  if (!definition) throw new Error(`unknown protocol: ${protocol}`);
  let input: unknown;
  if (payload === undefined || payload === null) input = {};
  else if (typeof payload === "object" && !Array.isArray(payload)) input = payload;
  else throw new Error(`invalid ${protocol} options — payload must be an object`);
  const result = definition.payloadSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${where}${issue.message}`;
      })
      .join("; ");
    throw new Error(`invalid ${protocol} options — ${issues}`);
  }
  return result.data as Record<string, unknown>;
}
