/** Stopped legacy Docker volumes mapped into the shared server-state archive layout. */
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { copyPrivateTree, scanSource, createArchive, validateArchive } from './state-archive.mjs';
import { publishNoReplace } from './state-native.mjs';

const COMPONENTS = ['daemon', 'telegram', 'cowork', 'messenger'];
import { recordNames, readBuildRecords, validateBuildRecordSet } from './build-context.mjs';
const DAEMON_STATE = '/var/lib/ours';
const MCP_STATE = '/var/lib/ours-mcp';
const LEGACY_MCP_CHILD = '.mcp';

function privateBytes(path, ownership) {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.uid !== ownership.uid || stat.gid !== ownership.gid || (stat.mode & 0o7777) !== 0o600) {
    throw new Error(`Unsafe Docker conversion source file: ${path}`);
  }
  return fs.readFileSync(path);
}

function objectAt(path, ownership) {
  const value = JSON.parse(privateBytes(path, ownership));
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Docker conversion configuration must be an object');
  }
  return value;
}

function validateProfile(profile, instanceId) {
  if (profile?.endpoint !== 'http://127.0.0.1:3050'
    || profile.expectedInstanceId !== instanceId
    || profile.credentialPath !== join(DAEMON_STATE, 'daemon-token')) {
    throw new Error('MCP profile does not select this Docker source');
  }
}

