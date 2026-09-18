#!/usr/bin/env bash
# ours.network — uninstaller bootstrap. The symmetric partner to install.sh. Run from a clone:
#
#     bash packages/installer/uninstall.sh
#
# (or piped: curl -fsSL https://raw.githubusercontent.com/adapt-toolkit/ours-mcp/main/packages/installer/uninstall.sh | bash)
#
# Like install.sh this is a THIN bootstrap: it checks Node.js is present (friendly per-OS guidance
# if not), then hands off to the Node uninstaller (uninstall.mjs) — banner + colours + a clear
# explanation of what will be removed. It removes ONLY what the ours installers created; the two
# destructive items (data dir, daemon) require an explicit typed 'yes'.
#
# Non-interactive env overrides (all optional) — consumed by the Node uninstaller. Setting ANY of
# the OURS_UNINSTALL* variables makes the run non-interactive; setting none leaves it unchanged.
# Four documented variables describe things this uninstaller cannot do, and it REFUSES (exit 2,
# nothing removed) rather than ignoring them — see the table in README.md. Full list there.
#   OURS_UNINSTALL="hermes codex"   which harness plugins to remove (space/comma; names, "all", "none")
#   OURS_UNINSTALL_DAEMON=yes       also stop + remove the daemon + its service + the global packages.
#                                   Unset (or any other value) removes ONLY the plugins named above
#                                   and leaves the daemon running.
#   OURS_UNINSTALL_TELEGRAM=detach  detach the Telegram connector from this daemon (same for
#   OURS_UNINSTALL_ROOMS=detach     Rooms). Without it, a run a connector still points at refuses.
#   OURS_UNINSTALL_DATA=yes         REFUSED. State is never deleted unattended — it holds identity
#                                   private keys. Use 'ours-uninstall --state-dir <dir> --purge'
#                                   from a terminal and type the full path.
#   OURS_ASSUME_YES=1               accept defaults; skip the typed confirmations (implies no tty)
#   OURS_NPM="npm"                  npm binary to use
#   OURS_CONFIG=/path/profile.json  remove selected client attachments for this prepared host
#                                  profile; its shared credential and Compose daemon are retained
#   OURS_UNINSTALLER_MJS / OURS_INSTALLER_BASE   run/fetch overrides (dev/testing)
set -euo pipefail

say(){ printf 'ours: %s\n' "$1"; }

# --- 1) Node.js check + friendly guidance ------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  os="$(uname -s 2>/dev/null || echo unknown)"
  printf '\n'
  say "ours needs Node.js (version 20 or newer) to run its uninstaller — it isn't installed."
  case "$os" in
    Darwin) say "  • macOS (Homebrew):  brew install node   (or nvm: https://github.com/nvm-sh/nvm)";;
    Linux)  say "  • Linux:             https://github.com/nodesource/distributions   (or nvm)";;
    *)      say "  • Windows/WSL:       install Node.js in WSL, or from https://nodejs.org";;
  esac
  say "  • Any OS: https://nodejs.org — then re-run this command."
  printf '\n'
  exit 0
fi

# --- 2) locate the Node uninstaller ------------------------------------------------------------
MJS=""
if [ -n "${OURS_UNINSTALLER_MJS:-}" ] && [ -f "${OURS_UNINSTALLER_MJS}" ]; then
  MJS="${OURS_UNINSTALLER_MJS}"
else
  SELF="${BASH_SOURCE[0]:-$0}"
  DIR="$(cd "$(dirname "$SELF")" 2>/dev/null && pwd || true)"
  if [ -n "$DIR" ] && [ -f "$DIR/uninstall.mjs" ]; then MJS="$DIR/uninstall.mjs"; fi
fi

CLEANUP=""
if [ -z "$MJS" ]; then
  BASE="${OURS_INSTALLER_BASE:-https://raw.githubusercontent.com/adapt-toolkit/ours-mcp/main/packages/installer}"
  fetch(){ if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }
  TMP="$(mktemp -d)"; CLEANUP="$TMP"
  mkdir -p "$TMP/lib"
  say "fetching the ours uninstaller…"
  for f in uninstall.mjs lib/ui.mjs lib/logic.mjs lib/prompt.mjs; do
    if ! fetch "$BASE/$f" > "$TMP/$f" 2>/dev/null; then
      say "could not download the uninstaller ($BASE/$f). Check your connection and retry."
      rm -rf "${TMP:?}"; exit 1
    fi
  done
  MJS="$TMP/uninstall.mjs"
fi

# --- 3) run the Node uninstaller ---------------------------------------------------------------
set +e
node "$MJS"
rc=$?
set -e
[ -n "$CLEANUP" ] && rm -rf "${CLEANUP:?}"
exit "$rc"
