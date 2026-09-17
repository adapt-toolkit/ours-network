// ours-install v3 — the help text.
//
// It lives here rather than in the bin because `--help` is a behaviour with a
// contract (the flags it names must be the flags target.mjs accepts), and a bin
// that is three lines long cannot be the place a contract is asserted.

export const USAGE = `ours-install — the unified ours.network stack installer.

  Selected network installation (uses the packaged compatible source policy):
    ours-install server install --mode packages|docker [--sources PATH] --state-dir PATH
    ours-install server status|start|stop|restart --state-dir PATH
    ours-install server rebuild --state-dir PATH
    ours-install server update --state-dir PATH [--sources PATH] --compatible
    ours-install server access-issue --state-dir PATH --output PATH
    ours-install server access-replace --state-dir PATH --confirm
    ours-install server backup|restore server LABEL --state-dir PATH
    ours-install server backup|restore daemon|telegram|cowork|messenger LABEL --state-dir PATH
    ours-install server reset daemon|telegram|cowork|messenger --confirm --state-dir PATH
    ours-install client install --config PATH
  Client profile settings select installer.integrations and may override installer.sourcesPath,
  and optional installer.fleetSettingsPath (relative paths use the profile directory).
  Repeat selected server install repairs setup without replacing existing authority.
  Daemon maintenance includes MCP state. Full-server reset is not supported.
  Update requires reviewed storage compatibility; --compatible records that attestation.
  Existing managed layouts are converted before service startup.


  Install:  npm i -g @ours.network/install && ours-install   (recommended)
            npx @ours.network/install                          (one-off)

  ours-install [--state-dir PATH] [--port N] [--dry-run] [--help] [--version]

Progress-driven setup for the whole stack: one shared daemon, MCP, Telegram,
cowork, detected harness plugins (Claude Code / Codex / Hermes), a Human
identity, and ours-fleet. The daemon, Telegram connector, and cowork shim start
as durable services; only Fleet is staged but stopped. The installer asks only
for information it cannot infer and
ends with exact next commands plus a copy-paste agent hand-off prompt.

  --state-dir  the daemon's STATE DIRECTORY, which is what identifies a daemon
               (default ~/.ours). A second state directory is a second daemon.
  --port       used only when CREATING a daemon. For a daemon that already owns
               the state directory the port comes from its own record, and a
               --port that disagrees with it is refused rather than corrected.
  --dry-run    walk the whole flow and print what it WOULD do — change nothing
  --help       show this help and exit
  --version    print the installer version and exit

Env: OURS_ASSUME_YES=1 (accept defaults, no prompts) · OURS_INSTALL_DRY_RUN=1 ·
     OURS_CONFIG=/private/host-profile.json · OURS_CHANNEL=nightly ·
     OURS_BROKER_URL · OURS_NPM. A complete host profile selects client-only
     setup for an existing Compose-owned daemon. Docs: https://ours.network`;

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
