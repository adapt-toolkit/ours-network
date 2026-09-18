// Public setup and maintenance commands.
export const USAGE = `ours-install — interactive setup or complete CLI presets.

  ours-install
    Opens the console form. Choose all (server + clients), server, or client;
    runtime, installation directory, identity, integrations and Fleet settings.
    Linux x64 recommends native; macOS/Windows recommend Docker. Windows uses WSL.

  Full stack, with every required answer preset (no prompts):
    ours-install --mode docker --state-dir /private/ours --identity-name "Your Name" --integrations codex,fleet --fleet-settings /private/fleet.json

  Server preset (native is an alias for packages):
    ours-install server --mode native --state-dir /private/ours --identity-name "Your Name"
    ours-install server install --mode docker --state-dir /private/ours --identity-name "Your Name"

  Client preset for an existing server:
    ours-install client --config /private/profile.json --integrations codex,fleet --fleet-settings /private/fleet.json

  Update a retained installation, preserving its identities:
    ours-install all update --mode docker --state-dir /private/ours --identity-name "Your Name" --integrations codex,fleet --fleet-settings /private/fleet.json --compatible

  --scope all|server|client   preset which parts to configure (default all)
  --action install|update    equivalent to the positional operation
  --mode docker|native      packages is also accepted for native mode
  --state-dir PATH          installation root; required for all/server
  --identity-name NAME      desired Human name for a fresh server; existing root is retained
  --integrations LIST       codex,claude-code,fleet; use none to skip clients explicitly
  --fleet-settings PATH     JSON settings for Fleet; mandatory for CLI presets selecting Fleet
  --config PATH             complete connection profile for client-only setup
  --sources PATH            explicit full development source policy override
  --port N                  daemon port (default 3050 on a fresh installation)
  --cowork-port N           cowork port (default 3052)
  --messenger-port N        messenger port (default 8420)
  --compatible              required for server updates and legacy state migration
  --migrate-from CONFIG     migrate an existing daemon into a new managed root; install only
                           requires an absolute config path and --compatible
  --migrate                 explicit legacy credential migration; separate from --migrate-from
  --dry-run                 show the validated plan without changing anything
  --help, -h                show help
  --version, -V             print installer version

CLI presets must be complete and never open the interactive form or a Fleet wizard.
Missing answers are reported before installation. Both input modes run the same
installer with preparation, identity restoration, update and readiness progress.
Fleet is configured but left stopped for operator review.

Scoped maintenance:
  ours-install server status|start|stop|restart|rebuild --state-dir PATH
  ours-install server access-issue --state-dir PATH --output PATH
  ours-install server access-replace --state-dir PATH --confirm
  ours-install server backup|restore server|daemon|telegram|cowork|messenger LABEL --state-dir PATH
  ours-install server reset daemon|telegram|cowork|messenger --state-dir PATH --confirm

Install the selected channel with npm install -g @ours.network/install@nightly
(or @latest for a qualified stable release). Component versions come from the
installer's embedded release manifest. Node.js 22+ is required.
`;

export const UNINSTALL_USAGE = `ours-uninstall — remove one ours daemon and what attaches to it.

  ours-uninstall [--state-dir PATH] [--purge] [--dry-run] [--help] [--version]

Removes the boot service, stops the daemon, and removes the global packages —
but ONLY when no other daemon on this machine still needs them. A component
still pointing at this daemon stops the run before anything is removed, so a
run that refuses leaves the daemon whole rather than half-dismantled.

  --state-dir  which daemon to remove (default ~/.ours). A daemon IS its state
               directory, so this is the only thing that names one.
  --purge      also delete the state directory itself. Never the default, never
               done non-interactively, and it asks you to type the full path —
               identity keys exist nowhere else and no peer can give them back.
  --dry-run    print what it WOULD remove and remove nothing
  --help       show this help and exit
  --version    print the version and exit

When OURS_CONFIG selects a prepared host profile, remove selected client
attachments only. The shared profile/credential and Compose daemon are kept,
including under --purge.`;
