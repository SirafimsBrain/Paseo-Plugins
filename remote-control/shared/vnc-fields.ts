// VNC field choices and defaults (stage 0.23.10) — the port of vnc-pilot's
// connection form tables (`_QUALITY`, `_COMPRESS`, `_ENCODING`,
// `_COLOR_DEPTH` and its FieldSpec defaults).
//
// This module is deliberately dependency-free (no zod): the console web
// bundle imports it directly and shared/protocols.ts derives its validation
// enums from the same arrays, so form and schema cannot drift apart.

/** Client ids, in vnc-pilot's discovery preference order. */
export const VNC_CLIENT_IDS = [
  "tigervnc",
  "turbovnc",
  "tightvnc",
  "realvnc",
  "remmina",
  "krdc",
  "vinagre",
  "gvncviewer",
  "custom",
] as const;

export type VncClientId = (typeof VNC_CLIENT_IDS)[number];

/** Human labels for the client select and the session table. */
export const VNC_CLIENT_LABELS: Record<VncClientId, string> = {
  tigervnc: "TigerVNC",
  turbovnc: "TurboVNC",
  tightvnc: "TightVNC",
  realvnc: "RealVNC",
  remmina: "Remmina",
  krdc: "KRDC (KDE)",
  vinagre: "Vinagre (GNOME)",
  gvncviewer: "gvncviewer (gtk-vnc)",
  custom: "Custom (binary path below)",
};

/** JPEG / quality level 0–9 (empty = Auto → option omitted). */
export const VNC_QUALITY = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/** Compression level 0–9 (empty = Auto → option omitted). */
export const VNC_COMPRESS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/** Preferred encoding (empty = Auto → option omitted). */
export const VNC_ENCODINGS = ["Tight", "ZRLE", "Hextile", "Raw"] as const;

/** Color depth (empty = Auto → option omitted). */
export const VNC_COLOR_DEPTHS = ["8", "16", "24", "32"] as const;

function levelChoices(first: string, middle: string, last: string): readonly (readonly [string, string])[] {
  return [
    ["", "Auto"],
    ["0", `0 - ${first}`],
    ["1", "1"],
    ["2", "2"],
    ["3", "3"],
    ["4", "4"],
    ["5", `5 - ${middle}`],
    ["6", "6"],
    ["7", "7"],
    ["8", "8"],
    ["9", `9 - ${last}`],
  ];
}

/**
 * Human labels for the console selects — the same tuples vnc-pilot shows.
 * `""` is the "Auto" entry and means "omit the option".
 */
export const VNC_CHOICES: Record<string, readonly (readonly [string, string])[]> = {
  quality: levelChoices("Lowest / smallest", "Medium", "Highest / largest"),
  compress: levelChoices("No compression", "Medium", "Maximum"),
  encoding: [
    ["", "Auto"],
    ["Tight", "Tight"],
    ["ZRLE", "ZRLE"],
    ["Hextile", "Hextile"],
    ["Raw", "Raw"],
  ],
  colorDepth: [
    ["", "Auto"],
    ["8", "8-bit (256 colors)"],
    ["16", "16-bit (65K colors)"],
    ["24", "24-bit (16M colors)"],
    ["32", "32-bit (16M+ colors)"],
  ],
};

/**
 * Field defaults for a *new* VNC connection (vnc-pilot's FieldSpec defaults).
 * The client is not part of this object: it depends on what is installed on
 * this machine and is resolved when the form opens or the session launches.
 * Absent keys emit no option, so rows created before this stage keep the
 * command line they had.
 */
export const VNC_PAYLOAD_DEFAULTS = {
  shared: true,
  colorDepth: "24",
  acceptClipboard: true,
  sendClipboard: true,
  turbovncLocal: true,
} as const;
