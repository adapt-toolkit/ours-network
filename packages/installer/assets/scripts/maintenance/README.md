# State maintenance

The installer coordinates stopped server components and invokes the same Node.js
maintenance implementation in package and Docker installations. Package mode uses
the installed `ours-install` assets and dependencies. Docker uses a separate
maintenance image with dependencies taken from the installer's `package.json`.

```sh
ours-install server backup server before-change --state-dir /path/to/installation
ours-install server restore server before-change --state-dir /path/to/installation
```

Backup and restore support the full server or an addressed daemon, Telegram,
Cowork or Messenger domain. Daemon archives include MCP preferences. Daemon
restore/reset replaces both trees together and preserves other component data
and current credentials. Addressed reset requires `--confirm`; full-server reset
is not supported. Managed legacy installations convert to the shared layout
through the installer before ordinary startup; plain script calls are not a
substitute for that coordinated conversion.

| File | Responsibility |
|---|---|
| `state-operation.mjs` | Validates the selected state, stages replacements and invokes owning package commands to retain current authority |
| `state-archive.mjs` | Creates, validates and extracts format-1 archives, preserving private permissions and timestamps |
| `state-native.mjs` | Provides the existing OS file-lock and atomic directory operations through Koffi |
| `docker-layout-conversion.mjs` | Stages, validates and publishes the managed legacy Docker state layout under installer coordination |

Archives are stored in `storage/backups`, outside `storage/state` but on the same
storage volume. Removing that volume removes its backups too. Restore creates a
backup before replacing state. Compatibility across arbitrary builds or
instances is not established; `--compatible` records an operator's explicit
compatibility decision. A failed operation leaves affected services stopped.

Maintenance uses the installer's Node.js runtime and npm dependencies. There is
no Python fallback or separate operator shell script.
