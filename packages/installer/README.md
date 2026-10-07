## Install first, connect the App afterwards

```sh
ours-install --username alex --name Alex --surname Taylor --disable-fleet-agents-setup
```

This permanent command contains no tunnel credentials or enrollment expiry. On a terminal it asks for the remaining installation choices, including Docker, Podman or native packages. The username is local and has no global uniqueness check. A fresh root is named `<username>@<hostname>`; the optional `--hostname` defaults to the machine name. Messenger stores Name and Surname through its supported profile API. Retried setup retains root identities and existing Messenger profiles.

`--disable-fleet-agents-setup` installs the Fleet CLI and saves the choice without opening its agent/model wizard or rewriting existing Fleet configuration. Configure agents in the App after device linking. Complete presets still work unattended; partial presets require a terminal and cannot use `OURS_ASSUME_YES`.

### Fleet task commands from a harness command sandbox

After Fleet configuration, and again on update, the installer asks the exact Fleet it installed to run `ours-fleet managed-cli setup`. Fleet owns that policy; the installer writes no Codex rule or Claude setting itself, and the step starts no agent session and no model. It runs only when the installed Fleet declares the `managed-cli.setup-v1` capability; the Fleet release this installer pins does. With an earlier Fleet (a retained or development installation) it is skipped (and `--fleet-task-workflow` reports that it was not applied), and it never fails an installation: an unsupported combination is printed with Fleet's reason and left exactly as sandboxed as before.

Nothing is prepared unless an Agent declares `managed_cli: [task-workflow]`. To opt agents in from the installer, name them:

```sh
ours-install client --config /private/profile.json --integrations codex,fleet \
  --fleet-settings /private/fleet-settings.json --fleet-task-workflow FleetCoordinator
```

`--fleet-task-workflow` takes a comma-separated list of Fleet agent names, requires the Fleet integration and conflicts with `--disable-fleet-agents-setup`. It adds that one key to each named Agent and changes no permission. The prepared scope is the packaged Coordinator task workflow (`task create|start|finish|block|unblock|review|list|show`, `room show|members`, template/plan/help inspection) for one pinned Fleet configuration; `task start` and `task finish` provision and retire rooms and agents, which is real authority, and the installer prints that scope. The result is generated configuration only. It is not evidence that a command reached a supervisor: `ours-fleet managed-cli status` and `ours-fleet doctor` report what running agents actually observed. Fleet's `docs/validation/managed-cli-permissions.md` lists the qualified harnesses and platforms.

The separate `ours-fleet setup-tunnel <encoded-v2-grant>` step is supported by the pinned Fleet release. Its private App payload remains scoped, signed-root-bound and expiring. Fleet prints its QR and private single-use connection code immediately after successful setup; scan or paste it into the App. `ours-fleet link-device` remains available for additional devices or expired codes. Do not put the expiring tunnel payload in the permanent installer command.

Native packages currently provide server-only installation; full Fleet/App onboarding requires the supported gateway (Docker or Podman). The installer refuses unsupported native full-stack setup before changing anything. This flow does not add a native gateway.

See [one-connection setup, localhost:4050 and systemd migration](GATEWAY_SETUP.md) for the gateway-only client workflow.

# @ours.network/install — one installer for the whole stack

Requires Node.js 22+ and npm. Install the selected release channel:

```sh
npm install -g @ours.network/install@nightly
ours-install
```

With no arguments, the wizard explains each step and offers keyboard choices.
Use arrow keys and Enter to choose, and Space to select integrations. Recommended
settings keep advanced ports and package overrides out of the usual flow. Text
input is used for your name and explicitly customized paths or ports. Docker is recommended for the integrated full-stack gateway on every platform;
native packages remain available for server-only setup. On Windows run the
installer inside WSL with Docker Desktop integration. This recommendation concerns
packaging and isolation, not a guarantee that emulated x64 is faster on ARM Macs.

The same installer accepts complete CLI presets. It reports missing answers before
changing the machine and never opens hidden prompts when arguments are supplied.
Both forms show the same preparation, identity, update and readiness progress.

