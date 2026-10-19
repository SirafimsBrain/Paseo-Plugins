/**
 * The module-location helper (stage J2 — the live-daemon acceptance).
 *
 * The host loads the plugin's server code by transpiling its TypeScript into
 * **CommonJS**, where `import.meta` is an empty object. Every path resolved
 * through `new URL("../dist/dashboard/", import.meta.url)` therefore threw
 * "Invalid URL" on a live install: the plugin reported `running`, the MCP
 * entry was published — and the dashboard stayed down with the reason in the
 * log. The artifact tests could not see it, because they exercise the ESM
 * bundle (`dist/mcp-server.js`), where `import.meta.url` exists.
 *
 * This suite reproduces the host's build exactly: it bundles the server
 * module with esbuild in CommonJS format, lays the output out in the same
 * shape as a plugin checkout (`server/` next to `package.json` and
 * `dist/dashboard/`) and asks the *built* module where its files are.
 */
import { build } from "esbuild";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { moduleDirectory, modulePath } from "../server/module-dir";
import { resolveDashboardDir, resolvePluginVersion } from "../server/http-server";
import { configuredPluginRoot } from "../server/plugin-paths";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_VERSION = "9.9.9-host-build";

let tempRoot = "";
let commonJs: { resolveDashboardDir(): string; resolvePluginVersion(): string };

beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "luck-planner-cjs-"));
  // The shape of a plugin checkout: the server module next to the manifest
  // and the built dashboard.
  mkdirSync(path.join(tempRoot, "server"), { recursive: true });
  mkdirSync(path.join(tempRoot, "dist", "dashboard"), { recursive: true });
  writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ name: "luck-planner", version: PLUGIN_VERSION }),
  );
  writeFileSync(path.join(tempRoot, "dist", "dashboard", "index.html"), "<!doctype html>");
  const outfile = path.join(tempRoot, "server", "http-server.cjs");
  await build({
    entryPoints: [path.join(ROOT, "server", "http-server.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    external: ["node:*"],
    logLevel: "silent",
  });
  const require = createRequire(import.meta.url);
  commonJs = require(outfile) as typeof commonJs;
});

afterAll(() => {
  if (tempRoot !== "") rmSync(tempRoot, { recursive: true, force: true });
});

describe("the module location in the ESM build (the tests, the MCP bundle)", () => {
  it("resolves the module's own directory", () => {
    expect(moduleDirectory()).toBe(path.join(ROOT, "server"));
  });

  it("resolves the dashboard next to the checkout", () => {
    expect(resolveDashboardDir()).toBe(path.join(ROOT, "dist", "dashboard"));
    // The built dashboard really is there (the build step produced it).
    expect(fs.existsSync(path.join(resolveDashboardDir(), "index.html"))).toBe(true);
  });

  it("reads the plugin version from the manifest", () => {
    expect(resolvePluginVersion()).toBe(
      JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version as string,
    );
  });
});

describe("the module location in the CommonJS build (what the host runs)", () => {
  it("finds the dashboard instead of throwing 'Invalid URL'", () => {
    // The symptom of the bug: `new URL("../dist/dashboard/", undefined)`.
    expect(() => commonJs.resolveDashboardDir()).not.toThrow();
    expect(commonJs.resolveDashboardDir()).toBe(
      path.join(tempRoot, "dist", "dashboard"),
    );
  });

  it("finds a dashboard directory that exists", () => {
    expect(fs.existsSync(commonJs.resolveDashboardDir())).toBe(true);
  });

  it("reads the plugin version from the manifest", () => {
    // The second symptom: the version silently degraded to "0.0.0".
    expect(commonJs.resolvePluginVersion()).toBe(PLUGIN_VERSION);
  });
});

describe("the installed directory (the daemon's own truth)", () => {
  let home = "";
  let loaderDir = "";
  let previousHome: string | undefined;
  let hostBuild: { resolveDashboardDir(): string; resolvePluginVersion(): string };

  beforeAll(async () => {
    // A fake Paseo home whose config points at a fake checkout — the shape a
    // live install has: the code is loaded from the host's own directory, the
    // files stay in the checkout.
    home = mkdtempSync(path.join(tmpdir(), "luck-planner-home-"));
    const checkout = path.join(home, "checkout", "luck-planner");
    mkdirSync(path.join(checkout, "dist", "dashboard"), { recursive: true });
    writeFileSync(path.join(checkout, "dist", "dashboard", "index.html"), "<!doctype html>");
    writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ plugins: { "luck-planner": { path: checkout } } }),
    );
    // The host's loader directory: the module lives here, with *no* built app
    // next to it — exactly the live case.
    loaderDir = mkdtempSync(path.join(tmpdir(), "luck-planner-loader-"));
    mkdirSync(path.join(loaderDir, "server"), { recursive: true });
    const outfile = path.join(loaderDir, "server", "http-server.cjs");
    await build({
      entryPoints: [path.join(ROOT, "server", "http-server.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      external: ["node:*"],
      logLevel: "silent",
    });
    const require = createRequire(import.meta.url);
    hostBuild = require(outfile) as typeof hostBuild;
    previousHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = home;
  });

  afterAll(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    if (home !== "") rmSync(home, { recursive: true, force: true });
    if (loaderDir !== "") rmSync(loaderDir, { recursive: true, force: true });
  });

  it("is read from the daemon's config", () => {
    expect(configuredPluginRoot()).toBe(
      path.join(home, "checkout", "luck-planner"),
    );
  });

  it("is where the dashboard and the manifest come from on a live install", () => {
    // The live case: the module's own directory holds no built app (the host
    // loads the code from its own directory), so the installed directory
    // answers — and the dashboard is served from the checkout that has it.
    const checkout = path.join(home, "checkout", "luck-planner");
    expect(hostBuild.resolveDashboardDir()).toBe(
      path.join(checkout, "dist", "dashboard"),
    );
    expect(hostBuild.resolvePluginVersion()).toBe("1.2.3");
  });

  it("does not fall back to a directory without the built app", () => {
    // The bug's second half: the placeholder page ("the dashboard web app is
    // not built in this checkout") was served because the resolved directory
    // had no `index.html`.
    const resolved = hostBuild.resolveDashboardDir();
    expect(fs.existsSync(path.join(resolved, "index.html"))).toBe(true);
  });
});

describe("the helper itself", () => {
  it("joins segments onto the module directory", () => {
    expect(modulePath("..", "package.json")).toBe(
      path.join(ROOT, "package.json"),
    );
  });

  it("survives a module without an ESM url", () => {
    // `modulePath` is the only door: it must not throw when `import.meta.url`
    // is missing, and the CommonJS build above proves it does not.
    expect(typeof modulePath("x")).toBe("string");
  });
});
