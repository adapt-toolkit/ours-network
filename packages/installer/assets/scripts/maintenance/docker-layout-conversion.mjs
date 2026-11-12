/** Offline validation of stopped Docker server state; the file name is the retained image entrypoint. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { scanSource } from './state-archive.mjs';
import { recordNames, readBuildRecords, validateBuildRecordSet } from './build-context.mjs';

const COMPONENTS = ['daemon', 'telegram', 'cowork', 'messenger'];
const DAEMON_STATE = '/var/lib/ours';
const MCP_STATE = '/var/lib/ours-mcp';

function privateBytes(path, ownership) {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.uid !== ownership.uid || stat.gid !== ownership.gid || (stat.mode & 0o7777) !== 0o600) {
    throw new Error(`Unsafe Docker state file: ${path}`);
  }
  return fs.readFileSync(path);
}

function objectAt(path, ownership) {
  const value = JSON.parse(privateBytes(path, ownership));
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Docker state configuration must be an object');
  }
  return value;
}

function validateProfile(profile, instanceId) {
  if (profile?.endpoint !== 'http://127.0.0.1:3050'
    || profile.expectedInstanceId !== instanceId
    || profile.credentialPath !== join(DAEMON_STATE, 'daemon-token')) {
    throw new Error('MCP profile does not select this Docker installation');
  }
}

/** The installation's applications: all four, or the daemon alone for collaboration tools. */
export function selectedComponents(env = process.env) {
  const raw = env.OURS_SERVER_APPLICATIONS;
  if (raw === undefined || raw === '') return COMPONENTS;
  const selected = raw.split(',');
  if (selected[0] !== 'daemon' || new Set(selected).size !== selected.length || selected.some(name => !COMPONENTS.includes(name))) throw new Error('invalid OURS_SERVER_APPLICATIONS selection');
  return selected;
}

/** Offline validation also covers components intentionally left stopped. */
export function validateDockerLayout(tree, options) {
  const components = options.components ?? COMPONENTS;
  validateBuildRecordSet(options.provenance);
  scanSource(tree, options);
  for (const component of components) {
    if (fs.readdirSync(join(tree, component, '.ours-provenance')).sort().join() !== recordNames(options.provenance).sort().join()) throw new Error('Mixed component provenance');
    for (const name of recordNames(options.provenance)) {
      if (!privateBytes(join(tree, component, '.ours-provenance', name), options).equals(options.provenance[name])) {
        throw new Error(`Stored ${component} differs from the selected build`);
      }
    }
    const config = join(tree, component, 'config.json');
    if (fs.existsSync(config)) objectAt(config, options);
  }
  // Fresh managed installs keep the MCP profile separately until configured.
  // Retained embedded configuration, when present, must still match exactly.
  const daemon = objectAt(join(tree, 'daemon/config.json'), options);
  const profile = objectAt(join(tree, 'mcp/profile.json'), options);
  validateProfile(profile, options.instanceId);
  if (daemon.stateDir !== DAEMON_STATE || daemon.port !== 3050
    || (daemon.networkMcp !== undefined && (daemon.networkMcp?.applicationConfigPath !== join(MCP_STATE, 'config.json')
      || JSON.stringify(daemon.networkMcp?.profile) !== JSON.stringify(profile)))
    || (components.includes('cowork') && objectAt(join(tree, 'cowork/config.json'), options).stateDir !== '/var/lib/ours-cowork')) {
    throw new Error('Docker deployment configuration is inconsistent');
  }
  if (fs.existsSync(join(tree, 'mcp/config.json'))) objectAt(join(tree, 'mcp/config.json'), options);
  for (const path of ['daemon/daemon-token', ...components.filter(name => name !== 'daemon').map(name => `credentials/${name}/daemon-token`)]) {
    if (!privateBytes(join(tree, path), options).length) throw new Error('Managed credential is empty');
  }
}

/** Internal one-shot container entrypoint; the installer owns writer exclusion. */
export async function runDockerLayoutCommand(argv, env = process.env) {
  if (argv.length !== 1 || argv[0] !== 'validate') throw new Error('usage: validate');
  const options = {
    uid: process.getuid(), gid: process.getgid(), instanceId: env.OURS_DAEMON_ID,
    provenance: readBuildRecords(env.OURS_BUILD_ROOT || '/opt/ours'),
    components: selectedComponents(env),
  };
  if (!options.uid || !options.gid) throw new Error('Validation requires a non-root owner');
  if (options.components.includes('cowork')) try {
    execFileSync(env.OURS_COWORK_CLI_PATH || '/opt/ours/node_modules/.bin/ours-cowork', ['--json', 'prepare-backup'], {
      env: { ...env, OURS_COWORK_CONFIG: env.OURS_COWORK_CONFIG || '/var/lib/ours-cowork/config.json',
        OURS_COWORK_STATE_DIR: env.OURS_COWORK_STATE_DIR || '/var/lib/ours-cowork' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Cowork preparation failed; Docker validation was not continued');
  }
  validateDockerLayout(join(env.OURS_STATE_ROOT || '/storage', 'state'), options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDockerLayoutCommand(process.argv.slice(2)).catch(error => {
    // Owner process errors may contain private output; keep it out of installer logs.
    console.error(error?.status !== undefined ? 'Owner command failed during Docker validation' : error.message);
    process.exitCode = 1;
  });
}
