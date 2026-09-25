import { runContainer } from './container-engine.mjs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteConfig } from './config.mjs';

/** Update installer assets while retaining the selected application build. */
export async function prepareDockerConversionRuntime(record, effects, assets) {
  if (record.schema !== 1 || record.mode !== 'docker' || !/^ours-[a-z0-9]+$/.test(record.project)) {
    throw new Error('Select the legacy Docker runtime for conversion');
  }
  const compose = join(record.workDir, 'docker-compose.yaml');
  const legacy = join(record.workDir, 'docker-compose.legacy.yaml');
  if (!fs.existsSync(legacy)) {
    atomicWriteConfig(legacy, fs.readFileSync(compose));
  }
  const context = fs.mkdtempSync(join(record.root, '.conversion-build-'));
  try {
    fs.cpSync(join(assets, 'scripts/runtime'), join(context, 'runtime'), { recursive: true });
    fs.cpSync(join(assets, 'scripts/maintenance'), join(context, 'maintenance'), { recursive: true });
    const { dependencies } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
    fs.writeFileSync(join(context, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }));
    fs.writeFileSync(join(context, 'Dockerfile'), `# syntax=docker/dockerfile:1
FROM ${record.project}:runtime AS runtime
COPY --chmod=644 runtime/ /opt/ours/docker/
COPY --chmod=644 maintenance/release-graph.mjs /opt/ours/maintenance/release-graph.mjs
FROM runtime AS maintenance
USER 0:0
COPY --chmod=644 maintenance/ /opt/ours/docker/
COPY --chmod=644 package.json /opt/ours/docker/package.json
RUN npm install --prefix /opt/ours/docker --omit=dev --ignore-scripts --no-audit --no-fund
USER 1000:1000
ENTRYPOINT ["node", "/opt/ours/docker/state-operation.mjs"]
`);
    // Build maintenance first: both targets inherit the same retained runtime.
    for (const target of ['maintenance', 'runtime']) {
      await runContainer(effects, record, ['build', '--platform', 'linux/amd64', '--target', target,
        '--tag', `${record.project}:${target}`, context]);
    }
    atomicWriteConfig(compose, fs.readFileSync(join(assets, 'docker-compose.yaml')));
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
}

/** Run the existing maintenance service with the volumes selected by the installer. */
export async function runDockerConversion(record, selected, operation, label, effects) {
  if (!['prepare', 'validate', 'cleanup'].includes(operation)) throw new Error('Unsupported Docker conversion operation');
  const volumes = { storage: { external: true, name: selected.target } };
  const mounts = [{ type: 'volume', source: 'storage', target: '/storage', volume: { nocopy: true } }];
  const addMount = (source, target, subpath, readOnly) => mounts.push({
    type: 'volume', source, target, read_only: readOnly,
    volume: { nocopy: true, ...(subpath ? { subpath } : {}) },
  });
  if (operation !== 'validate') {
    for (const [alias, name] of Object.entries(selected.sources)) {
      const source = `source-${alias}`;
      volumes[source] = { external: true, name };
      addMount(source, `/source/${alias}`, undefined, operation === 'prepare' && alias !== 'cowork');
    }
    if (operation === 'prepare') {
      addMount('source-daemon', '/var/lib/ours', 'data', true);
      addMount('source-cowork', '/var/lib/ours-cowork', 'data', false);
    }
  } else {
    addMount('storage', '/var/lib/ours', 'state/daemon', true);
    addMount('storage', '/var/lib/ours-cowork', 'state/cowork', false);
  }
  const definition = {
    services: {
      'state-operation': {
        image: `${record.project}:maintenance`, platform: 'linux/amd64',
        user: `${record.uid ?? 1000}:${record.gid ?? 1000}`,
        network_mode: 'none', read_only: true, cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'], tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777'],
        entrypoint: ['node', '/opt/ours/docker/docker-layout-conversion.mjs'],
        environment: { HOME: '/tmp', OURS_DAEMON_ID: record.instanceId },
        volumes: mounts,
      },
    },
    volumes,
  };
  const path = join(record.root, `.conversion-compose-${randomUUID()}.json`);
  try {
    fs.writeFileSync(path, JSON.stringify(definition), { mode: 0o600, flag: 'wx' });
    const result = await runContainer(effects, record, ['compose', '--file', path, '--project-name', record.project,
      'run', '--rm', '--no-deps', '-T', 'state-operation', operation, ...(label ? [label] : [])]);
    if (operation === 'cleanup') {
      const summary = JSON.parse(result.stdout);
      if (!Array.isArray(summary.emptyVolumes) || summary.emptyVolumes.some(alias => !Object.hasOwn(selected.sources, alias))) {
        throw new Error('Invalid retired-volume cleanup result');
      }
      return summary;
    }
  } finally {
    fs.rmSync(path, { force: true });
  }
}
