FROM node:24-bookworm-slim
ARG ROLE
WORKDIR /opt/ours
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY manifests/${ROLE}.json ./package.json
COPY manifests/${ROLE}.lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund
ENV NODE_PATH=/opt/ours/node_modules
