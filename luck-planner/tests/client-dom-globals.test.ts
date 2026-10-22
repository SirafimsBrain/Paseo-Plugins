/**
 * The client audit from Paseo's plugin spec (`paseo.sh/docs/plugins/reference.md`,
 * "Cross-platform rules"), run over this plugin's `client/` directory.
 *
 * The spec's rule: plugin clients run on iOS, Android and in the browser
 * through React Native Web, so DOM globals (`window`, `document`,
 * `localStorage`, `navigator`), HTML elements and DOM event handlers stay out
 * of cross-platform components. DOM globals belong in `client/web.ts`, declared
 * only for what that module uses and gated on `Platform.OS === "web"`.
 *
 * The audit is a review step by hand; here it is a test, so a regression fails
 * the suite instead of a release. The plugin's own rule from the 0.12.0
 * conformance pass: `client/web.ts` is the *only* module allowed to name a DOM
 * global, and every other `client/` module must stay platform-neutral.
 *
 * The pure half of the typography chain (`client/host-font-scale.ts`) is
 * checked here too: it parses the raw settings document, so it must not read a
 * global itself.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHostFontScale, scaledFont } from "../client/host-font-scale";

const CLIENT_DIR = join(fileURLToPath(new URL("..", import.meta.url)), "client");

/** The one module allowed to name a DOM global. */
const WEB_MODULE = "web.ts";

/** DOM globals the spec names. */
const DOM_GLOBALS: ReadonlyArray<readonly [string, RegExp]> = [
  ["document", /\bdocument\s*\./],
  ["window", /\bwindow\s*\./],
  ["localStorage", /\blocalStorage\b/],
  ["navigator", /\bnavigator\s*\./],
  ["location", /\blocation\s*\.(?:href|assign|replace|reload)\b/],
];

/** DOM-only React props. */
const DOM_PROPS: ReadonlyArray<readonly [string, RegExp]> = [
  ["className", /\bclassName\s*=/],
  ["onClick", /\bonClick\s*=/],
  ["onMouseEnter", /\bonMouseEnter\s*=/],
];

/**
 * HTML elements. An explicit list beats a pattern: `<string | null>` is a
 * TypeScript generic, not a tag, and a lowercase-tag regex would flag every
 * generic in the plugin.
 */
const HTML_ELEMENTS = [
  "a",
  "article",
  "aside",
  "button",
  "canvas",
  "div",
  "form",
  "footer",
  "header",
  "iframe",
  "img",
  "input",
  "label",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "section",
  "select",
  "span",
  "svg",
  "table",
  "tbody",
  "td",
  "textarea",
  "th",
  "thead",
  "tr",
  "ul",
  "video",
] as const;

function clientSources(): Array<{ file: string; source: string }> {
  return readdirSync(CLIENT_DIR)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => ({
      file: name,
      source: readFileSync(join(CLIENT_DIR, name), "utf8"),
    }));
}

