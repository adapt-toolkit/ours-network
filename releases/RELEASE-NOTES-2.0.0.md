# Installer 2.0.0 (major release)

This release promotes the validated `prerelease` line to `main` and publishes
the first stable `@ours.network/install` from this repository. The previous
stable installer, 1.1.1, was published from `ours-mcp`. The version is
produced by the `main` version-bump job from the introduced commits; it is not
written by hand.

## Stable component set (`releases/stable.json`)

| component | version |
|---|---|
| `@ours.network/sdk` | 5.0.0 |
| `@ours.network/cli` | 4.0.0 |
| `@ours.network/daemon` | 5.0.0 |
| `@ours.network/tg-connector` | 2.0.0 |
| `@ours.network/cowork` | 2.0.0 |
| `@ours.network/messenger-server` | 2.0.0 |
| `@ours.network/notifications` | 1.0.0 |
| `@ours.network/fleet` | 2.0.0 |
| `@ours.network/mcp` | 2.0.0 |
| `@ours.network/codex` | 2.0.0 |
| `@ours.network/claude-code` | 2.0.0 |

The host CLI selects SDK 5.0.0 and CLI 4.0.0. Each entry carries the exact
registry SHA-512 integrity of the published archive.

## Breaking changes

- The installer is published from `ours-network` instead of `ours-mcp`.
- It installs the major releases above (SDK 5, CLI 4, daemon 5 and the
  dependent 2.0.0 services and integrations).
- Setup is unified and interactive. Server runtimes use the standalone daemon
  behind a one-port Docker gateway, and existing installations are migrated
  from their legacy state.

## Features promoted from prerelease

- Native host CLI installed for every client setup.
- Human identity bootstrap with private local client handoff.
- The installed Fleet prepares its managed CLI policy.
