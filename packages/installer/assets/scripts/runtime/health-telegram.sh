#!/bin/sh
# The connector exposes readiness only after optional provisioning succeeds.
node -e '
  fetch("http://127.0.0.1:3051/health", {
    signal: AbortSignal.timeout(3000), redirect: "error"
  }).then(response => process.exit(response.ok ? 0 : 1))
    .catch(() => process.exit(1));
'
