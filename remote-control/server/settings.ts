// Plugin settings (stage 0.25.11, G2).
//
// Settings live in the same SQLite store as connections (the `settings`
// table already existed), are validated here, and are applied by
// `index.server.ts`: a console port change re-syncs the HTTP endpoint, an
// auto-lock change reaches the vault, a store-path change relocks and points
// the vault at the new directory, and the client binaries are read at launch
// time. Nothing here touches the filesystem or the daemon.

import * as os from "node:os";
import * as path from "node:path";
import type { Store } from "./store";

export interface ConsoleSettings {
  /** 0 = ephemeral port (the plugin's default). */
  consolePort: number;
  /** Vault auto-lock after N idle minutes; 0 disables it. */
  autoLockMinutes: number;
  /** pass store directory (PASSWORD_STORE_DIR). */
  storeDir: string;
  /** Explicit RDP client path; empty = PATH discovery. */
  rdpBinary: string;
  /** Explicit VNC viewer path; empty = per-connection viewer / discovery. */
  vncBinary: string;
}

export const SETTING_KEYS = {
  consolePort: "consolePort",
  autoLockMinutes: "autoLockMinutes",
  storeDir: "storeDir",
  rdpBinary: "rdpBinary",
  vncBinary: "vncBinary",
} as const;

const KNOWN_KEYS = new Set(Object.values(SETTING_KEYS));

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function readInt(store: Store | null, key: string, fallback: number, min: number, max: number): number {
  const raw = store?.getSetting(key) ?? null;
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

export function loadSettings(store: Store | null, defaults: { storeDir: string }): ConsoleSettings {
  const storeDir = store?.getSetting(SETTING_KEYS.storeDir) ?? "";
  return {
    consolePort: readInt(store, SETTING_KEYS.consolePort, 0, 0, 65535),
    autoLockMinutes: readInt(store, SETTING_KEYS.autoLockMinutes, 0, 0, 1440),
    storeDir: storeDir.trim().length > 0 ? storeDir : defaults.storeDir,
    rdpBinary: store?.getSetting(SETTING_KEYS.rdpBinary) ?? "",
    vncBinary: store?.getSetting(SETTING_KEYS.vncBinary) ?? "",
  };
}

function asInteger(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function asPath(value: unknown, key: string): string {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const expanded = expandHome(value.trim());
  if (expanded.length === 0) throw new Error(`${key} must not be empty`);
  if (!path.isAbsolute(expanded)) throw new Error(`${key} must be an absolute path`);
  return path.normalize(expanded);
}

function asBinary(value: unknown, key: string): string {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (/[\n\r\t]/.test(trimmed)) throw new Error(`${key} must be a single path or command name`);
  return trimmed;
}

/**
 * Validates a patch against the current settings and returns the next full
 * object. Unknown keys are refused so a typo cannot silently do nothing.
 */
export function validateSettingsPatch(current: ConsoleSettings, patch: unknown): ConsoleSettings {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("settings patch must be an object");
  }
  const next: ConsoleSettings = { ...current };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!KNOWN_KEYS.has(key as (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS])) {
      throw new Error(`unknown setting: ${key}`);
    }
    switch (key) {
      case SETTING_KEYS.consolePort:
        next.consolePort = asInteger(value, key, 0, 65535);
        break;
      case SETTING_KEYS.autoLockMinutes:
        next.autoLockMinutes = asInteger(value, key, 0, 1440);
        break;
      case SETTING_KEYS.storeDir:
        next.storeDir = asPath(value, key);
        break;
      case SETTING_KEYS.rdpBinary:
        next.rdpBinary = asBinary(value, key);
        break;
      case SETTING_KEYS.vncBinary:
        next.vncBinary = asBinary(value, key);
        break;
      default:
        break;
    }
  }
  return next;
}

/** Persists every field (the table is small; a full write keeps it simple). */
export function saveSettings(store: Store | null, next: ConsoleSettings): ConsoleSettings {
  store?.setSetting(SETTING_KEYS.consolePort, String(next.consolePort));
  store?.setSetting(SETTING_KEYS.autoLockMinutes, String(next.autoLockMinutes));
  store?.setSetting(SETTING_KEYS.storeDir, next.storeDir);
  store?.setSetting(SETTING_KEYS.rdpBinary, next.rdpBinary);
  store?.setSetting(SETTING_KEYS.vncBinary, next.vncBinary);
  return next;
}
