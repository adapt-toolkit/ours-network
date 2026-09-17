#!/bin/sh
umask 077
exec 3</var/lib/ours-messenger
flock -n 3
node /opt/ours/docker/check-client.mjs messenger
exec node /opt/ours/node_modules/@ours.network/messenger-server/dist/cli.js serve
