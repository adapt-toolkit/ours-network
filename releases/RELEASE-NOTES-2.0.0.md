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
fails closed while it is empty. `select-release-package.mjs` cannot create the
first stable set: it picks the channel from the installer version (nightly on
this branch) and edits one package of an already complete manifest. Bind the
whole set at once after every component below is **published** on npm:

```sh
node scripts/bootstrap-stable-release.mjs \
  @ours.network/sdk@4.0.0 @ours.network/cli@3.0.0 @ours.network/daemon@4.0.0 \
  @ours.network/notifications@1.0.0 @ours.network/tg-connector@2.0.0 \
  @ours.network/cowork@2.0.0 @ours.network/messenger-server@2.0.0 \
  @ours.network/mcp@2.0.0 @ours.network/codex@2.0.0 @ours.network/claude-code@2.0.0 \
  @ours.network/fleet@2.0.0
git add releases/stable.json && git commit -m "chore(release): bind the stable 2.0.0 component set"
scripts/verify-stable-candidate.sh 2.0.0                 # any host
CI=true OURS_TEST_DOCKER=1 scripts/verify-stable-candidate.sh 2.0.0   # disposable CI runner only
```

`bootstrap-stable-release.mjs` requires an exact stable version for every
component of the nightly manifest (including the daemon). It reads each
registry integrity, checks it against the served archive and the installer's
required and degrading capabilities (strict), and writes `releases/stable.json`
with `hostCli` = SDK + CLI. It leaves `installerVersion` null for the main bump
to bind, and writes nothing if any component fails.

`verify-stable-candidate.sh` applies the main bump's edits (installer package,
workspace lock, `stable.json` installerVersion) in a temporary worktree. It
then runs the stable gates the nightly-versioned branch never reaches:
`npm ci`, `test:release`, `npm test`,
`verify-release --installed --require-all-capabilities` (registry archives,
installed dependency graph, host CLI and global Fleet install), the stable pack
assertions. With `OURS_TEST_DOCKER=1` it also runs the Docker install,
gateway, notifications recovery, runtime permission and legacy upgrade
qualifications; these create real containers and volumes and require `CI=true`,
so run them only on a disposable CI runner (for example a `workflow_dispatch`
job on the exact head), never on the Owner's current installation. The
runtime-permission check qualifies the release embedded in the packed installer
and asserts it is the stable candidate. Run both on the exact PR head before the
Owner merges; CI on this branch only proves the nightly set.

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

No stable integrity is recorded here because none of these versions is
published yet. The Fleet 2.0.0 archive must declare every capability in
`scripts/release-capabilities.mjs`; Fleet 1.1.5 is refused for lacking
`cowork.http-management-v1` and others.

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
- Server update stops the gateway with nginx fast shutdown and only exempts a
  forced gateway stop after the reported mounts are confirmed.
