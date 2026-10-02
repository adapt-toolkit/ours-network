#!/bin/sh
umask 077
exec 3</var/lib/ours-messenger
flock -n 3
node /opt/ours/docker/check-client.mjs messenger
messenger='["node","/opt/ours/node_modules/@ours.network/messenger-server/dist/cli.js","serve"]'
# Notifications run beside Messenger when this runtime ships the service and
# its private configuration was prepared. Messenger's producer reaches it on loopback.
if [ -n "${OURS_NOTIFICATIONS_CONFIG:-}" ] && [ -f /opt/ours/node_modules/@ours.network/notifications/package.json ] && [ -f "$OURS_NOTIFICATIONS_CONFIG" ]; then
  exec 4</var/lib/ours-notifications
  flock -n 4
  # Every writer of this state starts here and holds lock 4 for its lifetime;
  # the kernel releases it when the process dies, even on SIGKILL. Holding it
  # proves no other writer is alive, so a lock file left by an abrupt stop is stale.
  rm -f /var/lib/ours-notifications/state.json.lock
  OURS_NOTIFICATIONS_ORIGIN="http://127.0.0.1:49677"
  OURS_NOTIFICATIONS_PRODUCER_TOKEN="$(cat /credentials/messenger/notifications-producer)"
  export OURS_NOTIFICATIONS_ORIGIN OURS_NOTIFICATIONS_PRODUCER_TOKEN
  # Only Messenger receives its producer credential.
  exec node /opt/ours/docker/supervise.mjs "[$messenger,[\"env\",\"-u\",\"OURS_NOTIFICATIONS_PRODUCER_TOKEN\",\"node\",\"/opt/ours/docker/notifications-gateway.mjs\"]]"
fi
exec node /opt/ours/node_modules/@ours.network/messenger-server/dist/cli.js serve
