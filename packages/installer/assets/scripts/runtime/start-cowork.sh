#!/bin/sh
umask 077
exec 3</var/lib/ours-cowork
flock -n 3
node /opt/ours/docker/check-client.mjs cowork
exec node /opt/ours/node_modules/@ours.network/cowork/dist/cli.js serve
