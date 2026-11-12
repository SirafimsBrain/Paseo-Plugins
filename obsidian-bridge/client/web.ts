import { Platform } from "react-native";
import {
  readHostTypographyFromLocalStorage,
  type HostTypography,
} from "../shared/host-fonts";

/**
 * The single home for DOM globals in this plugin's client code.
 *
 * Paseo runs plugin clients on iOS, Android and the browser through React
 * Native Web, so DOM globals belong in `client/web.ts`, declared only for what
 * this module uses, with every export gated on `Platform.OS === "web"` and a
 * native fallback.
 */

type MinimalStorage = { getItem(key: string): string | null };

/**
 * Reads the host appearance settings out of the page's `localStorage`, where
 * the desktop app persists them. Returns `null` outside the browser.
 */
export function readHostTypography(): HostTypography | null {
  if (Platform.OS !== "web") return null;
  const scope = globalThis as unknown as { localStorage?: MinimalStorage };
  const storage = scope.localStorage;
  return readHostTypographyFromLocalStorage(storage);
}