```sh
# Whole stack, with prepared Fleet settings and no interactive prompts:
ours-install --mode docker --state-dir "$HOME/ours-docker" \
  --identity-name "Your Name" --integrations codex,fleet \
  --fleet-settings "$HOME/fleet-settings.json"

# Native server only; native and packages mean the same mode:
ours-install server --mode native --state-dir "$HOME/ours-native" \
  --identity-name "Your Name"

# Clients connected to an existing server:
ours-install client --config /private/client/profile.json \
  --integrations codex,fleet --fleet-settings /private/fleet-settings.json

# Update a retained complete installation and its clients:
ours-install all update --mode docker --state-dir "$HOME/ours-docker" \
  --identity-name "Your Name" --integrations codex,fleet \
  --fleet-settings "$HOME/fleet-settings.json" --compatible
```

`server` and `client` are presets of the same flow, not separate interactive
installers. `--integrations none` explicitly skips client integrations. Use
`--dry-run` with a complete preset to preview it, and `--help` for all options.
Fleet's own wizard is available only in interactive setup; CLI Fleet setup requires
its JSON settings file. Fleet stays stopped until you review and activate it.

The server installs the daemon/SDK/CLI, Telegram, Cowork and Messenger.
It starts the daemon, preserves the existing Human identity (or creates it once),
then starts its applications. Full-stack setup issues a separate local client
credential and configures the selected Codex, Claude Code and Fleet integrations.
Existing identity keys and names are retained on update. An update's storage
compatibility must be reviewed before supplying `--compatible`.

The installer embeds exact component versions and SHA-512 values for its release.
An existing server's retained release selects matching local clients. Secrets are
read from protected files, and client setup never copies the daemon API master.

## Runtime and client packages

Server selections include `@ours.network/daemon`, whose `ours-daemon` binary owns
runtime startup and service administration. Docker runs `ours-daemon serve`;
native installations install its systemd/launchd service. Existing retained
installations can still stop and restore their older CLI-owned runtime.

Client selections contain the thin SDK and CLI, plus MCP when a harness needs
it. They exclude the daemon and its native database/ADAPT dependencies. Fleet
runs beside the harnesses on the client machine and calls the daemon HTTP API.
Client commands report an unavailable server and never start one automatically.

The checked-in source policy and packed installer retain the existing server
release set (SDK `3.8.1-nightly.11`, CLI `2.8.1-nightly.9`, daemon
`3.8.1-nightly.3`). The isolated host CLI uses published SDK
`3.8.1-nightly.13` and CLI `2.8.1-nightly.11`, including the shared gateway
profile resolver. `releases/nightly.json` binds both selections to verified
SHA512 integrities. Gateway-only Fleet/MCP release adoption is still pending;
see [GATEWAY_SETUP.md](GATEWAY_SETUP.md). Mixed or unselected nested ours
versions remain rejected within each selected graph. An explicit `--sources`
override remains available for development.

## Migrate an existing global installation

The wizard detects the old `~/.ours/config.json` and offers to keep its identities,
messages, keys and settings in the new installation. It follows the configured
state directory, including a custom location. An equivalent unattended preset is:

```sh
ours-install all --mode docker --state-dir "$HOME/ours-docker" \
  --migrate-from "$HOME/.ours/config.json" --compatible --integrations codex
```

Run the old daemon before the first migration so the installer can record and
verify its identities. The new runtime is downloaded/built first. Then the old
boot service and daemon stop, and the complete daemon state is copied while its
writer lock is held. Docker migration imports that copy into its named storage
volume. Existing Human/role names and CIDs must match before applications start;
migration never creates a replacement Human.

The original state/configuration remain unchanged. A private `legacy-backup`
directory stores the original config/service definition, and
`legacy-client/profile.json` is a prepared connection profile for the new server.
Selected integrations are configured by the usual client setup. The global `ours` command is switched to a launcher for the managed installation
only after verifying ownership of its existing npm entry; foreign or read-only
commands are refused before migration. Ordinary `ours identity list` is checked
after cutover. Lifecycle commands manage the new installation, and selection
overrides cannot accidentally return to the old daemon. The old configuration is
not reinterpreted as a client profile. Do not start the old state alongside the
migrated daemon. Reinstalling the global CLI with npm can replace the launcher;
repeat the same migration command to verify and repair that routing.

