# @ours.network/install — `ours-install`

The all-in-one installer for the ours.network stack. One run installs and
configures the shared daemon, MCP adapter, cowork, Telegram connector, Fleet,
and plugins for every safely detected agent harness.

```sh
npm install --global @ours.network/install
ours-install
```

### Stable and nightly channels

Installing `@ours.network/install@latest` selects the stable channel; installing
`@ours.network/install@nightly` selects the nightly channel. Before changing the
machine, the installer resolves `@ours.network/mcp`,
`@ours.network/claude-code`, and `@ours.network/codex`, verifies that their
selected dist-tags expose one exact lockstep version, and fails closed if they
do not. MCP and the Codex launcher are installed by exact version, and local
Claude Code and Codex marketplace manifests pin the corresponding plugin
packages to that same version.

`OURS_CHANNEL=latest|nightly` (or the legacy `OURS_INSTALL_CHANNEL`) remains an
explicit override. Without an override, the installed package's own version
selects the channel.

The normal flow uses one daemon at `~/.ours` on port 3050, shows an eight-stage
progress bar, and asks only for information it cannot safely infer (normally the
Human identity's display name). Existing daemon conflicts and moving a Telegram
connector from another daemon still require explicit confirmation.

## What the installer does

- Installs `@ours.network/cli`, `@ours.network/mcp`,
  `@ours.network/tg-connector`, `@ours.network/cowork`, and
  `@ours.network/fleet` on one release channel.
- Configures, starts, and enables the single shared daemon with a CLI-managed
  user systemd service on Linux or LaunchAgent on macOS.
- Creates the daemon's Human identity (historically called the root identity),
  or preserves the existing one on a re-run.
- Installs the ours plugin into safely detected Claude Code, Codex, and Hermes
  installations.
- Configures and starts cowork as a durable shim over the shared daemon.
- Configures and starts Telegram as a durable shim over the same daemon.
- Runs Fleet's native initialization through prepared settings or its interactive wizard. Fleet owns and
  publishes its v2 configuration, including subscriptions, models, roles,
  templates, and permissions. The installer does not start Fleet roles.

The operator CLI owns daemon configuration, lifecycle, and boot persistence.
The MCP package is only the stdio adapter spawned by agent harnesses; the
installer never asks `ours-mcp` to start a daemon.

Daemon state is temporarily scoped to its package major version. On a same-major
update, the installer refreshes the packages and runs `ours daemon restart`; the
CLI streams structured startup phases until restore is complete instead of
appearing to hang. A different-major update is detected before package
replacement. The installer explains the incompatibility and, only in an
interactive run, offers to stop the CLI-managed daemon, copy the complete state
directory to a timestamped directory under `~/.ours-backups/`, remove the
managed service and old state, then initialize the new major. The default answer is no, and
`OURS_ASSUME_YES` never authorizes this purge.

## What remains stopped

Only Fleet is intentionally not started. Review and activate it when ready:

```sh
# After completing Fleet's wizard and reviewing ~/fleet.yaml:
ours-fleet doctor
ours-fleet config
ours-fleet up
ours-fleet ls
```

The final installer screen repeats these commands and provides a copy-paste
prompt for Claude Code, Codex, or Hermes. The agent should guide local bot-token
entry without asking the user to paste the secret into chat.

## Preview and automation

```sh
ours-install --dry-run
OURS_ASSUME_YES=1 ours-install
ours-install --state-dir /absolute/path --port 3070
```

Dry-run walks the real plan without writing files, installing packages, starting
processes, or changing services. `OURS_ASSUME_YES=1` uses the OS username for a
new Human identity and asks no ordinary setup questions, but it never bypasses
selection conflicts, connector moves, or destructive safeguards.

A non-default daemon must be selected coherently with a config file or matching
port and state directory. Hermes and the generated Fleet role persist that
selection through `OURS_CONFIG`. Claude Code and Codex plugin registrations
cannot store an environment value; for those harnesses the installer prints the
exact `export OURS_CONFIG=...` line that must be added to the shell profile
before starting the harness. There is no per-application daemon.

`OURS_CONFIG` may also name a prepared private host profile containing the
complete `endpoint`, `expectedInstanceId`, and absolute `credentialPath` tuple.
The profile and credential must already be regular current-user files with
private permissions. In this mode the installer verifies `/selection` before
sending the credential to `/version`, installs only MCP, detected Claude/Codex
plugins, and Fleet client support, and never creates, starts, stops, or services
a host daemon. Telegram, cowork, messenger, daemon voice, and daemon state stay
Compose-owned. If `OURS_CONFIG` is unset, the same profile is discovered at
`~/.ours/config.json`; a legacy config there keeps the existing local behavior.

## Uninstall

```sh
ours-uninstall --state-dir "$HOME/.ours"
ours-uninstall --state-dir "$HOME/.ours" --purge
```

The uninstaller delegates service and daemon removal to the `ours` CLI. Identity
state is retained by default. Purging requires the existing destructive gates and
targets only the explicit state directory.

When `OURS_CONFIG` selects a host profile, uninstall removes only selected
client attachments. The operator-owned profile and shared credential are kept
even with `--purge`, and no Compose daemon, service, or state is touched.

## Release channel

`OURS_CHANNEL=nightly` (or `OURS_INSTALL_CHANNEL`) selects the packages' nightly
dist-tags. Without an override, the installer's own version selects the channel.
The operator CLI intentionally has no nightly dist-tag and remains untagged on
both channels.

## Environment

- `OURS_ASSUME_YES=1`: accept safe defaults without prompting.
- `OURS_INSTALL_DRY_RUN=1`: preview without mutation.
- `OURS_NPM`: npm executable.
- `OURS_CONFIG`: explicit legacy daemon config or prepared private host profile.
- `OURS_STATE_DIR`: explicit daemon state directory.
- `OURS_CHANNEL`: `latest` or `nightly`.

## Selected network installations (2.0)

The installed package carries its compatible `assets/sources.json` policy.
`--sources` remains available as an explicit development override. Published releases bind that policy to exact component versions and registry
SHA-512 values. Acquisition validates the ours dependency graph before activation.
A development override without a release binding is not a qualified product release.

```sh
ours-install server install --mode docker --state-dir /private/ours-install
ours-install server install --mode packages --state-dir /private/ours-install
ours-install server status --state-dir /private/ours-install
ours-install server stop --state-dir /private/ours-install
ours-install server start --state-dir /private/ours-install
ours-install server restart --state-dir /private/ours-install
```

Choose one mode for a private installation root. The private `installation.json`
records mode, instance selection, configuration/source paths and service selection;
it never records master bytes or an issued-token registry. The selected policy
is resolved to an exact, role-filtered `sources.json` before acquisition.
Repeated installation retains that concrete selection,
settings and state and repairs credential delivery without rotating the master.
Conflicting modes or source mappings are refused. Docker Compose is an internal
diagnostic artifact under the root's `runtime` directory; all installer calls use
an explicit project directory, Compose file, project name and selected environment.
Assets resolve from the installed package, independently of the working directory.

Package mode requires Node.js 22+, npm and a working systemd user manager on
Linux/WSL or a launchd GUI user domain on macOS. Source builds also require Git,
Python 3, a C/C++ toolchain, make, and the selected repositories' own prerequisites.
Docker mode requires a working Docker engine and Compose 2.35+; its build image
contains the source-build prerequisites. No bind or Docker socket mounts are used.
Server runtime installation selects SDK/CLI, main MCP, Telegram, Cowork and
Messenger. Main MCP is injected into the daemon, not started as a second daemon.
The daemon starts first; consumers are checked through their owning readiness
interfaces. Messenger uses its existing identity prerequisite and never creates an
identity. Its failure is reported after attempting unrelated consumers. Package
mode uses an installer-owned per-installation systemd/launchd Messenger service
for `ours-messenger-server serve`; other services use their owning CLIs.
Native daemon stop invokes the owning CLI's guarded `uninstall-service --yes`
before its process/endpoint stop and verifies the selected job is unloaded or
inactive. This removes its boot-service definition so the manager cannot respawn
a writer during authority operations. A later selected start uses the owning
`install-service --yes` to recreate it. Replacement/restart restore only previously
running services; an excluded stopped daemon keeps its service removed.

```sh
ours-install server access-issue --state-dir /private/ours-install --output /private/client/credential
ours-install server access-replace --state-dir /private/ours-install --confirm
```

Fresh Docker preparation leaves daemon state containing only its selected config.
Only after owning `access-init` succeeds are daemon provenance and MCP profile
files materialized, so fresh setup never needs an inferred migration.
Initial setup calls owning CLI `access-init`, then `access-issue --replace` for
managed credential destinations. Explicit legacy migration adds `--migrate` to
`server install`; migration is never inferred. Global replacement stops consumers
and the daemon, calls `access-replace` once, repairs managed credential delivery,
and restarts only previously running services. If delivery/startup fails after
replacement, the new master remains authoritative and setup is reported incomplete.
Repeat ordinary `server install` to repair delivery without another rotation.
Separately configured clients need newly issued credentials after replacement.
Docker issuance copies only a newly issued file from an administrative container
into private host staging, publishes to an absent protected destination and removes
the temporary administrative container. It never transfers the master.

For client-only installation, supply a private complete network profile with
client-owned installer settings:

```json
{
  "endpoint": "http://server:3050",
  "expectedInstanceId": "12345678-1234-1234-1234-123456789abc",
  "credentialPath": "/private/client/credential",
  "installer": {
    "integrations": ["codex", "claude-code", "fleet"],
    "fleetSettingsPath": "fleet-settings.json"
  }
}
```

```sh
ours-install client install --config /private/client/profile.json
```

Optional `sourcesPath` and `fleetSettingsPath` values are absolute or resolved
relative to the profile file. Select any nonempty subset of integrations; Fleet is optional.
When Fleet settings are supplied, the installer passes them to Fleet's strict
noninteractive `init --settings`; otherwise it opens Fleet's existing wizard.
Fleet validates and publishes its own configuration. Client setup verifies the selected
daemon and packaged OURS MCP before registering native integrations. It acquires
only selected integration packages and their actual client dependencies. It does
not install main MCP, administer daemon state or invoke Docker. Exact npm client
installation needs no Python; Git source builds use the supplied source recipes
and their build prerequisites. Normal native clients need neither Docker nor
server maintenance tools.

Installer imports the profile, issued token, source manifest and optional Fleet
settings into `~/.ours-client/` (directory 0700, files 0600). The saved profile is
`profile.json`, referencing the imported `credential`. Original input files are
left untouched and may be moved or removed after setup. Ordinary new Codex,
Claude and Fleet invocations discover the saved server without an environment
export. Explicit `OURS_CONFIG` still overrides new invocations; installer reports
an existing override and does not edit shell configuration or running sessions.

Repeat with `ours-install client install` to reuse imported inputs and installed
package records. Existing settings and Fleet-generated files are preserved. A
prepared profile for the same endpoint/instance may supply a valid replacement
issued token; another server is refused without changing the default. Invalid
server access is rejected before import. An acquisition or component failure
reports incomplete setup and keeps the saved configuration for retry. Selected
native integrations whose executable is unavailable are incomplete, not installed.
Source repositories or registry access remain prerequisites when packages still
need to be acquired; they are not runtime configuration dependencies.

Interactive no-argument installation asks for package/Docker server mode, a
prepared client profile, or `client`. Client setup offers the saved server when
present. On first setup it asks for the server HTTP endpoint, issued-token file,
source manifest and integration choices, obtains the instance UUID from
`/selection`, displays it, then checks authenticated daemon and MCP access before
saving anything. No UUID must be entered manually. The 2.0 HTTP flow assumes the
approved trusted same-host deployment; selection metadata is not cryptographic
server authentication. Fleet collects missing setup answers through its own wizard.
This network flow never
creates a Human identity. Legacy explicitly selected local flows are retained.

For a managed server, maintenance runs on the server machine through the installer:

```sh
ours-install server backup server snapshot --state-dir /path/to/installation
ours-install server restore server snapshot --state-dir /path/to/installation
ours-install server rebuild --state-dir /path/to/installation
ours-install server update --state-dir /path/to/installation --compatible
```

Backup and restore support the full server or an individual `daemon`, `telegram`,
`cowork`, or `messenger` domain. Reset requires an individual domain and `--confirm`.
The installer stops affected writers and preserves a validated pre-operation
backup before restore, reset, or update. Restore retains current access authority.

Rebuild uses the saved exact source selection. Update resolves the packaged policy,
or an explicitly supplied development override, into a retained replacement.
Preparation does not replace the active runtime. Rebuild requires the same selected sources and equivalent verified dependency records.
Different JSON ordering is harmless; different package bytes or dependency edges refuse
rebuild. Fresh builds record the verified vendor archive bindings so staging paths
can differ without ignoring package integrity.
Changed sources require reviewed storage compatibility through explicit update with `--compatible`; this flag
attests to external evidence and does not establish compatibility by itself.
Services stop before state/runtime publication, and only previously running services
resume. Credentials and identities are not regenerated.

If activation fails, repeat the same update/rebuild command and retain its input
manifest. The installer resumes its saved candidate rather than fetching another
build. `server status` reports the pending phase; `server stop` remains available.
Other mutations refuse until activation completes. There is no automatic rollback
of application state after publication.


New builds retain `build-context.json` alongside their original lockfile and dependency
tree. The context binds the original record bytes to verified vendor tar names,
versions and integrity. Only proven top-level vendor staging paths are normalized;
lockfile integrity and other dependency references remain unchanged. An invalid or
unknown context is an error, including with `--compatible`.

Older records without a context retain their conservative comparison. If a rebuild
is refused because historical staging evidence is unavailable, use a reviewed
`server update --compatible` to establish a newly verified context; this operation
preserves the original record set in the pre-update backup. The flag is an explicit
storage-compatibility attestation, not proof of compatibility or a way to reconstruct
missing historic evidence. Startup never adds a context to existing legacy markers.

Backups with a context use archive format2; legacy backups remain format1. Updated
maintenance reads both formats. Format2 is not readable by older maintenance tools,
so this change does not promise executable downgrade support. Restore validates the
original archive records unchanged, then writes markers for the active target runtime.
Mixed/incomplete context and component record sets are refused before activation.
