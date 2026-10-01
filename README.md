# Paseo Plugins

This repository contains my plugin developments for the [Paseo](https://paseo.sh/) project.

All code is written for personal use. The plugins here can be used in the Paseo project without any restrictions.

## Plugins

- [session-manager](./session-manager/README.md) — lists and deletes the on-disk sessions of the coding agents connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, acpx) through a workspace panel and Command Center item.
- [command-center](./command-center/README.md) — a personal command center for Paseo: save reusable prompt and shell commands as templates (with per-command MCP server attachment), group them into categories, search them, run them against any workspace or agent with a live preview, browse run history with a configurable retention limit, schedule prompt commands on the standard Paseo scheduler with full tracking inside the plugin, insert commands from the composer attachment picker, and configure defaults and automation (auto-run on agent turn end, workspace bootstrap) in its own settings screen.
- [memory-flash](./memory-flash/README.md) — shared persistent memory for coding agents: a bundled stdio MCP server (SQLite + FTS5) that any agent connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, acpx) can read and write, automatic MCP injection into every Paseo-created agent, tagging by agent/project/kind (decision, procedure, handoff, bugfix, pattern, pitfall, reference, note), full revision history with restore, a Paseo surface for browsing/searching/editing/delegating memory maintenance to agents, one-button skill installation into agent skill directories, direct Cline MCP registration (Cline ignores session stdio servers, so the plugin writes its own settings file), and remote host registration (Paseo SSH implemented, tcp/relay stubbed).

Both plugins follow the host Appearance settings (interface font, code font, and interface text size) in their UI: sizes are scaled relative to the app-wide value, and a configured font family is applied to plugin text.

## License

MIT. See [LICENSE](./LICENSE).

## Compatibility

| Plugin | Verified Paseo | SDK | Result |
| ------ | -------------- | --- | ------ |
| [session-manager](./session-manager/README.md) | 0.10.0 (2026-09-29) | `@getpaseo/plugin@0.10.0` | Compatible, no code changes required (typecheck + vitest: 8 suites, 70 tests). Host font scaling and font family support added in plugin 0.2.0. Details: [Compatibility](./session-manager/__doc.md#compatibility). |
| [command-center](./command-center/README.md) | 0.10.1 (2026-09-29) | `@getpaseo/plugin@0.10.1` | Compatible, verified by installing the plugin into the running daemon (typecheck + vitest: 9 suites, 98 tests). Categories, search, and host font scaling added in plugin 0.2.0; scheduler integration (standard Paseo Schedules with plugin-side management and run tracking) added in 0.3.0; scheduling from command cards and for shell commands added in 0.4.0; settings screen, lifecycle-hook automation, MCP server injection, composer attachment source, and extended `/cc` subcommands added in 0.5.0. Details: [Compatibility](./command-center/__doc.md#compatibility). |
| [memory-flash](./memory-flash/README.md) | 0.10.2 (2026-09-30) | `@getpaseo/plugin@0.10.1` | Compatible, verified by installing the plugin into the running daemon (typecheck + vitest: 6 suites, 45 tests). Details: [Compatibility](./memory-flash/__doc.md#compatibility). |