Repeat the same command after an interruption. Once the destination has started,
retries repair it in place instead of replacing it with an older source snapshot.
The source is kept stopped after an activation failure to avoid diverging identity
sessions. Migration requires local Linux/macOS (or WSL) with `node:sqlite` support,
a verifiable old CLI/service, and a separate target directory. External PostgreSQL
history or unsupported external MCP/token-delivery paths are refused before
shutdown. Unrelated application data outside the daemon tree is not copied.

## Selected network installations (2.0)

The installed package carries its compatible `assets/sources.json` policy.
`--sources` remains available as an explicit development override. Published releases bind that policy to exact component versions and registry
SHA-512 values. Acquisition validates the ours dependency graph before activation.
A development override without a release binding is not a qualified product release.

```sh
ours-install server install --mode docker --state-dir /private/ours-install --identity-name "Your Name"
ours-install server install --mode packages --state-dir /private/ours-install --identity-name "Your Name"
ours-install server status --state-dir /private/ours-install
ours-install server stop --state-dir /private/ours-install
ours-install server start --state-dir /private/ours-install
ours-install server restart --state-dir /private/ours-install
```

Choose one mode and a folder for its programs and data. The private `installation.json`
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
Docker is recommended for macOS and Windows. Install and start Docker Desktop
on those hosts; on Linux, install Docker Engine and the Compose plugin. If Docker
is unavailable, the installer explains how to install/start it or use
`server install --mode packages --state-dir <new-empty-directory>` instead.
Native Windows installations require WSL with a working systemd user manager.
The installer never switches an existing installation's mode automatically.
Server installation shows each stage before it starts, streams Docker builds and
native package acquisition, and reports completion only after service readiness.
If a Docker service fails, the error includes its last 50 log lines (bounded in
size) and a command to inspect the logs. A failed daemon prevents consumers from
starting; a failed consumer does not prevent checks of unrelated consumers.
Server runtime installation selects SDK/CLI, Telegram, Cowork and
Messenger. MCP runs locally with the Codex and Claude Code plugins and calls the daemon API through the SDK.
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
ours-install client install --config /private/client/profile.json --integrations codex,claude-code
```

Optional `sourcesPath` and `fleetSettingsPath` values are absolute or resolved
relative to the profile file. Select any nonempty subset of integrations; Fleet is optional.
When Fleet settings are supplied, the installer passes them to Fleet's strict
noninteractive `init --settings`; otherwise it opens Fleet's existing wizard.
Fleet validates and publishes its own configuration. Client setup verifies the selected
authenticated daemon API before registering native integrations. It acquires
only selected integration packages and their actual client dependencies. It does
not administer daemon state or invoke Docker. Codex and Claude Code include the local stdio MCP server as a dependency. Exact npm client
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
issued token; a different server instance is refused without changing the default. A verified
new gateway address for the same instance updates the shared profile for new clients. Invalid
server access is rejected before import. An acquisition or component failure
reports incomplete setup and keeps the saved configuration for retry. Selected
native integrations whose executable is unavailable are incomplete, not installed.
Source repositories or registry access remain prerequisites when packages still
need to be acquired; they are not runtime configuration dependencies.

Interactive no-argument installation asks for package/Docker server mode, a
prepared client profile, or `client`. Client setup offers the saved server when
present. On first setup it asks for the server HTTP endpoint, issued-token file,
source manifest and integration choices, obtains the instance UUID from
`/.well-known/ours` at the gateway, displays it, then checks authenticated daemon API access before
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
ours-install server update --mode docker --state-dir /path/to/installation --identity-name "Your Name" --compatible
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

### Retrying a Docker installation after a source-policy permission failure

Setup verifies the selected Docker image before reusing it, including when the image
already exists. If an older installer left a root-owned, mode-0600
`/opt/ours/sources.json`, setup repairs only that image file's permissions and
continues. The selected package bytes, build provenance, image execution settings,
credentials and stored data are retained. The old materialized Dockerfile's known
COPY instruction is also corrected for future builds. No manual image or volume
deletion is required; repeat the original setup with the updated installer.

The repair runs isolated verification containers without state mounts or network
access. Other image verification failures stop setup without replacing the image.
An interrupted repair can be retried, including after the image tag was replaced.

### Remote clients over HTTPS

A client may select an `https://` origin backed by a TLS reverse proxy. Keep the
daemon listener private and configure the proxy separately with a certificate
trusted by the client and matching the hostname. Node uses its normal trust
store; a private CA may be supplied through `NODE_EXTRA_CA_CERTS` before starting
the client. Certificate verification must remain enabled.

