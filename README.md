# Paseo Plugins

This repository contains my plugin developments for the [Paseo](https://paseo.sh/) project.

All code is written for personal use. The plugins here can be used in the Paseo project without any restrictions.

## Plugins

- [session-manager](./session-manager/README.md) — lists and deletes the on-disk sessions of the coding agents connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, acpx) through a workspace panel and Command Center item.
- [command-center](./command-center/README.md) — a personal command center for Paseo: save reusable prompt and shell commands as templates, run them against any workspace or agent with a live preview, and browse run history.

## License

MIT. See [LICENSE](./LICENSE).

## Compatibility

| Plugin | Verified Paseo | SDK | Result |
| ------ | -------------- | --- | ------ |
| [session-manager](./session-manager/README.md) | 0.9.0 (2026-09-22) | `@getpaseo/plugin@0.9.0` | Compatible, no code changes required (typecheck + vitest: 8 suites, 70 tests). Details: [Compatibility](./session-manager/__doc.md#compatibility). |
| [command-center](./command-center/README.md) | 0.9.0 (2026-09-22) | `@getpaseo/plugin@0.9.0` | Compatible, verified by installing the plugin into the running daemon (typecheck + vitest: 5 suites, 37 tests). Details: [Compatibility](./command-center/__doc.md#compatibility). |
