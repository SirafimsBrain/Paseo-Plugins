import { describe, expect, it } from "vitest";
import {
  defaultHostTypography,
  normalizeHostTypography,
  readHostTypographyFromLocalStorage,
  scaledFont,
} from "../shared/host-fonts";

describe("normalizeHostTypography", () => {
  it("falls back to defaults for unknown shapes", () => {
    expect(normalizeHostTypography(null)).toBeNull();
    expect(normalizeHostTypography("junk")).toBeNull();
    expect(normalizeHostTypography({})).toMatchObject({
      scale: 1,
      uiFontFamily: "",
      monoFontFamily: "",
      uiBaseFontSize: 14,
      contentFontSize: 15,
      codeFontSize: 12,
    });
  });

  it("computes the scale against the host base of 14", () => {
    // Matches the settings observed in the live desktop leveldb:
    // uiBaseFontSize 16 -> scale ~1.14.
    const result = normalizeHostTypography({ uiBaseFontSize: 16, uiFontFamily: "Roboto", monoFontFamily: "Fira Code" });
    expect(result).not.toBeNull();
    expect(result!.uiBaseFontSize).toBe(16);
    expect(result!.scale).toBeCloseTo(16 / 14, 5);
    expect(result!.uiFontFamily).toBe("Roboto");
    expect(result!.monoFontFamily).toBe("Fira Code");
  });

  it("migrates the legacy uiFontSize percent-like field", () => {
    // Host: Math.round(FONT_SIZE.base * uiFontSize / 16).
    const result = normalizeHostTypography({ uiFontSize: 20 });
    expect(result!.uiBaseFontSize).toBe(Math.round((14 * 20) / 16));
  });

  it("sanitizes dangerous characters out of font families", () => {
    const result = normalizeHostTypography({ uiFontFamily: "Evil<;>{}Font\nX" });
    expect(result!.uiFontFamily).toBe("EvilFont X");
  });

  it("clamps insane scales", () => {
    expect(normalizeHostTypography({ uiBaseFontSize: 999 })!.scale).toBe(2);
    expect(normalizeHostTypography({ uiBaseFontSize: 1 })!.scale).toBe(0.5);
    expect(normalizeHostTypography({ uiBaseFontSize: Number.NaN })!.scale).toBe(1);
  });
});

describe("scaledFont", () => {
  it("scales and rounds to integers", () => {
    const typography = normalizeHostTypography({ uiBaseFontSize: 16 })!;
    expect(scaledFont(14, typography)).toBe(Math.round(14 * (16 / 14)));
    expect(scaledFont(12, typography)).toBe(Math.round(12 * (16 / 14)));
  });

  it("keeps defaults untouched", () => {
    expect(scaledFont(12, defaultHostTypography())).toBe(12);
    expect(scaledFont(14, defaultHostTypography())).toBe(14);
  });
});

describe("readHostTypographyFromLocalStorage", () => {
  it("returns null without storage", () => {
    expect(readHostTypographyFromLocalStorage(null)).toBeNull();
    expect(readHostTypographyFromLocalStorage(undefined)).toBeNull();
  });

  it("parses the @paseo:app-settings payload", () => {
    const payload = JSON.stringify({
      uiFontFamily: "Roboto",
      monoFontFamily: "Fira Code",
      uiBaseFontSize: 18,
    });
    const storage = { getItem: (key: string) => (key === "@paseo:app-settings" ? payload : null) };
    const result = readHostTypographyFromLocalStorage(storage);
    expect(result!.uiFontFamily).toBe("Roboto");
    expect(result!.scale).toBeCloseTo(18 / 14, 5);
  });

  it("returns null for junk content", () => {
    const storage = { getItem: () => "not json" };
    expect(readHostTypographyFromLocalStorage(storage)).toBeNull();
  });
});
