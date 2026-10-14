# Installer assets

| Directory | Purpose | Caller |
|---|---|---|
| [build](build/README.md) | Fetch selected sources, build and package npm packages | Dockerfile or installer |
| [runtime](runtime/README.md) | Prepare selected storage and settings, start services and check readiness | Installer and Compose |
| [maintenance](maintenance/README.md) | Back up and restore stopped state using owning package interfaces | Installer |

These are internal assets of `ours-install`; users do not invoke the scripts
manually. Installer materializes Docker assets into the selected installation's
runtime directory. Package mode uses the same build coordinator and the installed
maintenance implementation.

Build scripts run under Node.js. Source builds may additionally need native build
tools, including Python for third-party dependencies. Archive and state maintenance
do not require Python.

The Dockerfile copies build scripts to `/build-scripts/` and runtime/maintenance
scripts to `/opt/ours/docker/`. Runtime services receive only their selected state
subdirectories; maintenance operates on the installation's shared state tree.
