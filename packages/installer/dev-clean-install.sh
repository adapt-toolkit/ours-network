#!/usr/bin/env bash
# ours.network — DEV HARNESS, not part of the product install.
#
# Experience a branch's FIRST-install flow (consent gate → your name → root identity → framed
# next-steps panel) on a machine where the ours daemon is absent — e.g. a throwaway container —
# WITHOUT publishing anything to npm first. Meant to be run like:
#
#   docker run -it --rm -e OURS_INSTALL_REF=<branch> node:22 bash -c \
#     "curl -fsSL https://raw.githubusercontent.com/adapt-toolkit/ours-mcp/<branch>/packages/installer/dev-clean-install.sh | bash"
#
# It clones the given ref, builds @ours.network/mcp from it (incl. the MUFL packet), packs it to
# a tarball, and shims `npm i -g @ours.network/mcp@latest` to install THAT tarball — so the real
# installer runs the branch's daemon code end-to-end (create-root included) instead of the
# published @latest. Everything happens inside the current machine's global npm — only use this
# somewhere disposable.
set -euo pipefail

say(){ printf 'ours-dev: %s\n' "$1"; }
REF="${OURS_INSTALL_REF:-main}"
SRC="${OURS_DEV_SRC:-/tmp/ours-src}"

if command -v ours-mcp >/dev/null 2>&1 && ours-mcp --version >/dev/null 2>&1; then
  say "an ours daemon is already installed here — this harness is for CLEAN machines only."
  say "run it in a fresh container: docker run -it --rm node:22 …"
  exit 1
fi

say "cloning ours-mcp@${REF}…"
git clone --depth 1 --branch "$REF" --recurse-submodules --shallow-submodules \
  https://github.com/adapt-toolkit/ours-mcp "$SRC"
cd "$SRC"

say "installing workspace deps + building @ours.network/mcp from ${REF}…"
npm ci
npm run build --workspace @ours.network/mcp
TGZ="$(npm pack --workspace @ours.network/mcp --pack-destination /tmp | tail -1)"
say "built /tmp/${TGZ}"

# npm shim: exactly the installer's daemon-install invocation resolves to the branch tarball;
# every other npm call falls through to the real npm. OURS_DEV_BIN relocates it for sandboxed
# (non-root) verification runs.
BIN="${OURS_DEV_BIN:-/usr/local/bin}"
SHIM="$BIN/ours-branch-npm"
cat > "$SHIM" <<EOF
#!/bin/bash
if [ "\$*" = "i -g @ours.network/mcp@latest" ]; then exec npm i -g "/tmp/${TGZ}"; fi
exec npm "\$@"
EOF
chmod +x "$SHIM"
export PATH="$BIN:$PATH"

say "handing off to the branch installer (daemon installs from the branch build)…"
OURS_NPM=ours-branch-npm exec bash "$SRC/packages/installer/install.sh"
