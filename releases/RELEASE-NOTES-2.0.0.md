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

These are changes to the command-line contract of the published
`@ours.network/install` 1.1.1:

- **Non-interactive runs.** In 1.1.1, `OURS_ASSUME_YES=1` accepted safe
  defaults without prompting. Now a non-terminal or `OURS_ASSUME_YES` run
  needs a complete preset (for example `--identity-name` and the chosen
  integrations) and fails instead of guessing.
- **`--state-dir`.** In 1.1.1 it named the daemon state directory, with
  `~/.ours` as the default. Now it names the managed installation root and is
  required for `all` and `server` setups.
- **`--port`.** In 1.1.1 it was the port used when creating the daemon. In
  Docker mode it is now the public port of the one-port gateway.

Automation written for 1.1.1 that relies on these behaviours has to be
updated. The installer also moves from `ours-mcp` to `ours-network` and now
installs the SDK 5 / CLI 4 / daemon 5 component set; neither of those is the
reason for the major version.

## Features promoted from prerelease

- Native host CLI installed for every client setup.
- Human identity bootstrap with private local client handoff.
- The installed Fleet prepares its managed CLI policy.