The existing issued client credential works over either transport; changing the
URL scheme does not require a new credential. Keep the server's master on the
server. Forward `x-ours-api-token` and the `x-ours-*` session headers unchanged,
and support streamed request/response bodies and long polling. Client requests
refuse redirects, including HTTPS-to-HTTP redirects: configure the final HTTPS
origin directly. UUID/capability checks still precede credential-bearing calls.

This adds client HTTPS support, not an HTTPS daemon listener, certificate
provisioning or automatic reverse-proxy configuration. Existing local HTTP and
SSH-tunnel profiles continue to work.

## One-URL Docker gateway

New Docker installations use one loopback-published nginx port (default 3050).
Clients import one `serverUrl`; their daemon endpoint is `<serverUrl>/daemon` and
Fleet derives `<serverUrl>/cowork/management/rpc`. Cowork, Messenger and Telegram
backend ports are internal only. Existing installations retain their prior layout
on ordinary install/update. Select compatible releases before explicitly migrating:

```sh
ours-install server gateway-enable --state-dir /private/ours
```

Migration checks the installed Cowork, Messenger and Telegram capabilities before
stopping services, verifies authenticated daemon and read-only Cowork management,
and preserves the existing credential and client integration settings. Failure
restores routing, client profile and prior service selection. An interrupted
migration blocks other mutations: repeat `gateway-enable` to finish rollback,
then run it again to attempt migration. The private `gateway-transition.json`
retains recovery state until rollback or migration completes. Back up the whole
installation using the normal server backup procedure before maintenance.

For a nested external URL, pass `--server-url https://ours.example/base` during
Docker install or `gateway-enable`. This sets browser origin and path configuration;
it does **not** publish a public listener, provide TLS, or install external
credentials. Configure the authenticated entry first and retain the `/base` path
when proxying. A compatible release must contain these capabilities:
`cowork.http-management-v1`, `messenger.gateway-prefix-v1`, and
`telegram.gateway-listener-v1`. Older releases are rejected without enabling the
new listener; no package version is silently substituted.

### Notifications

When the selected release includes `@ours.network/notifications`, gateway
installations run it inside the Messenger container, under one supervisor with
Messenger: a signal stops both, and either one exiting stops the container so
its normal restart recovers both. It publishes no host port. The gateway routes
`<serverUrl>/notifications/` to it after the same daemon credential check as
Telegram, and the service's adapter checks that credential again before acting
as the installation owner. Browser cookies, origins and fetch metadata are
removed. Messenger produces message notifications over loopback.

`prepare` creates the private configuration once in
`storage/state/notifications/config.json`: the owner token, separate Fleet and
Messenger producer tokens, and VAPID keys. Later runs only validate it; rotating
the owner token or VAPID keys would orphan every browser subscription, so a
differing configuration is refused rather than rewritten. Back it up with the
rest of the server state. A local client setup binds the Fleet producer token
to this server in `~/.ours-client/notifications-producer.json`; Fleet then sends
agent completions through `<serverUrl>/notifications/`. Remote clients and
native installations do not produce notifications. The gateway discovery
document is unchanged, so existing clients keep accepting the server. A
retained source policy without the package keeps working without notifications.

An existing complete installation gains them with its normal update, which
prepares the credentials after activating the new runtime and hands the Fleet
producer credential to the local client, then a web-only Fleet restart (agents
keep running):

```sh
ours-install all update --mode docker --state-dir /private/ours --identity-name "Your Name" --integrations codex,fleet --fleet-settings /private/fleet.json --compatible
ours-fleet web restart
```

### Authenticated external entry

Messenger has no application authentication. Loopback access trusts local users;
never forward this gateway publicly without authentication. All applications on
this origin share one trust boundary: scripts or XSS in any application can make
requests to the others. Cowork's entered server credential grants operator room
administration and stays in memory until reload. Path prefixes do not isolate
applications. Only expose this origin to trusted operators.

