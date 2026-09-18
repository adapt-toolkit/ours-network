#!/bin/sh
umask 077
exec 3</var/lib/ours-telegram
flock -n 3
node /opt/ours/docker/check-client.mjs telegram
exec node /opt/ours/node_modules/@ours.network/tg-connector/dist/cli.js serve
