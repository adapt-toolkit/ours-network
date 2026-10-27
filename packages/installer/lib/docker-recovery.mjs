import { isSecureNodeVersion } from './security-versions.mjs';
import { readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteConfig } from './config.mjs';
import { engineName, runContainer } from './container-engine.mjs';
import { isPluginOnly } from './product.mjs';

const assets = new URL('../assets/', import.meta.url);
const files = ['scripts/runtime/recover.mjs', 'scripts/runtime/dependency-ready.mjs', 'scripts/runtime/healthcheck.mjs',
  ...['entrypoint.sh', 'start-telegram.sh', 'start-cowork.sh', 'start-messenger.sh'].map(f => `scripts/runtime/${f}`)];
const owned = (path, directory = false) => {
  const s = lstatSync(path);
  if (!(directory ? s.isDirectory() : s.isFile()) || s.uid !== process.getuid() || (!directory && s.nlink !== 1)
    || realpathSync(path) !== path || (s.mode & 0o7000)) throw new Error('Unsafe retained recovery delivery');
};
export const PATCHED_NODE_IMAGE = 'node:24.22.1';
// node:<version>[-<official variant>][@sha256:<digest>]; the version may be floating (24, 24.21).
const NODE_TAG = /^(\d+(?:\.\d+){0,2})(-(?:alpine(?:\d+(?:\.\d+)?)?|(?:bookworm|bullseye|trixie)(?:-slim)?|slim))?(@sha256:[0-9a-f]{64})?$/;
/**
 * Replace every Node base image that is not an exact patched release (floating, minor
 * or old tags). An exact patched release is kept with its variant and digest, so a newer
 * build is never downgraded; a replaced tag keeps its variant (bookworm-slim, alpine).
 */
export function securedNodeStages(text) {
  return text.replace(/^FROM node:(\S+)((?: AS \S+)?)$/gm, (line, tag, stage) => {
    const [, version, variant = ''] = NODE_TAG.exec(tag) ?? [];
    if (version && isSecureNodeVersion(version)) return line;
    return `FROM ${PATCHED_NODE_IMAGE}${variant}${stage}`;
  });
}
const beforeMaintenance = (text, line) => {
  // The matched stage line is kept as is, so its already secured base image is preserved.
  return text.replace(/^FROM \S+ AS maintenance$/m, stage => `${line}\n${stage}`);
};
/** Refresh installer-owned runtime scripts without changing source selection or state. */
export function refreshDockerRecovery(record) {
  for (const dir of [record.root, record.workDir, join(record.workDir, 'scripts'), join(record.workDir, 'scripts/runtime')]) owned(dir, true);
  const marker = join(record.workDir, '.recovery-rebuild');
  let changed = false;
  const replace = (name, bytes) => {
    const path = join(record.workDir, name);
    if (existsSync(path)) { owned(path); if (readFileSync(path).equals(bytes)) return; }
    // Persist before edits, so interruption cannot reuse an image lacking recovery.
    atomicWriteConfig(marker, 'required\n'); changed = true;
    atomicWriteConfig(path, bytes.toString());
  };
  // Plugin-only daemons also serve the client prefix from the image.
  const selected = isPluginOnly(record) ? [...files, 'scripts/runtime/daemon-client-prefix.mjs'] : files;
  for (const name of selected) replace(name, readFileSync(new URL(name, assets)));
  const dockerfile = join(record.workDir, 'Dockerfile'); owned(dockerfile);
  // Pin retained Node stages to a patched release; an already patched exact release is kept.
  replace('Dockerfile', Buffer.from(securedNodeStages(readFileSync(dockerfile, 'utf8'))));
  const line = 'COPY --chmod=644 scripts/runtime/recover.mjs scripts/runtime/dependency-ready.mjs /opt/ours/docker/';
  if (!readFileSync(dockerfile, 'utf8').includes('scripts/runtime/recover.mjs')) replace('Dockerfile', Buffer.from(beforeMaintenance(readFileSync(dockerfile, 'utf8'), line)));
  const prefixLine = 'COPY --chmod=644 scripts/runtime/daemon-client-prefix.mjs /opt/ours/docker/daemon-client-prefix.mjs';
  if (isPluginOnly(record) && !readFileSync(dockerfile, 'utf8').includes(prefixLine)) replace('Dockerfile', Buffer.from(beforeMaintenance(readFileSync(dockerfile, 'utf8'), prefixLine)));
  return changed || existsSync(marker);
}

/** An overlay also applies to retained Compose files, with one-shot jobs untouched. */
export function recoveryCompose(record) {
  return { services: Object.fromEntries(record.services.map(name => [name, { restart: 'unless-stopped' }])) };
}

/** Change only exact project-owned long-running containers; never start/recreate. */
export async function reconcileDockerRecovery(record, effects) {
  if (engineName(record) !== 'docker') return;
  const query = await runContainer(effects, record, ['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${record.project}`]);
  const ids = query.stdout.split(/\s+/).filter(Boolean);
  if (!ids.length) return;
  const inspected = JSON.parse((await runContainer(effects, record, ['inspect', ...ids])).stdout);
  const selected = [];
  for (const c of inspected) {
    const labels = c.Config?.Labels;
    if (labels?.['com.docker.compose.project'] !== record.project) throw new Error('Recovery container project ownership differs');
    if (!record.services.includes(labels['com.docker.compose.service']) || labels['com.docker.compose.oneoff']?.toLowerCase() !== 'false') continue;
    if (!ids.includes(c.Id)) throw new Error('Recovery container identity differs');
    if (c.HostConfig?.RestartPolicy?.Name !== 'unless-stopped') selected.push(c.Id);
  }
  if (selected.length) await runContainer(effects, record, ['update', '--restart', 'unless-stopped', ...selected]);
}
