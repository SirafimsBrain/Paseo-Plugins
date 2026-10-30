// RDP field choices and defaults (stage 0.22.10) — the port of rdp-pilot's
// connection form tables (`_BPP`, `_SEC`, `_KBD_TYPES`, `_GDI`, `_NETWORK`,
// `_AUDIO_MODE`, `_JPEG_QUALITY` and the FieldSpec defaults).
//
// This module is deliberately dependency-free (no zod): it is imported by
// the console web bundle as well as by shared/protocols.ts, which derives
// its validation enums from the same arrays so form and schema cannot drift.

/** Color depth, `/bpp:`. */
export const RDP_BPP = ["8", "15", "16", "24", "32"] as const;

/** Protocol security, `/sec:` (empty = FreeRDP decides → option omitted). */
export const RDP_SEC = ["rdp", "tls", "nla", "ext"] as const;

/** GDI rendering, `/gdi:` (empty = default → option omitted). */
export const RDP_GDI = ["sw", "hw"] as const;

/** Keyboard type, `/kbd:type:` (empty = automatic → option omitted). */
export const RDP_KBD_TYPES = ["4", "7", "8", "12", "15", "16"] as const;

/** Network connection type, `/network:` (empty = automatic → omitted). */
export const RDP_NETWORK = ["modem", "broadband-low", "broadband-high", "wan", "lan"] as const;

/** Audio mode, `/audio-mode:` — "0" play here, "1" remotely, "2" do not play. */
export const RDP_SOUND_MODES = ["0", "1", "2"] as const;

/** JPEG quality, `/jpeg-quality:` (empty = FreeRDP default → omitted). */
export const RDP_JPEG_QUALITY = [
  "50",
  "60",
  "70",
  "75",
  "80",
  "85",
  "90",
  "95",
  "100",
] as const;

/**
 * Human labels for the console selects — same tuples rdp-pilot shows.
 * `""` is the "Automatic"/"Default" entry and means "omit the option".
 */
export const RDP_CHOICES: Record<string, readonly (readonly [string, string])[]> = {
  bpp: [
    ["8", "8-bit (256 colors)"],
    ["15", "15-bit (32K)"],
    ["16", "16-bit (65K)"],
    ["24", "24-bit (16M)"],
    ["32", "32-bit (16M+)"],
  ],
  sec: [
    ["", "Automatic"],
    ["rdp", "RDP (Standard RDP Security)"],
    ["tls", "TLS (TLS Encryption)"],
    ["nla", "NLA (Network Level Authentication)"],
    ["ext", "NLA Extended"],
  ],
  gdi: [
    ["", "Default"],
    ["sw", "Software GDI"],
    ["hw", "Hardware GDI"],
  ],
  kbdType: [
    ["", "Automatic"],
    ["4", "IBM PC/XT (83-key)"],
    ["7", "IBM PC/AT (84-key)"],
    ["8", "IBM PC/AT 101/102 (Enhanced)"],
    ["12", "IBM ThinkPad"],
    ["15", "Nokia 9000/9210"],
    ["16", "Windows Mobile/Pocket PC"],
  ],
  network: [
    ["", "Automatic"],
    ["modem", "Modem (56 Kbps)"],
    ["broadband-low", "Broadband-Low (256 Kbps - 2 Mbps)"],
    ["broadband-high", "Broadband-High (2-10 Mbps)"],
    ["wan", "WAN (10+ Mbps)"],
    ["lan", "LAN (100+ Mbps)"],
  ],
  sound: [
    ["0", "Play on this computer"],
    ["1", "Play on remote computer"],
    ["2", "Do not play"],
  ],
  jpegQuality: [
    ["", "Default"],
    ["50", "50 - Low quality / small size"],
    ["60", "60"],
    ["70", "70"],
    ["75", "75 - Normal"],
    ["80", "80"],
    ["85", "85"],
    ["90", "90 - High quality"],
    ["95", "95"],
    ["100", "100 - Maximum quality / large size"],
  ],
};

/**
 * Field defaults the console pre-fills when a *new* RDP connection is
 * created (rdp-pilot's FieldSpec defaults; its preset resolution list is
 * replaced by the legacy width/height pair, 1280x720). Editing an existing
 * connection prefills from its stored payload instead. Keys absent from a
 * stored payload are simply not sent by the builder — legacy rows keep
 * their old argv.
 */
export const RDP_PAYLOAD_DEFAULTS = {
  dynamicResolution: true,
  width: 1280,
  height: 720,
  fullscreen: false,
  bpp: "24",
  fonts: true,
  aero: false,
  windowDrag: false,
  menuAnims: false,
  themes: false,
  wallpaper: false,
  clipboard: true,
  drives: false,
  homeDrive: false,
  printers: false,
  smartcards: false,
  sound: "0",
  microphone: false,
  compression: true,
  rfx: false,
  nsc: false,
  jpeg: false,
} as const;