A supported external entry is nginx TLS plus HTTP Basic authentication for browser
paths, with machine paths left to their existing server-token checks. Create the
password file using an interactive `htpasswd` prompt and make it readable by the
proxy worker. Use real certificates and the matching `--server-url`. The inner
gateway remains bound to `127.0.0.1:3050`; neither backend ports nor the inner
listener should be externally forwarded. Example for `/base`:

```nginx
# In http {}:
map $http_upgrade $ours_connection { default upgrade; '' close; }
server {
    listen 443 ssl;
    server_name ours.example;
    ssl_certificate /private/tls/fullchain.pem;
    ssl_certificate_key /private/tls/key.pem;
    auth_basic "ours operators";
    auth_basic_user_file /private/ours-users;
    access_log off;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $ours_connection;
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
    proxy_buffering off;
    location = /base/.well-known/ours { auth_basic off; proxy_pass http://127.0.0.1:3050; }
    location /base/daemon/ { auth_basic off; proxy_pass http://127.0.0.1:3050; }
    location = /base/cowork/management/rpc { auth_basic off; proxy_pass http://127.0.0.1:3050; }
    location /base/tg-connector/ { auth_basic off; proxy_pass http://127.0.0.1:3050; }
    location /base/ { proxy_pass http://127.0.0.1:3050; }
    location / { return 404; }
}
```

Browser requests include same-origin proxy credentials. Fleet/SDK use the issued
`X-Ours-Api-Token`, require no browser login, and reject redirects. An SSH tunnel
to the loopback gateway is another private transport option, but every client must
establish its own tunnel and use a URL/origin matching that tunnel; it is not
automatic remote access. Do not treat a token entered in Cowork as Messenger auth.

Publish compatible Cowork, Messenger, Telegram and Fleet artifacts before enabling
gateway defaults in a qualified installer release. Gateway client setup acquires
and checks Fleet before activating the managed profile or publishing native
commands. Migration also checks the installed `ours-fleet version --json`
capability before stopping services when the selected managed profile includes
Fleet. Upgrade that executable first. The gate does not inventory differently pinned
running Fleet instances or remote clients: upgrade every client using this server
to a compatible Fleet release before cutover.

### Cross-repository gateway qualification

Build Cowork, Fleet, Messenger and Telegram checkouts with their locked dependencies.
The real-service test uses disposable local daemon state, a local test broker,
nginx Docker containers and Chromium; it never uses installed identities or tokens.
It requires Linux Docker host networking and `openssl`. Set:

```sh
OURS_TEST_GATEWAY_SERVICES=1 \
OURS_TEST_COWORK_ROOT=/checkouts/ours-cowork \
OURS_TEST_FLEET_ROOT=/checkouts/ours-fleet \
OURS_TEST_MESSENGER_ROOT=/checkouts/ours-messenger-server \
OURS_TEST_TELEGRAM_ROOT=/checkouts/ours-tg-connector \
OURS_TEST_BROWSER=/opt/google/chrome/chrome \
node --test packages/installer/test/gateway-services.test.mjs
```

Run `OURS_TEST_DOCKER=1 node --test packages/installer/test/gateway-docker.test.mjs`
separately for Compose port isolation with a client container. That routing test
uses echo upstreams; the real-service test covers Fleet room operations, browser
paths, external authentication and Messenger WebSocket access. Neither test is
cross-platform Docker Desktop qualification or a live deployment test.

### Rootless Podman (qualification in progress)

Container installations can select a local Linux rootless backend explicitly:

```sh
export PODMAN_COMPOSE_PROVIDER=/absolute/path/to/docker-compose
ours-install server install --mode docker --container-engine podman \
  --state-dir "$HOME/.ours-server-podman" --identity-name "Your Name"
```

`mode: docker` remains the legacy container-layout name. `containerEngine` and
`containerBinding` retain Podman, the invoking UID, native storage paths, socket
and standalone Compose provider, plus the UID/GID mapping fingerprint. Records without `containerEngine` continue to
use Docker. Package/client installs reject the engine option. Existing records
cannot change engines through a flag or ambient connection change; automatic
Docker-to-Podman data migration is not provided. Legacy local-daemon migration
(`--migrate-from`) to Podman is also unsupported and is refused before source
shutdown or managed CLI publication, including migration retries. Use a fresh
Podman installation, or migrate the legacy daemon with Docker/packages.