/** Source mounts and writer exclusion are selected and held by the installer. */
export async function stageDockerLayout(source, staging, options) {
  if (resolve(source) !== source || fs.realpathSync(source) !== source
    || source === dirname(source) || resolve(staging) !== staging
    || fs.realpathSync(dirname(staging)) !== dirname(staging)
    || staging === source || staging.startsWith(source + '/') || source.startsWith(staging + '/')) {
    throw new Error('Docker staging must be canonical and outside the source tree');
  }
  const daemon = join(source, 'daemon', 'data');
  const config = objectAt(join(daemon, 'config.json'), options);
  if (config.stateDir !== DAEMON_STATE || config.port !== 3050) {
    throw new Error('Daemon authority source differs from the selected Docker layout');
  }
  if (config.networkMcp?.applicationConfigPath !== join(DAEMON_STATE, LEGACY_MCP_CHILD, 'config.json')) {
    throw new Error('MCP configuration selects an external or conflicting source');
  }
  validateProfile(config.networkMcp.profile, options.instanceId);
  validateProfile(objectAt(join(daemon, LEGACY_MCP_CHILD, 'profile.json'), options), options.instanceId);
  validateBuildRecordSet(options.provenance);
  for (const name of recordNames(options.provenance)) {
    if (!Buffer.isBuffer(options.provenance?.[name])) throw new Error('Selected build provenance is required');
  }

  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    for (const component of COMPONENTS) {
      const data = join(source, component, 'data');
      const marker = join(data, '.ours-provenance');
      if (fs.readdirSync(marker).sort().join() !== recordNames(options.provenance).sort().join()) {
        throw new Error(`Incomplete source ${component} provenance`);
      }
      for (const name of recordNames(options.provenance)) {
        if (!privateBytes(join(marker, name), options).equals(options.provenance[name])) {
          throw new Error(`Source ${component} differs from the selected build`);
        }
      }
      copyPrivateTree(data, join(staging, component), options);
    }
    fs.renameSync(join(staging, 'daemon', LEGACY_MCP_CHILD), join(staging, 'mcp'));
    fs.mkdirSync(join(staging, 'credentials'), { mode: 0o700 });
    for (const component of COMPONENTS.filter(name => name !== 'daemon')) {
      const bytes = privateBytes(join(source, `${component}-credential`, 'daemon-token'), options);
      if (!bytes.length) throw new Error('Current managed credential is empty');
      const destination = join(staging, 'credentials', component);
      fs.mkdirSync(destination, { mode: 0o700 });
      fs.writeFileSync(join(destination, 'daemon-token'), bytes, { mode: 0o600, flag: 'wx' });
    }
    scanSource(staging, options);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Bind only after the original payload has been archived and validated. */
export function bindDockerLayout(staging, options) {
  const configPath = join(staging, 'daemon', 'config.json');
  const config = objectAt(configPath, options);
  validateProfile(config.networkMcp?.profile, options.instanceId);
  config.networkMcp.applicationConfigPath = join(MCP_STATE, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

/** Offline validation also covers components intentionally left stopped. */
export function validateDockerLayout(tree, options) {
  validateBuildRecordSet(options.provenance);
  scanSource(tree, options);
  for (const component of COMPONENTS) {
    if (fs.readdirSync(join(tree, component, '.ours-provenance')).sort().join() !== recordNames(options.provenance).sort().join()) throw new Error('Mixed component provenance');
    for (const name of recordNames(options.provenance)) {
      if (!privateBytes(join(tree, component, '.ours-provenance', name), options).equals(options.provenance[name])) {
        throw new Error(`Converted ${component} differs from the selected build`);
      }
    }
    const config = join(tree, component, 'config.json');
    if (fs.existsSync(config)) objectAt(config, options);
  }
  const daemon = objectAt(join(tree, 'daemon/config.json'), options);
  const profile = objectAt(join(tree, 'mcp/profile.json'), options);
  validateProfile(profile, options.instanceId);
  if (daemon.stateDir !== DAEMON_STATE || daemon.port !== 3050
    || daemon.networkMcp?.applicationConfigPath !== join(MCP_STATE, 'config.json')
    || JSON.stringify(daemon.networkMcp.profile) !== JSON.stringify(profile)
    || objectAt(join(tree, 'cowork/config.json'), options).stateDir !== '/var/lib/ours-cowork') {
    throw new Error('Converted Docker deployment configuration is inconsistent');
  }
  if (fs.existsSync(join(tree, 'mcp/config.json'))) objectAt(join(tree, 'mcp/config.json'), options);
  for (const path of ['daemon/daemon-token', ...COMPONENTS.filter(name => name !== 'daemon').map(name => `credentials/${name}/daemon-token`)]) {
    if (!privateBytes(join(tree, path), options).length) throw new Error('Converted managed credential is empty');
  }
}

/** Requires a schema-1 pending record reserving this volume and excluded writers. */
export async function prepareDockerLayout(source, storage, label, options) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(label)) throw new Error('Invalid conversion backup label');
  if (resolve(storage) !== storage || fs.realpathSync(storage) !== storage
    || resolve(source) !== source || fs.realpathSync(source) !== source
    || storage === source || storage.startsWith(source + '/') || source.startsWith(storage + '/')) {
    throw new Error('Conversion storage must be canonical and outside the source');
  }
  const privateDirectory = path => {
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== options.uid || stat.gid !== options.gid
      || (stat.mode & 0o7777) !== 0o700) throw new Error(`Unsafe conversion directory: ${path}`);
  };
  privateDirectory(storage);
  const maintenance = join(storage, '.maintenance');
  const backups = join(storage, 'backups');
  for (const path of [maintenance, backups]) {
    if (!fs.existsSync(path)) fs.mkdirSync(path, { mode: 0o700 });
    privateDirectory(path);
  }
  const staging = join(maintenance, 'layout-conversion');
  const target = join(storage, 'state');
  const removeOwnedTree = path => {
    if (!fs.existsSync(path)) return;
    scanSource(path, options);
    fs.rmSync(path, { recursive: true });
  };
  removeOwnedTree(staging);
  try {
    await stageDockerLayout(source, staging, options);
    const archiveOptions = { ...options, domain: 'server' };
    const backup = join(backups, label);
    if (fs.existsSync(backup)) await validateArchive(backup, archiveOptions);
    else await createArchive(staging, backup, archiveOptions);
    // The source remains mounted at its original runtime path for SDK selection.
    execFileSync(options.cli, ['config', 'access-retain', '--config', options.configPath,
      '--target-state-dir', join(staging, 'daemon'), '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    bindDockerLayout(staging, options);
    validateDockerLayout(staging, options);
    removeOwnedTree(target);
    publishNoReplace(staging, target);
  } finally {
    removeOwnedTree(staging);
  }
}

/** Remove only retired working data; volume-root archives remain untouched. */
export function cleanupDockerSource(source, options) {
  const empty = [];
  const aliases = [...COMPONENTS, ...COMPONENTS.filter(name => name !== 'daemon').map(name => `${name}-credential`)];
  for (const alias of aliases) {
    const root = join(source, alias);
    if (!fs.existsSync(root)) continue;
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.uid !== options.uid || stat.gid !== options.gid
      || (stat.mode & 0o7777) !== 0o700) throw new Error(`Unsafe retired volume root: ${alias}`);
    const credential = alias.endsWith('-credential');
    const path = join(root, credential ? 'daemon-token' : 'data');
    if (fs.existsSync(path)) {
      if (credential) { privateBytes(path, options); fs.unlinkSync(path); }
      else { scanSource(path, options); fs.rmSync(path, { recursive: true }); }
    }
    if (fs.readdirSync(root).length === 0) empty.push(alias);
  }
  return empty;
}

/** Internal one-shot container entrypoint; the installer owns writer exclusion. */
export async function runDockerLayoutCommand(argv, env = process.env) {
  const [operation, label] = argv;
  if (!((operation === 'prepare' && argv.length === 2)
    || (['validate', 'cleanup'].includes(operation) && argv.length === 1))) {
    throw new Error('usage: prepare BACKUP_LABEL | validate | cleanup');
  }
  const storage = env.OURS_STATE_ROOT || '/storage';
  const source = env.OURS_CONVERSION_SOURCE || '/source';
  const build = env.OURS_BUILD_ROOT || '/opt/ours';
  const options = {
    uid: process.getuid(), gid: process.getgid(), instanceId: env.OURS_DAEMON_ID,
    cli: env.OURS_CLI_PATH || '/opt/ours/node_modules/.bin/ours',
    configPath: env.OURS_DAEMON_CONFIG || '/var/lib/ours/config.json',
    provenance: readBuildRecords(build),
  };
  if (!options.uid || !options.gid) throw new Error('Conversion requires a non-root owner');
  if (operation === 'cleanup') {
    console.log(JSON.stringify({ emptyVolumes: cleanupDockerSource(source, options) }));
    return;
  }
  try {
    execFileSync(env.OURS_COWORK_CLI_PATH || '/opt/ours/node_modules/.bin/ours-cowork', ['--json', 'prepare-backup'], {
      env: { ...env, OURS_COWORK_CONFIG: env.OURS_COWORK_CONFIG || '/var/lib/ours-cowork/config.json',
        OURS_COWORK_STATE_DIR: env.OURS_COWORK_STATE_DIR || '/var/lib/ours-cowork' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Cowork preparation failed; Docker conversion was not continued');
  }
  if (operation === 'prepare') await prepareDockerLayout(source, storage, label, options);
  else validateDockerLayout(join(storage, 'state'), options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDockerLayoutCommand(process.argv.slice(2)).catch(error => {
    // Owner process errors may contain private output; keep it out of installer logs.
    console.error(error?.status !== undefined ? 'Owner command failed during Docker conversion' : error.message);
    process.exitCode = 1;
  });
}
