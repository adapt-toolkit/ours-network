import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installationPaths, SERVER_SERVICES } from './plan.mjs';
import { runContainer } from './container-engine.mjs';
import { isPluginOnly } from './product.mjs';
import { scanSource } from '../assets/scripts/maintenance/state-archive.mjs';
import { recordNames, readBuildRecords } from '../assets/scripts/maintenance/build-context.mjs';

const PROVENANCE_DIRECTORY = '.ours-provenance';

function privateFile(path) {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.gid !== process.getgid() || (stat.mode & 0o7777) !== 0o600) {
    throw new Error(`Unsafe managed state file: ${path}`);
  }
  return fs.readFileSync(path);
}

function readConfig(path) {
  const value = JSON.parse(privateFile(path));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Managed configuration must be an object');
  return value;
}

function pathExists(path) {
  try { fs.lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Offline validation of stopped native state against the selected build. */
export function validatePackageState(record, tree = installationPaths(record).state) {
  const paths = installationPaths(record);
  const physical = path => join(tree, relative(paths.state, path));
  scanSource(tree, { uid: process.getuid(), gid: process.getgid() });
  const records = readBuildRecords(record.workDir);
  const BUILD_RECORDS = recordNames(records);
  for (const component of SERVER_SERVICES) {
    const marker = join(physical(paths[component]), PROVENANCE_DIRECTORY);
    if (fs.readdirSync(marker).sort().join() !== [...BUILD_RECORDS].sort().join()) {
      throw new Error(`Incomplete ${component} provenance`);
    }
    for (const name of BUILD_RECORDS) {
      if (!privateFile(join(marker, name)).equals(records[name])) {
        throw new Error(`Stored ${component} differs from the selected build`);
      }
    }
    const configPath = join(physical(paths[component]), 'config.json');
    if (pathExists(configPath)) readConfig(configPath);
  }
  const daemon = readConfig(physical(paths.config));
  const profile = readConfig(join(physical(paths.mcp), 'profile.json'));
  if (daemon.stateDir !== paths.daemon || daemon.port !== record.port
    || daemon.networkMcp?.applicationConfigPath !== join(paths.mcp, 'config.json')
    || profile.expectedInstanceId !== record.instanceId
    || profile.credentialPath !== join(paths.daemon, 'daemon-token')
    || profile.endpoint !== `http://127.0.0.1:${record.port}`
    || JSON.stringify(daemon.networkMcp.profile) !== JSON.stringify(profile)) {
    throw new Error('Daemon/MCP deployment configuration is inconsistent');
  }
  if (pathExists(join(physical(paths.mcp), 'config.json'))) readConfig(join(physical(paths.mcp), 'config.json'));
  if (readConfig(join(physical(paths.cowork), 'config.json')).stateDir !== paths.cowork) {
    throw new Error('Cowork configuration selects another state directory');
  }
  for (const credential of [profile.credentialPath, ...Object.values(paths.credentials)]) {
    if (!privateFile(physical(credential)).length) throw new Error('Managed credential is empty');
  }
}

/** Offline validation of stopped Docker state in the selected maintenance image. */
export async function validateDockerState(record, effects) {
  const mount = (target, subpath, readOnly) => ({ type: 'volume', source: 'storage', target, read_only: readOnly, volume: { nocopy: true, ...(subpath ? { subpath } : {}) } });
  const definition = {
    services: {
      'state-operation': {
        image: `${record.project}:maintenance`, platform: 'linux/amd64',
        user: `${record.uid ?? 1000}:${record.gid ?? 1000}`,
        network_mode: 'none', read_only: true, cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'], tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777'],
        // Retained maintenance images from earlier installers ship the same validate entrypoint.
        entrypoint: ['node', '/opt/ours/docker/docker-layout-conversion.mjs'],
        environment: { HOME: '/tmp', OURS_DAEMON_ID: record.instanceId, OURS_SERVER_APPLICATIONS: isPluginOnly(record) ? 'daemon' : '' },
        // A collaboration-tools installation has no Cowork state to mount.
        volumes: [mount('/storage'), mount('/var/lib/ours', 'state/daemon', true),
          ...(isPluginOnly(record) ? [] : [mount('/var/lib/ours-cowork', 'state/cowork', false)])],
      },
    },
    volumes: { storage: { external: true, name: `${record.project}_server-storage` } },
  };
  const path = join(record.root, `.validation-compose-${randomUUID()}.json`);
  try {
    fs.writeFileSync(path, JSON.stringify(definition), { mode: 0o600, flag: 'wx' });
    await runContainer(effects, record, ['compose', '--file', path, '--project-name', record.project,
      'run', '--rm', '--no-deps', '-T', 'state-operation', 'validate']);
  } finally {
    fs.rmSync(path, { force: true });
  }
}
