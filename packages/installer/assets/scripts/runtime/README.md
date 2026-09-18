# Startup and readiness

Inputs: Compose variables and named volumes, protected credentials and existing
settings. Outputs: prepared paths/profiles, running processes and readiness exit
codes. Compose makes normal calls; no separate manual setup scripts are required.

| Files | Caller and purpose |
|---|---|
| `client-setup.mjs` | installer preparation: directories, configuration, issued credentials, MCP profile and protected Telegram input; does not create identities |
| `entrypoint.sh`, `start-*.sh` | Compose services: lock the data directory and start the application; the Telegram package applies optional provisioning before readiness |
| `check-start.mjs`, `check-client.mjs` | Launchers: check access/credentials and essential settings before startup |
| `runtime-common.mjs` | Shared check helpers and build-record writing under the state lock |
| `healthcheck.mjs`, `health-*` | Docker healthchecks for daemon, Telegram, Cowork and Messenger readiness; failure returns a nonzero exit code |

The main MCP runs inside Docker. Fleet and ours-codex/ours-claude remain on the
host. Files use the existing transport without host bind mounts.

Main MCP attaches to the daemon on the server and exposes its network transport.
The installer owns preparation and selects the same sibling layout in package
mode. Docker uses one named `server-storage` volume: `state/daemon`, `state/mcp`,
`state/telegram`, `state/cowork`, `state/messenger` and `state/credentials`.
Preparation mounts the storage root; running applications mount only their own
state children and selected credentials. Backups and maintenance staging are
outside `state/`. The owner-lock volume contains transient runtime locks.
