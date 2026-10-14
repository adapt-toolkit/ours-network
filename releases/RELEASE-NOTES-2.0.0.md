# Installer 2.0.0 (major release candidate, blocked on component publication)

This release promotes the validated `prerelease` installer line to `main` as
`@ours.network/install` 2.0.0. The installer version is produced by the `main`
version-bump job (`scripts/bump-installer-version.mjs stable --commit`), not
written by hand: the introduced `feat!:` commit selects a major bump over
max(local core 1.2.0, published `latest` 1.1.1).

`@ours.network/install` 1.1.1 was the last installer published from ours-mcp;
installer ownership moved to this repository (ours-mcp #106).

## Required stable component set

The `main` bump validates `releases/stable.json` before changing any file and
fails closed while it is empty. Before this release merges, every component
below must be **published** on npm `latest`, then selected with its registry
integrity and verified:

```sh
node scripts/select-release-package.mjs <package> <published-version>   # for each row
node scripts/verify-release.mjs --installed --require-all-capabilities
npm run test:release && npm test
```

| package | source release PR | nightly selected today | stable target |
|---|---|---|---|
| `@ours.network/sdk` (+ `hostCli`) | ours-sdk | 3.8.1-nightly.18 | 4.0.0 |
| `@ours.network/cli` (+ `hostCli`) | ours-sdk | 2.8.1-nightly.16 | 3.0.0 |
| `@ours.network/daemon` | ours-sdk | 3.8.1-nightly.10 | 4.0.0 |
| `@ours.network/notifications` | ours-notifications | 0.3.1-nightly.3 | 1.0.0 |
| `@ours.network/tg-connector` | ours-tg-connector | 1.0.1-nightly.12 | 2.0.0 |
| `@ours.network/cowork` | ours-cowork | 1.3.4-nightly.20261013.e8a690f | 2.0.0 |
| `@ours.network/messenger-server` | ours-messenger-server | 1.0.31-nightly.18 | 2.0.0 |
| `@ours.network/mcp` | ours-mcp | 1.2.0-nightly.14 | 2.0.0 |
| `@ours.network/codex` | ours-mcp | 1.2.0-nightly.14 | 2.0.0 |
| `@ours.network/claude-code` | ours-mcp | 1.2.0-nightly.14 | 2.0.0 |
| `@ours.network/fleet` | ours-fleet | 1.2.0-nightly.61 | 2.0.0 |

`select-release-package.mjs` selects into the manifest of the channel matching
`packages/installer/package.json`. That is `nightly` on this branch, so the
stable selection is made against `releases/stable.json` once the stable
versions exist. No stable integrity is recorded here because none of these
versions is published yet.

## Highlights since 1.1.1

- One installer for server and client hosts: shared daemon, MCP, cowork,
  Telegram, Fleet initialization, harness plugins and Human identity bootstrap.
- Standalone daemon selected for server runtimes; native host CLI installed for
  every client setup.
- One-port Docker gateway with recoverable migration of legacy state.
- Installed Fleet prepares its managed CLI policy when the selected Fleet
  declares it.
- Exact, integrity-pinned per-channel component sets and automated installer
  channel version bumps.
