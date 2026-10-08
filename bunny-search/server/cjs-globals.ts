/**
 * CommonJS globals shim for Paseo's plugin bundle evaluator.
 *
 * The host compiles the plugin server entry with esbuild
 * (`format: "cjs"`, `platform: "node"`) and evaluates the result with
 * `globalThis.eval` inside a wrapper that supplies only `require`,
 * `module` and `exports` — there is no CommonJS `__dirname` /
 * `__filename` in that scope, and esbuild keeps `platform: "node"`
 * output referencing them as free variables.
 *
 * Until 0.3.0 the plugin's server bundle contained no third-party
 * CommonJS dependencies (zod and the SDK stay external; everything
 * else was plugin source or Node builtins), so the gap never
 * surfaced. The DuckDuckJS library pulls in `@deno/shim-deno`, whose
 * modules read `__dirname` at module scope — evaluating it in the
 * bare eval scope crashed the plugin load with
 * `ReferenceError: __dirname is not defined`.
 *
 * This module therefore defines the globals on `globalThis` and is
 * imported FIRST from `index.server.ts`: ESM import evaluation order
 * is declaration order, so it runs before any bundled dependency
 * factory. `??=` keeps genuine values (e.g. the MCP server's own
 * ESM-bundle banner, where these are module-scope consts) intact —
 * the values below are only ever read to build informational paths
 * inside dependency shims.
 */

const scope = globalThis as typeof globalThis & {
  __dirname?: string;
  __filename?: string;
};

scope.__dirname ??= process.cwd();
scope.__filename ??= `${process.cwd()}/bunny-search-plugin.js`;

export {};
