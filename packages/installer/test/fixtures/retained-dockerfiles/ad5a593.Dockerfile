# syntax=docker/dockerfile:1
FROM node:24 AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 ca-certificates git && rm -rf /var/lib/apt/lists/*
FROM toolchain AS build
WORKDIR /opt/ours
COPY sources.json /opt/ours/sources.json
COPY scripts/build/*.mjs /build-scripts/
COPY scripts/maintenance/build-context.mjs scripts/maintenance/provenance-compare.mjs /maintenance/
RUN --mount=type=secret,id=github_token --mount=type=cache,id=ours-dist-2-npm,target=/root/.npm,sharing=locked node /build-scripts/build.mjs
# Testing delivery: npm resolves transitive versions afresh; repeat builds may differ.
# build.mjs creates package.json once from the sources.json selections.
# Keep npm's generated lock and resolved tree in the image for this build's provenance.
RUN --mount=type=cache,id=ours-dist-2-npm,target=/root/.npm,sharing=locked npm install --omit=dev --no-audit --no-fund
RUN node /build-scripts/record-build.mjs
# Build provenance is non-secret, root-owned image content; arbitrary runtime UIDs
# must be able to read it. Protected state/host copies retain private ownership.
RUN chmod 755 /opt/ours /opt/ours/docker /opt/ours/docker/vendor && chmod 644 package.json package-lock.json dependency-tree.json build-context.json docker/vendor/*.tgz
LABEL network.ours.build-context="1"
COPY scripts/maintenance/build-context.mjs scripts/maintenance/provenance-compare.mjs /opt/ours/maintenance/
COPY scripts/runtime/runtime-common.mjs /opt/ours/docker/runtime-common.mjs
COPY scripts/runtime/check-client.mjs /opt/ours/docker/check-client.mjs
COPY scripts/runtime/check-start.mjs /opt/ours/docker/check-start.mjs
COPY scripts/runtime/client-setup.mjs /opt/ours/docker/client-setup.mjs
COPY scripts/runtime/entrypoint.sh /opt/ours/docker/entrypoint.sh
COPY scripts/runtime/healthcheck.mjs /opt/ours/docker/healthcheck.mjs
COPY scripts/runtime/start-telegram.sh scripts/runtime/health-telegram.sh scripts/runtime/start-cowork.sh scripts/runtime/health-cowork.sh scripts/runtime/start-messenger.sh scripts/runtime/health-messenger.mjs /opt/ours/docker/
FROM node:24 AS maintenance
LABEL network.ours.build-context="1"
WORKDIR /opt/ours
COPY --from=build /opt/ours /opt/ours
COPY scripts/maintenance/*.mjs /opt/ours/docker/
COPY --chmod=644 scripts/maintenance/package.json /opt/ours/docker/package.json
RUN --mount=type=cache,id=ours-dist-2-npm,target=/root/.npm,sharing=locked npm install --prefix /opt/ours/docker --omit=dev --ignore-scripts --no-audit --no-fund
USER 1000:1000
ENTRYPOINT ["node", "/opt/ours/docker/state-operation.mjs"]
FROM node:24 AS runtime
LABEL network.ours.build-context="1"
WORKDIR /opt/ours
COPY --from=build /opt/ours /opt/ours
USER 1000:1000
ENTRYPOINT ["/bin/sh", "/opt/ours/docker/entrypoint.sh"]
