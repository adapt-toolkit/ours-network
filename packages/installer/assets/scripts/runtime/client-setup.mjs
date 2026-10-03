import { readBuildRecords, initializeBuildMarker } from '../maintenance/build-context.mjs';
import { redactDiagnostic } from './diagnostics.mjs';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  existsSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync, readdirSync, chmodSync, chownSync,
} from 'node:fs';

const DELIVERY_FILES = [
  '/credentials/telegram/daemon-token',
  '/credentials/cowork/daemon-token',
  '/credentials/messenger/daemon-token',
];
const fail = (message) => { throw new Error(message); };
let diagnosticStage = 'validation';
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
    const value = { stateDir: '/var/lib/ours', port: 3050, apiVisibility: 'owner' };
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

const NOTIFICATIONS_PORT = 49677;
const NOTIFICATION_FILES = {
  config: '/storage/state/notifications/config.json',
  messenger: '/storage/state/credentials/messenger/notifications-producer',
  // Read through the Messenger service by local client setup.
  fleet: '/storage/state/notifications/fleet-producer',
};

function privateText(path, value) {
  if (existingPrivate(path, false) && readFileSync(path, 'utf8') === value) return;
  const temp = `${path}.setup-${randomBytes(8).toString('hex')}`;
  try { writeFileSync(temp, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

function notificationConfig() {
  const token = () => randomBytes(32).toString('base64url');
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' }), key = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
  return {
    host: '0.0.0.0', port: NOTIFICATIONS_PORT, stateFile: '/var/lib/ours-notifications/state.json',
    users: [{ userId: 'owner', token: token() }],
    producers: [{ userId: 'owner', source: 'fleet', token: token() }, { userId: 'owner', source: 'messenger', token: token() }],
    vapid: { subject: 'https://ours.network', publicKey: raw.toString('base64url'), privateKey: key.d },
  };
}

/** Exact retained shape; any other content is operator state the installer will not rewrite. */
function validNotificationConfig(config) {
  const tokens = [...(config.users ?? []), ...(config.producers ?? [])].map(entry => entry?.token);
  return config.host === '0.0.0.0' && config.port === NOTIFICATIONS_PORT && config.stateFile === '/var/lib/ours-notifications/state.json'
    && Array.isArray(config.users) && config.users.length === 1 && config.users[0].userId === 'owner'
    && Array.isArray(config.producers) && config.producers.length === 2
    && ['fleet', 'messenger'].every(source => config.producers.some(p => p?.source === source && p.userId === 'owner'))
    && tokens.every(t => typeof t === 'string' && t.length >= 32) && new Set(tokens).size === tokens.length
    && typeof config.vapid?.subject === 'string' && /^[A-Za-z0-9_-]{87}$/.test(config.vapid.publicKey ?? '') && /^[A-Za-z0-9_-]{43}$/.test(config.vapid.privateKey ?? '');
}

/**
 * Notification secrets are created once and then only validated: rotating the
 * owner token or VAPID keys would orphan every browser subscription. Producer
 * delivery files are derived from the retained configuration on every run.
 */
function prepareNotifications() {
  // Messenger mounts this directory whether or not this runtime ships the service.
  ensureDirectory('/storage/state/notifications');
  if (!existsSync('/opt/ours/node_modules/@ours.network/notifications/package.json')) return;
  initializeBuildMarker('/storage/state/notifications/.ours-provenance', readBuildRecords('/opt/ours'));
  if (!existingPrivate(NOTIFICATION_FILES.config, false)) atomicJson(NOTIFICATION_FILES.config, notificationConfig());
  const config = jsonObject(NOTIFICATION_FILES.config);
  if (!validNotificationConfig(config)) fail('Existing notification configuration differs; use the supported maintenance workflow');
  for (const source of ['messenger', 'fleet']) privateText(NOTIFICATION_FILES[source], config.producers.find(p => p.source === source).token);
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
  prepareNotifications();
  console.log('OURS persistent volumes are ready');
}

function finishDaemonSetup() {
  const state = '/var/lib/ours';
  diagnosticStage = 'daemon-provenance';
  initializeBuildMarker(`${state}/.ours-provenance`, readBuildRecords('/opt/ours'));
  diagnosticStage = 'mcp-directory';
  privatePath('/var/lib/ours-mcp', true);
  const mcpProfile = { endpoint: 'http://127.0.0.1:3050', expectedInstanceId: process.env.OURS_DAEMON_ID, credentialPath: `${state}/daemon-token` };
  const mcpPath = '/var/lib/ours-mcp/profile.json';
  diagnosticStage = 'mcp-profile';
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
  diagnosticStage = 'official-cli';
  const result = spawnSync(process.execPath, [existsSync('/opt/ours/node_modules/@ours.network/daemon/dist/cli.js') ? '/opt/ours/node_modules/@ours.network/daemon/dist/cli.js' : '/opt/ours/node_modules/@ours.network/cli/dist/cli.js', ...args], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // --json writes failures on stderr. Successful credential stdout is never
    // forwarded, even if a later operation exits unsuccessfully.
    let reason = 'CLI supplied no structured error reason';
    for (const line of String(result.stderr ?? '').split('\n').reverse()) {
      try { const value = JSON.parse(line); if (typeof value?.error?.message === 'string') { reason = value.error.message; break; } } catch {}
    }
    fail(`Official OURS CLI operation failed (${args[1]}; exit=${result.status ?? 'none'}; signal=${result.signal ?? 'none'}; system=${result.error?.code ?? 'none'}): ${reason}`);
  }
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
  // Structured stderr retains the failing stage across sensitive Compose
  // capture. The installer redacts secrets before exposing this envelope.
  const message = redactDiagnostic(error.message);
  console.error(JSON.stringify({ oursInstallerError: { stage: diagnosticStage, message } }));
  console.error(`OURS client setup refused: ${message}`);
  process.exit(1);
}
