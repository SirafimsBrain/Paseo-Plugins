// Mapping from imported Ghostty settings to terminal runtime options
// (stage B2). Pure data, no DOM/Node deps, so it is unit-testable from the
// plugin root typecheck and reusable by the console bundle.

import type { GhosttySettings } from "./ghostty-settings";

export interface TerminalTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface TerminalOptions {
  cols?: number;
  rows?: number;
  cursorBlink?: boolean;
  cursorStyle?: "block" | "underline" | "bar";
  theme?: TerminalTheme;
  scrollback?: number;
  fontSize?: number;
  fontFamily?: string;
}

const PALETTE_SLOTS: ReadonlyArray<keyof TerminalTheme> = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

/**
 * Convert a palette entry of the form `N=color` (or `N = color`) into a
 * `[index, color]` pair, or null when it does not parse.
 */
function parsePaletteEntry(entry: string): { index: number; color: string } | null {
  const eq = entry.indexOf("=");
  if (eq < 0) return null;
  const index = Number(entry.slice(0, eq).trim());
  const color = entry.slice(eq + 1).trim();
  if (!Number.isInteger(index) || index < 0 || index >= PALETTE_SLOTS.length) return null;
  if (color.length === 0) return null;
  return { index, color };
}

export function ghosttySettingsToTerminalOptions(settings: GhosttySettings): TerminalOptions {
  const options: TerminalOptions = {};

  if (settings.fontFamily) options.fontFamily = settings.fontFamily;
  if (typeof settings.fontSize === "number") options.fontSize = settings.fontSize;
  if (typeof settings.scrollback === "number") options.scrollback = settings.scrollback;
  if (typeof settings.cursorBlink === "boolean") options.cursorBlink = settings.cursorBlink;
  if (settings.cursorStyle) {
    options.cursorStyle = settings.cursorStyle === "underline-block" ? "underline" : settings.cursorStyle;
  }

  const theme: TerminalTheme = {};
  if (settings.background) theme.background = settings.background;
  if (settings.foreground) theme.foreground = settings.foreground;
  if (settings.cursorColor) theme.cursor = settings.cursorColor;
  if (Array.isArray(settings.palette)) {
    for (const entry of settings.palette) {
      const parsed = parsePaletteEntry(entry);
      if (parsed === null) continue;
      theme[PALETTE_SLOTS[parsed.index]] = parsed.color;
    }
  }
  if (Object.keys(theme).length > 0) options.theme = theme;

  return options;
}
