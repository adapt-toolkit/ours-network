# Set up Ours with one client connection

Fleet, the `ours` CLI and MCP clients share `~/.ours-client/profile.json`.
Set the server address once. The address is the HTTP gateway: clients append
`/daemon`, `/cowork`, `/messenger` or `/tg-connector` as needed. They do not
connect to server Unix sockets, discover server state directories, or try port
3050 after a connection failure. Fleet's local supervisor/harness sockets still
control local processes; they do not carry server management requests.

## Release availability

These instructions describe the coordinated gateway-only source changes. They
are not a claim that the current npm `nightly` already contains them. Consumer
PRs remain blocked from merge until reviewed SDK, CLI, MCP and Fleet releases
are selected with matching lockfiles and installer release checksums. For source
review, use the exact-revision integration recipe linked from those PRs.
Run the installation commands below only with that coordinated installer release.

## Fresh full-stack setup on localhost:4050

For an agent asked to “put the daemon on localhost port 4050”, use **4050 as the
public gateway port**. The daemon's internal container port stays 3050. Docker
publishes only the gateway. Run as the user who will run Fleet and the harnesses.
Use Node.js 22+ and a working Docker Compose installation.

```sh
npm install -g @ours.network/install@nightly
ours-install all install --mode docker \
  --state-dir "$HOME/ours-server" --identity-name "Your Name" \
  --port 4050 --integrations codex,claude-code
```

The installer starts the server, retains or creates its Human identity, issues a
separate client credential, and imports the connection into `~/.ours-client`.
For Fleet, add `fleet` to `--integrations` and provide
`--fleet-settings /absolute/path/fleet-settings.json`; see the Fleet settings
example in [assets/fleet-settings.example.json](assets/fleet-settings.example.json).
The example selects Codex for all three jobs; review its model and subscription
against the installed Fleet catalog before use. The installer prepares Fleet but leaves it
stopped for review. Use `--dry-run` first to inspect a complete preset.

Do not set `OURS_PORT=4050` in a client shell, Fleet role, or user service. The
single profile contains `serverUrl: "http://127.0.0.1:4050"`, with daemon requests
at `http://127.0.0.1:4050/daemon` and Cowork management at
`http://127.0.0.1:4050/cowork/management/rpc`.

## Existing or remote server

An older Docker installation needs its gateway enabled on the **server host**:

```sh
ours-install server gateway-enable --state-dir "$HOME/ours-server"
```

This is a server migration that may restart its services; perform it in an
approved maintenance window. Do not change identities or reinstall a populated
server to change a client address. `--port` on an existing installation cannot
silently move the retained public port.

For a remote host, expose the gateway through an authenticated HTTPS entrypoint
and select that URL when installing the server, for example
`--server-url https://ours.example.net/base`. The reverse proxy must preserve the
base prefix, streaming responses and WebSocket upgrades. Do not expose the
individual service ports.

Obtain an issued credential using `ours-install server access-issue --state-dir
/absolute/server/root --output /private/credential` on the server. Transfer it
privately to the client user. Never print the credential or put it into command
arguments, source control, chat, or a service unit. Use a private directory
(mode 0700) and credential/profile files (mode 0600).

Prepare a client profile (the UUID must be the selected server's actual instance):

```json
{
  "serverUrl": "https://ours.example.net/base",
  "endpoint": "https://ours.example.net/base/daemon",
  "expectedInstanceId": "11111111-2222-3333-4444-555555555555",
  "credentialPath": "/absolute/private/credential"
}
```

`endpoint` is optional for the client resolver; when present it must exactly match
`serverUrl + "/daemon"` after trailing-slash normalization. Older endpoint-only
profiles must be migrated explicitly: supply the actual gateway URL, not a
guessed address derived from a direct daemon port.

```sh
ours-install client --config /absolute/private/profile.json \
  --integrations codex,claude-code
```

This imports the profile and issued credential into `~/.ours-client`. All new
clients use that default without an environment export. A conflicting existing
server instance is refused and retained; do not delete it to bypass that check.
To change only the gateway address of the same server, prepare a private profile
with the new `serverUrl` and matching `/daemon` endpoint, keep its actual
`expectedInstanceId`, and run the same `ours-install client --config ...` command.
The installer validates authenticated access before importing the new address;
it preserves imported Fleet settings. New processes use the new address. A
failed verification leaves the old selection intact. A different server UUID
requires a separately planned migration, not an address edit.

Changing the retained Docker public listening port in place is not currently
supported. `--port 4050` above is for a fresh server. For an existing server,
configure an administered reverse proxy to its gateway at the desired address,
then use the same-instance client address procedure. Do not edit installation
state or recreate containers with new identities to work around this limitation.
Native server installations currently need a separately administered gateway;
the integrated gateway setup above uses Docker (or supported Podman Compose).

## Fleet and systemd

For a new Fleet setup, save the linked JSON example as an absolute private file
and run as the same user after importing the client profile:

```sh
ours-fleet init --settings /absolute/path/fleet-settings.json
```

If the installer already imported Fleet settings, reuse them explicitly:

```sh
ours-fleet init --settings "$HOME/.ours-client/fleet-settings.json"
```

These commands work without a terminal. A bare `ours-fleet init` is interactive.
The installer also accepts `--fleet-settings /absolute/path/fleet-settings.json`
and passes it to this same noninteractive path. Generated systemd and launchd services persist only the common
profile path, not a service URL, port, or token. Lingering user services therefore
use the same selection as CLI and MCP after logout/reboot. Detached Fleet task
workers inherit the common profile and do not inherit legacy service selectors.

`OURS_CONFIG` is an explicit override for the **whole client profile**. Use it only
when all relevant clients intentionally share that same alternate file. It is
not a per-service address override. For the normal setup, leave it unset.

When migrating existing units, inspect `systemctl --user cat 'ours-fleet-agent@.service'`
and any per-role drop-ins. Remove stale `OURS_PORT`, `OURS_STATE_DIR`,
`OURS_API_TOKEN`, `OURS_DAEMON_ID` and Cowork-local overrides from their owning
configuration. Regenerate Fleet units with `ours-fleet init --settings /absolute/path/fleet-settings.json`
in the intended profile environment, then restart affected client roles only after approval.
Already-running clients retain their current connection until restarted; editing
a profile does not rebind running identities. Do not restart the server for a
client-only profile correction.

## Verify and diagnose

```sh
curl --fail http://127.0.0.1:4050/.well-known/ours
ours config show --json
ours identity list --json
ours-fleet doctor
ours-fleet room list
```

Discovery must advertise the gateway and expected instance. `ours config show`
shows only connection metadata and a credential path, never the token. For a
remote server use its exact prefix in the discovery URL. Test both daemon
identity access and Cowork room listing: one succeeding does not prove the other.
Check `command -v ours-mcp` and `ours-mcp version` as well as the MCP binary launched
by the harness; Fleet can bundle a different MCP version than the global binary.

Missing/unsafe profiles, mismatched instances, rejected credentials, HTTP errors
and timeouts fail on the selected gateway. Fix that selection or service; do not
add localhost/socket fallbacks. If a task reports `room_probe_unavailable`, check
Cowork through the gateway. `control_unavailable` means Fleet could not query its
local role supervisor after its room checks; inspect the role's supervisor and
control channel separately. An active room alone does not establish agent readiness.
