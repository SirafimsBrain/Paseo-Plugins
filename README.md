# Paseo Plugins

This repository contains my plugin developments for the [Paseo](https://paseo.sh/) project.

All code is written for personal use. The plugins here can be used in the Paseo project without any restrictions.

## Plugins

- [session-manager](./session-manager/README.md) — lists and deletes the on-disk sessions of the coding agents connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, acpx) through a workspace panel and Command Center item.
- [command-center](./command-center/README.md) — a personal command center for Paseo: save reusable prompt and shell commands as templates, group them into categories, search them, run them against any workspace or agent with a live preview, and browse run history.

Both plugins follow the host Appearance settings (interface font, code font, and interface text size) in their UI: sizes are scaled relative to the app-wide value, and a configured font family is applied to plugin text.

## License

MIT. See [LICENSE](./LICENSE).

## Compatibility

| Plugin | Verified Paseo | SDK | Result |
| ------ | -------------- | --- | ------ |
| [session-manager](./session-manager/README.md) | 0.9.0 (2026-09-22) | `@getpaseo/plugin@0.9.0` | Compatible, no code changes required (typecheck + vitest: 8 suites, 70 tests). Host font scaling and font family support added in plugin 0.2.0. Details: [Compatibility](./session-manager/__doc.md#compatibility). |
| [command-center](./command-center/README.md) | 0.9.0 (2026-09-22) | `@getpaseo/plugin@0.9.0` | Compatible, verified by installing the plugin into the running daemon (typecheck + vitest: 8 suites, 78 tests). Categories, search, and host font scaling added in plugin 0.2.0. Details: [Compatibility](./command-center/__doc.md#compatibility). |
