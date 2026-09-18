#!/bin/sh
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
exec node /opt/ours/node_modules/@ours.network/cli/dist/cli.js daemon serve