/**
 * Drops comments before the audit.
 *
 * A prose mention of `localStorage` is not a DOM access, and the spec's own
 * audit is a grep over the file — so the check here is stricter about *what*
 * it flags (code, not words) while staying equally strict about *where*.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("client DOM-global audit", () => {
  it("keeps DOM globals out of every client module except client/web.ts", () => {
    const offenders: string[] = [];
    for (const { file, source } of clientSources()) {
      if (file === WEB_MODULE) continue;
      const code = stripComments(source);
      for (const [name, pattern] of DOM_GLOBALS) {
        if (pattern.test(code)) offenders.push(`${file} names ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps DOM props and HTML elements out of the client modules", () => {
    const offenders: string[] = [];
    for (const { file, source } of clientSources()) {
      const code = stripComments(source);
      for (const [name, pattern] of DOM_PROPS) {
        if (pattern.test(code)) offenders.push(`${file} uses ${name}`);
      }
      for (const tag of HTML_ELEMENTS) {
        const pattern = new RegExp(`<${tag}(?=[\\s/>])`);
        if (pattern.test(code)) offenders.push(`${file} renders <${tag}>`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gates every export of client/web.ts on the web platform", () => {
    const source = readFileSync(join(CLIENT_DIR, WEB_MODULE), "utf8");
    expect(source).toMatch(/import\s+\{\s*Platform\s*\}\s+from\s+"react-native"/);
    // Every exported function must refuse to run outside the browser.
    const exported = [...source.matchAll(/export function (\w+)/g)].map(
      (match) => match[1],
    );
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) {
      const body = source.slice(source.indexOf(`export function ${name}`));
      const end = body.indexOf("\n}");
      const chunk = end === -1 ? body : body.slice(0, end);
      expect(chunk, `${name} must check the platform`).toMatch(
        /Platform\.OS\s*!==?\s*"web"|Platform\.OS\s*===?\s*"web"/,
      );
    }
  });

  it("keeps client/web.ts the only module that imports react-native's Platform", () => {
    const users = clientSources()
      .filter(({ source }) => /from\s+"react-native"/.test(source))
      .map(({ file }) => file);
    // `react-native` itself is fine anywhere in `client/`; only the DOM-owning
    // module needs `Platform`, and a second reader would be a second door to
    // the page storage.
    expect(users).toContain(WEB_MODULE);
  });
});

describe("the host interface size", () => {
  it("reads the configured size from the raw settings document", () => {
    expect(parseHostFontScale(JSON.stringify({ uiBaseFontSize: 16 }))).toBeCloseTo(
      16 / 14,
    );
    expect(
      parseHostFontScale(JSON.stringify({ appearance: { uiBaseFontSize: "18" } })),
    ).toBeCloseTo(18 / 14);
    expect(
      parseHostFontScale(JSON.stringify({ fonts: { uiBaseFontSize: 12 } })),
    ).toBeCloseTo(12 / 14);
  });

  it("falls back to the default scale for anything unusable", () => {
    expect(parseHostFontScale(null)).toBe(1);
    expect(parseHostFontScale("")).toBe(1);
    expect(parseHostFontScale("not json")).toBe(1);
    expect(parseHostFontScale("null")).toBe(1);
    expect(parseHostFontScale("42")).toBe(1);
    expect(parseHostFontScale(JSON.stringify({ uiBaseFontSize: 0 }))).toBe(1);
    expect(parseHostFontScale(JSON.stringify({ uiBaseFontSize: -2 }))).toBe(1);
    expect(parseHostFontScale(JSON.stringify({ uiBaseFontSize: "big" }))).toBe(1);
    expect(parseHostFontScale(JSON.stringify({ other: 1 }))).toBe(1);
  });

  it("scales a base font size", () => {
    expect(scaledFont(14, 1)).toBe(14);
    expect(scaledFont(13, 16 / 14)).toBe(15);
  });

  it("keeps the typography chain free of DOM globals outside client/web.ts", () => {
    const scale = stripComments(
      readFileSync(join(CLIENT_DIR, "host-font-scale.ts"), "utf8"),
    );
    const hook = stripComments(
      readFileSync(join(CLIENT_DIR, "use-host-typography.ts"), "utf8"),
    );
    for (const source of [scale, hook]) {
      for (const [name, pattern] of DOM_GLOBALS) {
        expect(pattern.test(source), `typography chain names ${name}`).toBe(false);
      }
    }
    // The hook reads through the one allowed door.
    expect(hook).toMatch(/from\s+"\.\/web"/);
  });
});

describe("the client directory", () => {
  it("has the modules the spec expects", () => {
    const files = readdirSync(CLIENT_DIR);
    expect(files).toContain(WEB_MODULE);
    expect(files).toContain("host-font-scale.ts");
    expect(files).toContain("use-host-typography.ts");
    for (const file of files) {
      expect(statSync(join(CLIENT_DIR, file)).isFile()).toBe(true);
    }
  });
});
