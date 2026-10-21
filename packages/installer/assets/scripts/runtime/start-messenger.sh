#!/bin/sh
# Re-enter this entrypoint for every recovery, including its locks and checks.
if [ "${OURS_RECOVERY_CHILD:-}" != 1 ]; then
  exec node "${OURS_RUNTIME_ROOT:-/opt/ours}/docker/recover.mjs" messenger
fi
set -e
umask 077
runtime="${OURS_RUNTIME_ROOT:-/opt/ours}"
state="${OURS_MESSENGER_STATE_DIR:-/var/lib/ours-messenger}"
exec 3<"$state"
flock -n 3 || { echo "OURS Messenger state is in use by another writer" >&2; exit 1; }
node "$runtime/docker/check-client.mjs" messenger
messenger="[\"node\",\"$runtime/node_modules/@ours.network/messenger-server/dist/cli.js\",\"serve\"]"
# Notifications run beside Messenger when this runtime ships the service and
# its private configuration was prepared. Messenger's producer reaches it on loopback.
config="${OURS_NOTIFICATIONS_CONFIG:-}"
if [ -n "$config" ] && [ -f "$runtime/node_modules/@ours.network/notifications/package.json" ] && [ -f "$config" ]; then
  notifications="$(dirname "$config")"
  exec 4<"$notifications"
  # Every writer of this state starts here and holds lock 4 for its lifetime;
  # the kernel releases it when the process dies, even on SIGKILL. Holding it
  # proves no other writer is alive, so a lock file left by an abrupt stop is stale.
  flock -n 4 || { echo "OURS notification state is in use by another writer" >&2; exit 1; }
  rm -f "$notifications/state.json.lock"
  OURS_NOTIFICATIONS_ORIGIN="http://127.0.0.1:49677"
  OURS_NOTIFICATIONS_PRODUCER_TOKEN="$(cat "${OURS_NOTIFICATIONS_PRODUCER_FILE:-/credentials/messenger/notifications-producer}")"
  export OURS_NOTIFICATIONS_ORIGIN OURS_NOTIFICATIONS_PRODUCER_TOKEN
  # Only Messenger receives its producer credential.
  exec node "$runtime/docker/supervise.mjs" "[$messenger,[\"env\",\"-u\",\"OURS_NOTIFICATIONS_PRODUCER_TOKEN\",\"node\",\"$runtime/docker/notifications-gateway.mjs\"]]"
fi
exec node "$runtime/node_modules/@ours.network/messenger-server/dist/cli.js" serve
