#!/bin/sh
set -e
# Re-enter this entrypoint for every recovery, including its locks and checks.
if [ "${OURS_RECOVERY_CHILD:-}" != 1 ]; then
  exec node "${OURS_RUNTIME_ROOT:-/opt/ours}/docker/recover.mjs" cowork
fi
umask 077
exec 3</var/lib/ours-cowork
flock -n 3
node /opt/ours/docker/check-client.mjs cowork
exec node /opt/ours/node_modules/@ours.network/cowork/dist/cli.js serve