Podman uses its native build command, with the same resolved Compose build
context, target, architecture, arguments and secret references, followed by
Compose `--no-build` startup. It does not require the Docker CLI or daemon.
The selected standalone Docker Compose provider must be version 2.35 or newer;
version checks do not replace the behavioral capability probe. `podman-compose`
is not an interchangeable provider for this implementation. Secrets sourced
from environment variables use Podman's native build-secret mechanism, never
build arguments or temporary copies.

Prerequisites include a working rootless API socket, sufficient subordinate
UID/GID mappings, and native volume-subpath isolation. Before setup/start, an
isolated disposable project tests Compose `!reset`, health waiting, JSON status,
service DNS, private UID-1000 storage and subpath isolation. A failed check stops
installation rather than substituting the whole volume. Existing volumes must
have this installation's project and volume labels. Docker contexts, unrelated
containers and host directory ownership are not changed.

Server boot recovery requires an enabled user `podman.socket`, an enabled
`podman-restart.service` using `--filter should-start-on-boot=true`, and user
linger. The standard user-service environment/default socket must select the
same storage; custom XDG paths and sockets are rejected for server startup.
The installer diagnoses missing prerequisites and never runs hidden sudo or
rewrites the vendor unit. Long-running Podman services get `unless-stopped`;
administration jobs do not. Stop/status remain available when boot prerequisites
are missing, provided the retained backend is accessible. Runtime-only test
harnesses may select a separate local socket with `OURS_PODMAN_SOCKET`; its
storage must match native Podman and the selection cannot change afterward.

Gateway images read and validate IPv4/IPv6 nameservers from their container at
startup. Only the resolver placeholder is replaced; nginx variables and existing
authentication/routes remain intact. UID 101, read-only rootfs, dropped
capabilities and tmpfs are retained. Setup and start verify authenticated
upstream requests in addition to liveness.

This change is **not yet a fully qualified server-support release**. Debian's
Podman 5.4.2 with Compose 5.5.1 failed subpath isolation and has incompatible boot
recovery semantics. Podman 6.1.2 passed the isolated capability probe on native
Linux amd64; production and prerelease-source builds, service lifecycle, rebuild and scoped maintenance also passed. See [validation evidence](ROOTLESS_PODMAN_VALIDATION.md). The full public installer/maintenance matrix,
SELinux Enforcing, logout/reboot, explicit-stop recovery, and Docker regression
matrix must all be recorded before declaring a supported engine/provider pair.
The supplied ARM VM results are historical feasibility evidence, not this
release's qualification.

Opt-in gateway fixture (isolated project, only owned resources removed):

```sh
OURS_TEST_DOCKER=1 node --test test/gateway-docker.test.mjs
PODMAN_COMPOSE_PROVIDER=/absolute/path/to/docker-compose \
  OURS_TEST_PODMAN=1 node --test test/gateway-docker.test.mjs
```

## Account workspace enrollment (task build)

The unmerged account onboarding feature requires matching reviewed installer,
Fleet and Messenger task builds. Do not advertise it as available in `@latest`.
Use an owned private directory and a 0600 downloaded payload:

```sh
node /absolute/task-ours-network/packages/installer/install.mjs \
  --setup-workspace-file /absolute/private/workspace.payload \
  --workspace-fleet-bin /absolute/task-ours-fleet/dist/cli.js \
  --sources /absolute/private/task-sources.json
```

The wrapper defaults fresh hosts to the full Docker stack and retains existing
Human roots through the installed SDK with exact instance/private credential
selection. For an existing supported gateway add `--scope client --config` with
its private profile. It clears competing inherited daemon selectors before Fleet
initialization and enrollment; it never copies a browser device bearer to the
account server. A private stdin payload is also accepted by `--setup-workspace -`.
Encoding is not encryption; command arguments can enter history/process listings.
Cloudflare management tokens are forbidden in these payloads.

Docker and `cloudflared` are required for the fresh workflow. Supply a complete
`--fleet-settings` JSON for noninteractive Fleet initialization, or answer its
terminal prompts. Dry-run never initializes or enrolls Fleet. Read the matching
ours-app `server/DEPLOYMENT.md` for exact task source-policy generation, external
Google/Cloudflare prerequisites and account-server setup. On uncertain enrollment
check account status before requesting a new payload; do not reset identities or
replay a consumed invitation.

