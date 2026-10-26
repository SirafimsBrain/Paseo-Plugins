// Protocol registry (stage D1, ADR-10). A protocol declares its default port,
// zod schema for its payload fields, and the capabilities the console uses to
// render the form and enable launchers. New protocols (ssh/rdp/vnc/...) plug
// in without touching the console core.

import { z } from "zod";

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

export const sshPayloadSchema = z.object({
  identitySecret: z.string().optional(),
  passwordSecret: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  strictHostKeyChecking: z.boolean().optional(),
});
export type SshPayload = z.infer<typeof sshPayloadSchema>;

export const rdpPayloadSchema = z.object({
  domain: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  fullscreen: z.boolean().optional(),
});
export type RdpPayload = z.infer<typeof rdpPayloadSchema>;

export const vncPayloadSchema = z.object({
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
