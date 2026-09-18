import { readBuildRecords, initializeBuildMarker } from '../maintenance/build-context.mjs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync, readdirSync, chmodSync, chownSync,
} from 'node:fs';

const DELIVERY_FILES = [
  '/credentials/telegram/daemon-token',
  '/credentials/cowork/daemon-token',
  '/credentials/messenger/daemon-token',
];
const fail = (message) => { throw new Error(message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function privatePath(path, directory, exact = directory ? 0o700 : 0o600) {
  let value;
  if (directory) {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { value = fstatSync(descriptor); } finally { closeSync(descriptor); }
  } else {
    value = lstatSync(path);
  }
  if ((directory ? !value.isDirectory() : !value.isFile()) || value.isSymbolicLink()
      || value.uid !== process.getuid() || value.gid !== process.getgid()
      || (value.mode & 0o7777) !== exact) {
    fail(`Unsafe ownership or permissions: ${path}`);
  }
  return value;
}

function existingPrivate(path, directory, exact) {
  try { return privatePath(path, directory, exact); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function jsonObject(path) {
  privatePath(path, false);
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail(`Existing config is not valid JSON: ${path}`); }
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`Existing config must be an object: ${path}`);
  return value;
}

function atomicJson(path, value) {
  const temp = `${path}.setup-${randomBytes(8).toString('hex')}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function ensureDirectory(path) {
  if (existingPrivate(path, true, 0o700)) return;
  mkdirSync(path, { mode: 0o700 });
  privatePath(path, true);
}

function validateCommon(idName = 'OURS_DAEMON_ID') {
  if (!process.getuid() || !process.getgid()) fail('A non-root UID and GID are required');
  if (!uuid.test(process.env[idName] ?? '')) fail('Configure the shared lowercase daemon UUID');
}

function composeConfig(domain) {
  if (domain === 'daemon') {
    const value = { stateDir: '/var/lib/ours', port: 3050, apiVisibility: 'owner', networkMcp: { profile: { endpoint: 'http://127.0.0.1:3050', expectedInstanceId: process.env.OURS_DAEMON_ID, credentialPath: '/var/lib/ours/daemon-token' }, applicationConfigPath: '/var/lib/ours-mcp/config.json' } };
    if (process.env.OURS_BROKER_URL) value.brokerUrl = process.env.OURS_BROKER_URL;
    return value;
  }
  if (domain === 'cowork') {
    const port = Number(process.env.OURS_COWORK_REST_PORT);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('Configure a valid cowork REST port');
    return { version: 1, stateDir: '/var/lib/ours-cowork', rest: { enabled: true, host: '0.0.0.0', port } };
  }
  return null;
}

function prepare() {
  const uid = Number(process.env.OURS_UID), gid = Number(process.env.OURS_GID);
  if (![uid, gid].every((n) => Number.isSafeInteger(n) && n > 0)) fail('Configure non-root numeric OURS_UID and OURS_GID');
  const roots = ['/storage', '/owner-locks'];
  for (const path of roots) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let st; try { st = fstatSync(fd); } finally { closeSync(fd); }
    if (st.uid === 0 && readdirSync(path).length === 0) {
      chmodSync(path, 0o700); chownSync(path, uid, gid);
    } else if (st.uid !== uid || st.gid !== gid || (st.mode & 0o7777) !== 0o700) {
      fail(`Unsafe existing volume: ${path}`);
    }
  }
  process.setgroups([]); process.setgid(gid); process.setuid(uid);
  process.umask(0o077);
  validateCommon();
  for (const path of ['/storage/state', '/storage/state/mcp', '/storage/state/credentials',
    ...['telegram', 'cowork', 'messenger'].map(name => `/storage/state/credentials/${name}`),
    '/storage/backups', '/storage/.maintenance']) ensureDirectory(path);
  const coworkPort = Number(process.env.OURS_COWORK_REST_PORT);
  if (!Number.isSafeInteger(coworkPort) || coworkPort < 1 || coworkPort > 65535) fail('Configure a valid cowork REST port');
  for (const domain of ['daemon', 'telegram', 'cowork', 'messenger']) {
    const data = `/storage/state/${domain}`;
    ensureDirectory(data);
    // access-init owns the fresh-state check; no installer files enter daemon
    // state until it has initialized or retained the selected authority.
    if (domain === 'daemon') continue;
    initializeBuildMarker(`${data}/.ours-provenance`, readBuildRecords('/opt/ours'));
  }
  const path = '/storage/state/daemon/config.json';
  const expected = composeConfig('daemon');
  if (existingPrivate(path, false)) {
    const config = jsonObject(path);
    if ('apiToken' in config || Object.entries(expected).some(([key, value]) => JSON.stringify(config[key]) !== JSON.stringify(value))) {
      fail('Existing daemon configuration differs; use the supported maintenance workflow');
    }
  } else atomicJson(path, expected);
  const coworkPath = '/storage/state/cowork/config.json';
  const cowork = composeConfig('cowork');
  if (!existingPrivate(coworkPath, false)) atomicJson(coworkPath, cowork);
  else {
    const config = jsonObject(coworkPath);
    if (config.version !== 1 || config.stateDir !== cowork.stateDir || config.rest?.enabled !== true || config.rest?.host !== '0.0.0.0') fail('Existing cowork configuration conflicts with Compose');
  }
  console.log('OURS persistent volumes are ready');
}

function finishDaemonSetup() {
  const state = '/var/lib/ours';
  initializeBuildMarker(`${state}/.ours-provenance`, readBuildRecords('/opt/ours'));
  privatePath('/var/lib/ours-mcp', true);
  const mcpProfile = { endpoint: 'http://127.0.0.1:3050', expectedInstanceId: process.env.OURS_DAEMON_ID, credentialPath: `${state}/daemon-token` };
  const mcpPath = '/var/lib/ours-mcp/profile.json';
  if (!existingPrivate(mcpPath, false)) atomicJson(mcpPath, mcpProfile);
  else if (JSON.stringify(jsonObject(mcpPath)) !== JSON.stringify(mcpProfile)) fail('Existing MCP profile differs from the selected daemon');
}

async function telegramInput() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1024 * 1024) fail('Telegram input exceeds 1 MiB');
  }
  let value; try { value = JSON.parse(raw); } catch { fail('Telegram input must be JSON'); }
  exactKeys(value, ['config', 'provision'], 'Telegram input');
  for (const [key, input] of Object.entries(value)) {
    if (!input || Array.isArray(input) || typeof input !== 'object') fail(`Telegram ${key} must be an object`);
    const target = `/storage/state/telegram/${key === 'config' ? 'config' : 'provision'}.json`;
    if (existingPrivate(target, false)) {
      if (JSON.stringify(jsonObject(target)) !== JSON.stringify(input)) fail(`Existing Telegram ${key} differs; change it through the owning application`);
    } else atomicJson(target, input);
  }
  console.log('OURS protected Telegram input stored');
}

function cliJson(args) {
  const result = spawnSync(process.execPath, ['/opt/ours/node_modules/@ours.network/cli/dist/cli.js', ...args], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) fail('Official OURS CLI operation failed');
  try { return JSON.parse(result.stdout); }
  catch { fail('Official OURS CLI returned malformed JSON'); }
}

function access(operation, output) {
  validateCommon();
  const config = '/var/lib/ours/config.json';
  if (operation === 'access-init') {
    cliJson(['config', operation, '--config', config, ...(process.env.OURS_ACCESS_MIGRATE === '1' ? ['--migrate'] : []), '--json']);
    finishDaemonSetup();
  }
  else if (operation === 'access-replace') cliJson(['config', operation, '--config', config, '--confirm', '--json']);
  else if (operation === 'access-issue') {
    for (const path of output ? [output] : ['/var/lib/ours/daemon-token', ...DELIVERY_FILES]) {
      cliJson(['config', operation, '--config', config, '--output', path, '--replace', '--json']);
    }
  } else fail('Unknown access operation');
  console.log(`OURS ${operation} completed`);
}

function exactKeys(value, allowed, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${label} must be an object`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${label} contains an unsupported field`);
}


try {
  const operation = process.argv[2];
  if (operation === 'prepare') prepare();
  else if (operation === 'telegram-input') { prepare(); await telegramInput(); }
  else if (['access-init', 'access-issue', 'access-replace'].includes(operation)) access(operation, process.argv[3]);
  else fail('usage: client-setup.mjs prepare | telegram-input | access-init | access-issue [OUTPUT] | access-replace');
} catch (error) {
  console.error(`OURS client setup refused: ${error.message}`);
  process.exit(1);
}