Workspace setup accepts exactly https://app.ours.network and the controlled test
account origin https://app.ours-tunnel.com. To move an existing same workspace to
the other origin, obtain a fresh payload from the moved account server and add
`--workspace-migrate-app-origin`. Fleet verifies the signed binding receipt before
changing local origin trust, preserves identities/config/device records, and
restarts the runtime. An implicit origin change is rejected. Browser account
cookies/device IndexedDB must be linked anew on the new origin. See the app
server/DEPLOYMENT.md switching procedure.

Workspace setup automatically reuses the saved managed gateway profile (or explicit `--config`/`OURS_CONFIG`), including a host with a non-default server state directory. It does not reinstall server/client state, create a root, or initialize an existing Fleet configuration. It requires Fleet capability `workspace.enroll.preserve-profile-v1` and passes `--preserve-profile`; Fleet requires the matching Messenger capability before posting signed enrollment. Hosts running older Messenger must first update that host service through its supported installer lifecycle; this wrapper never guesses or replaces its server directory. After Owner releases Messenger/Fleet/installer, app bootstrap pins must be updated before removing the preview guard.

### Private-context Docker script permissions

Fresh image builds explicitly make non-secret maintenance/runtime scripts readable by the container user even when the host build context was copied under umask077. Host scripts, selected source policy and state retain their private permissions.

For a pending installation using an older image, run the corrected installer against the same pending workspace. It recognizes older shipped script COPY instructions combined with private host script modes, updates those image COPY modes and rebuilds the daemon image from the retained source selection. It leaves host data and enrollment state intact and qualifies the rebuilt image before preparing services. A private retry marker retains the rebuild requirement after interruption; it is removed only after verification succeeds. This rebuild resolves third-party transitive dependencies using the existing testing-delivery rules; selected Ours versions and integrity remain release-checked. It is not a byte-identical image permission-layer repair.

Fresh server setup checks its loopback daemon, Cowork and Messenger ports before
writing the installation configuration. Occupied implicit defaults advance to a
free port, skipping reserved sibling ports; the selected values are saved in the
installation record and used by native/container services, gateway and client
profile generation. An explicitly requested occupied port fails with a diagnostic.
Existing installation records keep their ports and identities. A listener acquired
by another process after preflight still causes startup to fail safely; no foreign
process is stopped and no retained installation is silently moved.

