#!/usr/bin/env bash
# ours.network — unified stack installer bootstrap (the `ours-install` experience).
#
# PREFERRED install is npm (persistent, versioned, integrity-checked command on PATH):
#     npm i -g @ours.network/install && ours-install     # then re-run any time with: ours-install
#     npx @ours.network/install                          # one-off, no global install
#
# This curl|bash bootstrap is the FALLBACK for machines without npm set up (least secure — it
# pipes a script into your shell). It just gets Node.js/npm sorted, then does the same
# `npm i -g @ours.network/install` and runs `ours-install`. Meant to be run as:
#
#     curl -fsSL https://raw.githubusercontent.com/adapt-toolkit/ours-network/main/install.sh | bash
#
# This file is a THIN bootstrap: it checks that Node.js + npm are present (and prints friendly,
# per-OS guidance if not), then runs the real experience — the Node installer (install.mjs) that
# guides the WHOLE stack in ~3 minutes: pre-flight (platform / node / harness alias-safety),
# config-first (broker + port), then four consent-gated steps — ours core (the daemon), the harness
# plugins (Claude Code + Codex), ours-fleet, and the Telegram connector — ending in ONE copy-paste
# hand-off prompt. All the real work lives in the Node installer.
#
# From a CLONE (a sibling install.mjs is present) it runs that directly. Piped as `curl … | bash`
# it installs the published command globally — `npm i -g @ours.network/install` — then runs
# `ours-install`. Idempotent: a re-run updates to @latest and runs again.
# The bootstrap is deliberately stable. For nightly, install the published nightly command
# directly: `npm i -g @ours.network/install@nightly && ours-install`; that package's own
# X.Y.Z-nightly.N version selects and exactly resolves the matching stack channel.
#
# Non-interactive env overrides (all optional) — consumed by the Node installer:
#   OURS_ASSUME_YES=1                        accept every default; never prompt (no tty needed)
#   OURS_INSTALL_DRY_RUN=1                   walk the whole flow WITHOUT installing/changing anything
#                                            (prints exactly what it WOULD do — safe on any machine)
#   OURS_NPM="npm"                           npm binary to use
#   OURS_CONFIG=/path/config.json            legacy daemon config or prepared private host profile;
#                                            a complete host profile performs client-only setup
#   OURS_INSTALLER_MJS=/path/install.mjs     run this Node installer directly (dev/testing)
#   OURS_INSTALL_PKG=@ours.network/install   the package to install for the command (override for dev)
set -euo pipefail

say(){ printf 'ours: %s\n' "$1"; }
PKG="${OURS_INSTALL_PKG:-@ours.network/install}"
NPM_BIN="${OURS_NPM:-npm}"

# --- 1) Node.js + npm check + friendly guidance ------------------------------------------------
# The installer needs a patched Node.js 22, 24 or 26 release (and npm to fetch the command). If missing, don't fail
# cryptically: explain what Node is and how to get it for this OS, point at nodejs.org, and exit
# cleanly (0) so a piped run ends gracefully rather than with a scary non-zero error.
if ! command -v node >/dev/null 2>&1 || ! command -v "$NPM_BIN" >/dev/null 2>&1; then
  os="$(uname -s 2>/dev/null || echo unknown)"
  printf '\n'
  say "ours needs Node.js (a patched 22.23.4+, 24.22.1+ or 26.12.1+ release, which includes npm) — it isn't installed yet."
  say "Node.js is a common, free runtime; here's how to get it:"
  case "$os" in
    Darwin)
      say "  • macOS (Homebrew):  brew install node"
      say "  • or nvm:            https://github.com/nvm-sh/nvm  then  nvm install --lts" ;;
    Linux)
      say "  • Debian/Ubuntu:     https://github.com/nodesource/distributions  (NodeSource)"
      say "  • or nvm:            https://github.com/nvm-sh/nvm  then  nvm install --lts" ;;
    *)
      say "  • Windows/WSL:       install Node.js in WSL, or from https://nodejs.org" ;;
  esac
  say "  • Or download the installer for any OS: https://nodejs.org"
  say "Once Node.js is installed, re-run this command and you're set."
  printf '\n'
  exit 0
fi

# Refuse unpatched Node.js before anything runs (floors: lib/security-versions.mjs).
node -e 'const f={22:[23,4],24:[22,1],26:[12,1]},m=/^(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.node),v=m&&m.slice(1).map(Number),p=v&&f[v[0]];if(!p||v[1]<p[0]||(v[1]===p[0]&&v[2]<p[1])){console.error("Node.js "+process.versions.node+" is not permitted. Ours requires a patched supported Node.js release: 22.23.4+, 24.22.1+, 26.12.1+ within those release lines; prerelease, end-of-life and unreviewed release lines are refused. Earlier patch levels are affected by CVE-2026-111497 (Brotli decompression out-of-bounds write): https://nodejs.org/en/blog/vulnerability/october-2026-security-releases Update Node.js from https://nodejs.org/en/download or your package manager, then retry.");process.exit(1)}' || exit 1

# --- 2) DEV / LOCAL path: run the sibling install.mjs directly ---------------------------------
# From a clone (or an explicit OURS_INSTALLER_MJS), skip npm entirely and run the local installer.
MJS=""
if [ -n "${OURS_INSTALLER_MJS:-}" ] && [ -f "${OURS_INSTALLER_MJS}" ]; then
  MJS="${OURS_INSTALLER_MJS}"
else
  SELF="${BASH_SOURCE[0]:-$0}"
  DIR="$(cd "$(dirname "$SELF")" 2>/dev/null && pwd || true)"
  [ -n "$DIR" ] && [ -f "$DIR/install.mjs" ] && MJS="$DIR/install.mjs"
fi
if [ -n "$MJS" ]; then
  exec node "$MJS" "$@"
fi

# --- 3) PIPED path (curl … | bash): install the command globally, then run it ------------------
# Canonical entry: install (or update) @ours.network/install, then invoke `ours-install`.
# Idempotent — a re-run updates to @latest and runs again.
say "installing the ours installer ($PKG)…"
if ! "$NPM_BIN" i -g "${PKG}@latest" >/dev/null 2>&1; then
  say "couldn't install $PKG from npm. Check your connection (and npm permissions), then retry:"
  say "    $NPM_BIN i -g $PKG   &&   ours-install"
  exit 1
fi
if ! command -v ours-install >/dev/null 2>&1; then
  say "installed $PKG but 'ours-install' isn't on your PATH. Add your npm global bin to PATH, then run: ours-install"
  say "    (npm bin -g  shows the directory to add)"
  exit 1
fi
exec ours-install "$@"
