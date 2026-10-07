#!/bin/sh
# Re-enter this entrypoint for every recovery, including its locks and checks.
if [ "${OURS_RECOVERY_CHILD:-}" != 1 ]; then
  exec node "${OURS_RUNTIME_ROOT:-/opt/ours}/docker/recover.mjs" daemon
fi
set -eu
umask 077
exec 3</var/lib/ours
if flock -n -E 73 3; then
  :
else
  status=$?
  echo "OURS startup refused: daemon state is already in use" >&2
  exit "$status"
fi
node /opt/ours/docker/check-start.mjs
exec node /opt/ours/node_modules/@ours.network/daemon/dist/cli.js serve