Workspace setup pins Fleet `1.2.0-nightly.51` with its recorded registry integrity. This release includes first-time Fleet setup through the host API for the account App, direct App access to the workspace services with the device credential, v2 positional one-use grants and automatic QR/connection-code output from `ours-fleet setup-tunnel`, optional private file/stdin inputs for legacy v1 payloads, a separate `ours-fleet link-device` command for additional devices, host prerequisite checks before the one-time workspace proof (`setup-tunnel --check`), `setup-tunnel --resume` to finish a setup that stopped after the host saved its private pending setup record (not when the proof's answer was lost, or after the setup window expired with an unconfirmed non-default port), and persists the available Fleet loopback port used by the workspace tunnel. It also accepts a setup-generated configuration left behind after the host enrollment state was removed, runs the host Codex when it is at least as new as the packaged one, offers only the Codex models the signed-in account can use, and removes the temporary setup contact after confirmation. Fleet serves no pages and opens no browser: every screen is in the App. Fleet also serves the workspace notification routes, produces notifications through the server gateway with the imported producer credential, accepts the App's device credential on the notification presence socket so an open App receives no push, and defaults agent wakes to `monitor.interrupt: after_tool` (Hermes: no interrupt; role snapshots saved before this default keep no interrupt). Existing installation identities and configured ports remain retained; a retained-port collision fails safely.

### App tunnel setup prerelease sequencing

The simplified App flow shows one copyable `ours-fleet setup-tunnel <encoded-v2-grant>`
command for the installed host, including an SSH session on a VPS. Its argument
contains only the existing v2 single-use grant (`version`, `appOrigin`, `code`,
`expiresAt`), never a connector token or broad provider credential. The command can
appear in shell history and process listings: keep it private and remove it from
history after use. Base64 is encoding, not encryption. Server-side expiry and
one-time redemption remain enforced. Fleet checks prerequisites before HTTPS POST
redemption; it never prints the grant or puts it in a URL, and retains existing
signed-root binding and scoped connector token-file controls. It prints the QR and
connection code automatically; the App checks readiness and opens the code field.
Private `--file`/`--stdin` transports remain optional and are the only transports
for legacy v1 payloads with long-lived credentials.

The nightly installer release manifest selects published Fleet `1.2.0-nightly.51`
and its actual registry integrity through the normal release manifest/source-policy
generators. This release includes v2 argument and private-input support. The former
nightly.41 selection predates this capability. Merge and publish the repinned
installer before deploying the App; the pin change alone is not an installer
publication. Existing v1 private-file enrollment remains compatible. The legacy
App wrapper refuses an older Fleet before reading or redeeming its grant.

The notification gateway permits daemon-authenticated producer selection only on
POST `/api/v1/send` and `/api/v1/delete-target`. The latter retires a removed
conversation using the credential's fixed user/source scope. Browser inbox
`/api/v1/delete` continues to require the user credential. The notification
service must support the scoped lifecycle route; this change does not repin or
publish an installer release.

## Boot and failure recovery

Docker long-running daemon, Telegram, Cowork, Messenger/Notifications and gateway
containers use `unless-stopped`. They resume when the selected Docker Engine
starts, and Docker restarts a failed container with its built-in backoff. A manual
`docker stop`, `ours-install server stop`, or uninstall stays stopped across
Engine restarts. Administrative/maintenance jobs have no automatic restart.
Docker health status alone does not restart a container.

The four application containers also supervise their locked entrypoints. After
90 seconds of startup grace, probes run every 5 seconds with a 15-second timeout.
Three consecutive local health failures or a child exit stop its entire process
group (TERM, then KILL within 20 seconds) before restarting. Each container start
allows three automatic child recovery attempts. Exhaustion leaves the container
running but unhealthy, with its children stopped and a diagnostic in its logs.
Correct the cause and use `ours-install server restart --state-dir PATH` to
reset that circuit; `server start` alone does not reset a running circuit holder.
Consumers wait for authenticated readiness of their pinned daemon instance and
do not spend their recovery budget on a daemon outage. The gateway uses Docker
process recovery only; a gateway hang requires operator restart.

Re-run `server install` to deliver recovery to an existing installation without
changing its retained exact packages, identity, credentials, volumes or config.
This explicit install starts its selected services, as before. `server update`
with reviewed storage compatibility delivers the new selected release and
restores only previously running services. Retained runtime scripts are refreshed
and rebuilt on install; an interrupted refresh retains a rebuild marker. The
restart policy overlay also covers retained Compose files. Reconciliation updates
only this project's recorded long-running containers and does not start or
recreate a deliberately stopped container. `server start` can reconcile policies
but does not retrofit health supervision into an old image: run install/update.
Backup, migration and update still stop writers before maintenance, and a failed
maintenance operation keeps them stopped. `server uninstall` (also `ours-uninstall --state-dir PATH` for a managed
schema-2 installation) stops and removes managed services, retaining volumes,
identity and credentials. It refuses unfinished transitions and data purge.
Recovery introduces no host watchdog or service.

Host boot is a separate prerequisite. On Linux, enable the selected Docker
Engine system service; rootless Docker additionally needs its user service and
user linger. The installer reports read-only boot diagnostics and does not enable
or restart host services. A reachable remote Engine or Docker Desktop context
cannot prove boot recovery on this machine. On macOS/Windows with WSL, enable Docker
Desktop startup at sign-in; this does not provide pre-login startup. Rootless
Podman's existing enabled socket/restart-service and linger preflight remains.
Native package mode retains its package-owned systemd user/launchd services:
Linux needs user linger for pre-login startup, macOS needs a GUI login session,
and native hung-process recovery is not supplied by this Docker supervisor.
Fleet stays on the host with Fleet-owned lifecycle and crash protection. Installing
the exact Fleet nightly binary does not upgrade or restart an existing supervisor.
The published no-policy core delivery is a verified recovery omission that
reproduces the reported symptom. The original incident cause remains unconfirmed:
actual host Engine availability, installed policies and pre-reboot stopped state
still require Owner confirmation.
