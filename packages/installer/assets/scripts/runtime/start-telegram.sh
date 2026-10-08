#!/bin/sh
set -e
# Re-enter this entrypoint for every recovery, including its locks and checks.
if [ "${OURS_RECOVERY_CHILD:-}" != 1 ]; then
  exec node "${OURS_RUNTIME_ROOT:-/opt/ours}/docker/recover.mjs" telegram
fi
umask 077
exec 3</var/lib/ours-telegram
flock -n 3
node /opt/ours/docker/check-client.mjs telegram
exec node /opt/ours/node_modules/@ours.network/tg-connector/dist/cli.js serve
