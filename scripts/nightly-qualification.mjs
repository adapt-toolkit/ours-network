/**
 * Shared, side-effect-free helpers for the CI-only nightly installer
 * qualification scripts. Importing this module starts nothing.
 *
 * Output discipline: nothing here prints a token, a VAPID value, a push
 * subscription or the Notifications state payload. Credentials and secrets are
 * compared only through SHA-256 digests computed inside the container.
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';

export const INSTALLER = '@ours.network/install';
export const NOTIFICATIONS = '@ours.network/notifications';
export const UPSTREAM_REGISTRY = 'https://registry.npmjs.org';
/** The seeded pending retry is scheduled far beyond any job, so no provider is ever contacted. */
export const RETRY_DEADLINE = Date.UTC(2100, 0, 1);
const STATE_DIR_IN_CONTAINER = '/var/lib/ours-notifications';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
export const imageId = tag => docker(['image', 'inspect', '--format', '{{.Id}}', tag]).trim();

/** Install an installer release into its own npm prefix. */
export function installInstaller(prefix, spec, env = process.env) {
  execFileSync('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', spec], { stdio: 'inherit', env });
  const dir = join(prefix, 'lib', 'node_modules', '@ours.network', 'install');
  const read = file => JSON.parse(fs.readFileSync(join(dir, file), 'utf8'));
  return { bin: join(prefix, 'bin', 'ours-install'), dir, read, env: { ...env, npm_config_prefix: prefix, PATH: `${join(prefix, 'bin')}:${env.PATH}` } };
}

/** Pack this checkout's installer exactly as the publish job does and keep the archive's own bytes reachable. */
export function packCandidate(destination, env = process.env) {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--workspace', INSTALLER, '--pack-destination', destination, '--json'], { encoding: 'utf8', env }));
  const tarball = join(destination, packed.filename);
  const read = file => execFileSync('tar', ['-xOf', tarball, `package/${file}`], { maxBuffer: 16 * 1024 * 1024 });
  return { ...packed, tarball, read, sha256: sha256(fs.readFileSync(tarball)) };
}

/** Run an installer command, streaming and capturing its output. */
export function runInstaller(installer, args, label, { env = installer.env, detached = false } = {}) {
  console.log(`\n=== ${label}: ours-install ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    // detached: a new session, so the installer has no controlling terminal.
    const child = spawn(installer.bin, args, { env, detached, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
}

/**
 * HTTP probe of the running Notifications service, through the installer's
 * adapter on its loopback port, with the service's own scoped credentials.
 * Paths default to the Messenger container; the variables only exist so the
 * same text can be exercised against local packages without Docker.
 */
export const NOTIFICATIONS_PROBE = `import { readFileSync } from 'node:fs';
import { createHash, createECDH, randomBytes } from 'node:crypto';
// Never name an action "inspect": node treats a leading inspect argument as its debugger command.
const action = process.argv[1];
const configPath = process.env.QUALIFICATION_NOTIFICATIONS_CONFIG || '${STATE_DIR_IN_CONTAINER}/config.json';
const origin = process.env.QUALIFICATION_NOTIFICATIONS_ORIGIN || 'http://127.0.0.1:49677';
const packagePath = process.env.QUALIFICATION_NOTIFICATIONS_PACKAGE || '/opt/ours/node_modules/@ours.network/notifications/package.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const configBytes = readFileSync(configPath), config = JSON.parse(configBytes);
const owner = config.users[0].token;
const producer = source => config.producers.find(p => p.source === source).token;
const call = async (path, token, body) => {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (response.status !== 200) throw new Error(path + ' failed with HTTP ' + response.status);
  return response.json();
};
const fleetEvent = n => ({ eventId: 'nightly-qualification-' + n, title: 'Qualification ' + n, body: 'Seeded before the nightly upgrade', target: { kind: 'agent', agentId: 'nightly-qualification' } });
const messengerEvent = { eventId: 'nightly-qualification-messenger', title: 'Qualification message', body: 'Seeded before the nightly upgrade', target: { kind: 'contact', contactId: 'nightly-qualification-contact' } };
const stateBytes = () => readFileSync(config.stateFile);
let result;
if (action === 'seed') {
  // Rows first, then the device: no job exists while the writer runs, so nothing is pushed.
  for (const n of [1, 2, 3]) await call('/api/v1/send', producer('fleet'), fleetEvent(n));
  await call('/api/v1/send', producer('messenger'), messengerEvent);
  const first = (await call('/api/v1/inbox?limit=50', owner)).items.find(item => item.title === 'Qualification 1');
  await call('/api/v1/read', owner, { ids: [first.id] });
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  await call('/api/v1/devices', owner, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/nightly-qualification-not-a-device',
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } } });
  await call('/api/v1/missions/bootstrap', producer('fleet'), { generation: 1, complete: false });
  await call('/api/v1/missions/associate', producer('fleet'), { taskId: 'nightly-qualification-task', revision: 1, contactIds: ['${'B'.repeat(64)}'] });
  await call('/api/v1/missions/bootstrap', producer('fleet'), { generation: 1, complete: true });
  await call('/api/v1/preferences', owner, { ownMissionRoomMessages: false });
  result = { seeded: true };
} else if (action === 'dedupe') {
  const before = sha(stateBytes());
  const fleet = await call('/api/v1/send', producer('fleet'), fleetEvent(1));
  const messenger = await call('/api/v1/send', producer('messenger'), messengerEvent);
  result = { fleet: fleet.id, messenger: messenger.id, stateUnchanged: sha(stateBytes()) === before };
} else if (action === 'snapshot') {
  const bytes = stateBytes(), state = JSON.parse(bytes);
  const inbox = await call('/api/v1/inbox?limit=50', owner);
  const unreadOnly = await call('/api/v1/inbox?limit=50&unread=true', owner);
  const push = await call('/api/v1/push/config', owner);
  result = {
    version: JSON.parse(readFileSync(packagePath, 'utf8')).version,
    configPath, stateFile: config.stateFile, stateSha256: sha(bytes), stateVersion: state.version, revision: state.revision,
    counts: Object.fromEntries(['devices', 'notifications', 'jobs', 'receipts', 'deliveries', 'missions', 'preferences'].map(key => [key, state[key].length])),
    devices: state.devices.map(d => ({ id: d.id, userId: d.userId, subscriptionSha256: sha(JSON.stringify(d.subscription)) })),
    jobs: state.jobs, receipts: state.receipts, deliveries: state.deliveries, missions: state.missions, preferences: state.preferences,
    notifications: state.notifications.map(({ id, source, eventId, target, createdAt, createdRevision, readAt }) => ({ id, source, eventId, target, createdAt, createdRevision, readAt })),
    inbox: { unread: inbox.unread, revision: inbox.revision, items: inbox.items.map(({ id, title, body, target, createdAt, readAt }) => ({ id, title, body, target, createdAt, readAt })) },
    unreadFilter: { filter: unreadOnly.filter ?? null, ids: unreadOnly.items.map(item => item.id) },
    summary: await call('/api/v1/summary', owner), delivery: await call('/api/v1/delivery/status', owner), preference: await call('/api/v1/preferences', owner),
    credentials: { config: sha(configBytes), owner: sha(owner), fleet: sha(producer('fleet')), messenger: sha(producer('messenger')),
      fleetCapabilities: config.producers.find(p => p.source === 'fleet').capabilities ?? [],
      vapidSubject: sha(config.vapid.subject), vapidPublic: sha(config.vapid.publicKey), vapidPrivate: sha(config.vapid.privateKey), servedPublic: sha(push.publicKey) },
  };
} else throw new Error('Unknown probe action ' + action);
process.stdout.write(JSON.stringify(result));`;

/**
 * Offline seeding with the image's own Notifications Store. It runs only under
 * OFFLINE_SEED_SHELL, which holds the Notifications directory flock that every
 * writer holds for its lifetime (start-messenger.sh, fd 4). Holding it proves no
 * writer is alive, so a store lock file left behind is stale; it is cleared the
 * same way start-messenger.sh clears it, and reported. It adds a pending retry
 * (deadline RETRY_DEADLINE, synthetic 503) and an accepted delivery (synthetic
 * 201); the provider transport is never called.
 */
export const OFFLINE_SEED = `import { existsSync, readFileSync, unlinkSync } from 'node:fs';
const dir = process.env.QUALIFICATION_NOTIFICATIONS_DIR || '/storage/state/notifications';
const { Store } = await import(process.env.QUALIFICATION_STORE_MODULE || '/opt/ours/node_modules/@ours.network/notifications/dist/store.js');
const file = dir + '/state.json';
if (process.env.QUALIFICATION_WRITER_FLOCK !== 'held') throw new Error('Offline seeding requires the Notifications directory flock');
const staleLock = existsSync(file + '.lock');
if (staleLock) unlinkSync(file + '.lock');
const config = JSON.parse(readFileSync(dir + '/config.json', 'utf8'));
const trusted = config.producers.filter(p => p.capabilities?.includes('mission-ownership')).map(p => ({ userId: p.userId, source: p.source }));
const store = new Store(file, { lifecycleProducers: trusted });
try {
  const input = eventId => ({ userId: config.users[0].userId, source: 'fleet', eventId, title: 'Qualification ' + eventId, body: 'Seeded offline before the nightly upgrade', target: { kind: 'agent', agentId: 'nightly-qualification' } });
  const settle = (row, status, at, outcome, code) => {
    const due = store.due(Date.now() + 1000);
    if (due.length !== 1 || due[0].notificationId !== row.id) throw new Error('Expected exactly one due job for the seeded row');
    store.finish(due[0].id, status, at, outcome, code);
  };
  settle(store.produce(input('nightly-qualification-pending')), 'retry', ${RETRY_DEADLINE}, 'retry_scheduled', 503);
  settle(store.produce(input('nightly-qualification-delivered')), 'sent', Date.now(), 'provider_accepted', 201);
} finally { store.close(); }
if (existsSync(file + '.lock')) throw new Error('Notification store lock was not released');
process.stdout.write(JSON.stringify({ offline: true, staleLockCleared: staleLock }));`;

/** Hold the writers' directory flock for the whole seed; exit 75 if any writer holds it. */
export const OFFLINE_SEED_SHELL = 'dir="${QUALIFICATION_NOTIFICATIONS_DIR:-/storage/state/notifications}"; exec 4<"$dir" || exit 1; flock -n 4 || { echo "Notification state is in use by another writer" >&2; exit 75; }; QUALIFICATION_WRITER_FLOCK=held exec node --input-type=module -e "$QUALIFICATION_SEED"';

const messengerContainer = record => `${record.project}-messenger-1`;
export const notifications = (record, action) => JSON.parse(docker(['exec', messengerContainer(record), 'node', '--input-type=module', '-e', NOTIFICATIONS_PROBE, '--', action]));

async function waitHealthy(container, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = docker(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', container]).trim();
    if (status === 'healthy') return;
    if (Date.now() > deadline) throw new Error(`${container} did not become healthy (last status ${status})`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

/** Stop the Messenger (the only Notifications writer), seed offline under its lock contract, start it again. */
export async function seedOfflineWithWriterStopped(record) {
  const container = messengerContainer(record);
  docker(['stop', '--time', '30', container]);
  const stopped = JSON.parse(docker(['inspect', '--format', '{{json .State}}', container]));
  assert.equal(stopped.Status, 'exited');
  assert.equal(stopped.ExitCode, 0, 'Messenger and Notifications stopped cleanly');
  console.log(`Messenger stopped: started ${stopped.StartedAt}, finished ${stopped.FinishedAt}`);
  console.log(docker(['logs', '--tail', '30', container]));
  const volume = `${record.project}_server-storage`;
  assert.equal(docker(['ps', '--filter', `volume=${volume}`, '--format', '{{.Names}}']).trim(), '', 'no running container mounts the Notifications state');
  const seeded = docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--user', `${record.uid ?? 1000}:${record.gid ?? 1000}`,
    '--mount', `type=volume,source=${volume},target=/storage`,
    '--env', `QUALIFICATION_SEED=${OFFLINE_SEED}`, '--entrypoint', '/bin/sh', `${record.project}:runtime`,
    '-c', OFFLINE_SEED_SHELL]);
  console.log('Offline seed:', seeded.trim());
  docker(['start', container]);
  await waitHealthy(container);
}

/** Seed through the API, then offline; return the baseline snapshot after the writer restarted. */
export async function seedStableNotifications(record, stable) {
  notifications(record, 'seed');
  await seedOfflineWithWriterStopped(record);
  const baseline = notifications(record, 'snapshot');
  console.log('Seeded Notifications:', describeSnapshot(baseline));
  assertSeededBaseline(baseline, stable.packages[NOTIFICATIONS].version);
  return baseline;
}

/** The seeded stable state is non-empty in every collection the API and Store can populate. */
export function assertSeededBaseline(baseline, stableVersion) {
  assert.equal(baseline.version, stableVersion, 'baseline runs the stable Notifications pin');
  assert.equal(baseline.stateVersion, 3, 'stable Notifications writes a version 3 state file');
  assert.deepEqual(baseline.counts, { devices: 1, notifications: 6, jobs: 1, receipts: 6, deliveries: 6, missions: 1, preferences: 1 });
  assert.equal(baseline.inbox.items.length, 6);
  assert.equal(baseline.inbox.items.filter(item => item.readAt).length, 1);
  assert.equal(baseline.inbox.unread, 5);
  assert.deepEqual(baseline.jobs.map(({ attempts, due, deviceId }) => ({ attempts, due, deviceId })), [{ attempts: 1, due: RETRY_DEADLINE + 120_000, deviceId: baseline.devices[0].id }],
    'one pending retry: first backoff (2 minutes) after the synthetic failure at RETRY_DEADLINE');
  assert.deepEqual(baseline.deliveries.map(d => d.outcome).sort(), ['no_device', 'no_device', 'no_device', 'no_device', 'provider_accepted', 'retry_scheduled'],
    'the four API rows had no device; the offline rows were retried once and accepted once');
  assert.equal(baseline.delivery.pending, 1);
  assert.deepEqual(baseline.preference, { userId: baseline.preference.userId, ownMissionRoomMessages: false, missionRoomsReady: true });
  assert.deepEqual(baseline.missions.map(({ source, taskId, revision, contactIds }) => ({ source, taskId, revision, contactIds })),
    [{ source: 'fleet', taskId: 'nightly-qualification-task', revision: 1, contactIds: ['B'.repeat(64)] }]);
  assert.equal(baseline.credentials.servedPublic, baseline.credentials.vapidPublic);
  assert.ok(baseline.credentials.fleetCapabilities.includes('mission-ownership'));
}

/** Non-secret one-line description of a snapshot. */
export function describeSnapshot(s) {
  return JSON.stringify({ version: s.version, stateVersion: s.stateVersion, revision: s.revision, stateSha256: s.stateSha256, counts: s.counts, unread: s.inbox.unread, unreadFilter: s.unreadFilter.filter });
}

/**
 * Everything the stable writer stored must be retained exactly by the
 * candidate. Notifications 1.0.1 -> 1.0.2 changed only the inbox read path (an
 * optional unread filter); the state format and open-time repair are
 * unchanged, so the state file bytes, the configuration bytes and every
 * credential digest must be identical. Two fields legitimately differ and are
 * asserted explicitly: the package version, and the unread filter, which 1.0.1
 * ignores and the candidate applies.
 */
export function assertRetained(baseline, current, expectedVersion, label) {
  assert.equal(current.version, expectedVersion, `${label}: candidate Notifications is running`);
  assert.deepEqual(current.unreadFilter, { filter: 'unread', ids: current.inbox.items.filter(item => !item.readAt).map(item => item.id) }, `${label}: candidate applies the unread filter`);
  const { version: _a, unreadFilter: _b, ...retained } = baseline;
  const { version: _c, unreadFilter: _d, ...observed } = current;
  assert.deepEqual(observed, retained, `${label}: Notifications state, identities, receipts, jobs, missions, preferences and credentials retained exactly`);
}

/** Re-sending admitted events after the resume stays deduplicated, authenticates with the retained producers and writes nothing. */
export function assertDedupe(record, baseline) {
  assertDedupeResult(notifications(record, 'dedupe'), baseline);
  assert.equal(notifications(record, 'snapshot').stateSha256, baseline.stateSha256);
}
export function assertDedupeResult(result, baseline) {
  const id = eventId => baseline.receipts.find(r => r.eventId === eventId).id;
  assert.equal(result.fleet, id('nightly-qualification-1'));
  assert.equal(result.messenger, id('nightly-qualification-messenger'));
  assert.equal(result.stateUnchanged, true, 'a duplicate admission does not write');
}

/** What the running Messenger container is bound to: its image, its Notifications volume and its configuration path. */
export function messengerBinding(record) {
  const [c] = JSON.parse(docker(['inspect', messengerContainer(record)]));
  const mount = (c.Mounts ?? []).find(m => m.Destination === STATE_DIR_IN_CONTAINER);
  const declared = (c.HostConfig?.Mounts ?? []).find(m => m.Target === STATE_DIR_IN_CONTAINER);
  const config = (c.Config?.Env ?? []).find(entry => entry.startsWith('OURS_NOTIFICATIONS_CONFIG='));
  return { image: c.Image, volume: mount?.Name ?? null, subpath: declared?.VolumeOptions?.Subpath ?? null, configPath: config ? config.slice(config.indexOf('=') + 1) : null };
}

export function assertBinding(binding, record, snapshot, runtimeImage, label) {
  assert.equal(binding.image, runtimeImage, `${label}: Messenger runs the selected runtime image`);
  assert.equal(binding.volume, `${record.project}_server-storage`, `${label}: Notifications state is the installation volume`);
  if (binding.subpath !== null) assert.equal(binding.subpath, 'state/notifications');
  assert.equal(binding.configPath, `${STATE_DIR_IN_CONTAINER}/config.json`);
  assert.equal(snapshot.configPath, binding.configPath, `${label}: probe read the configuration the service uses`);
  assert.equal(snapshot.stateFile, `${STATE_DIR_IN_CONTAINER}/state.json`, `${label}: configured state file is on that volume`);
}

/**
 * The docker shim's text. Docker really starts the gateway, then its
 * readiness wait reports failure, as a readiness timeout would. Every other
 * call is passed to the real Docker unchanged.
 */
export function readinessFaultShim(realDocker, marker) {
  for (const path of [realDocker, marker]) assert.match(path, /^\/[^'\s]+$/);
  return `#!/bin/sh
case " $* " in
  *" compose "*" up "*" --wait gateway ")
    '${realDocker}' "$@" || exit $?
    printf '%s\\n' "$*" >> '${marker}'
    echo 'Qualification fault: gateway readiness wait reported failure' >&2
    exit 1;;
esac
exec '${realDocker}' "$@"
`;
}

/** An environment whose PATH starts with the readiness-fault docker shim. */
export function readinessFault(root, env) {
  const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8', env }).trim();
  const bin = join(root, 'fault-bin'), marker = join(root, 'injected-readiness-fault');
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.writeFileSync(join(bin, 'docker'), readinessFaultShim(realDocker, marker), { mode: 0o700 });
  return { env: { ...env, PATH: `${bin}:${env.PATH}` }, marker };
}

/**
 * A loopback npm registry for one unpublished installer candidate. The
 * installer's packument is the upstream document plus the candidate version,
 * with dist-tag `nightly` moved to it; the candidate tarball is served from
 * disk. Every other GET is proxied to the upstream registry unchanged. Nothing
 * is ever written upstream: other methods are refused.
 */
export async function startCandidateRegistry({ tarball, manifest, integrity, shasum, tag = 'nightly', upstream = UPSTREAM_REGISTRY }) {
  assert.equal(manifest.name, INSTALLER);
  const bytes = fs.readFileSync(tarball);
  const tarballPath = `/-/qualification-candidate/ours.network-install-${manifest.version}.tgz`;
  const requests = [];
  let base;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(`${req.method} ${url.pathname}`);
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { 'content-type': 'application/json' }); res.end('{"error":"read-only qualification registry"}'); return; }
      if (url.pathname === tarballPath) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
        res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      const response = await fetch(upstream + url.pathname + url.search, { headers: { accept: req.headers.accept ?? 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
      if (decodeURIComponent(url.pathname).toLowerCase() === `/${INSTALLER}`) {
        if (!response.ok) throw new Error(`Upstream installer metadata failed: HTTP ${response.status}`);
        const document = await response.json();
        document.versions = { ...document.versions, [manifest.version]: { ...manifest, _id: `${INSTALLER}@${manifest.version}`, dist: { tarball: base + tarballPath, integrity, shasum } } };
        document['dist-tags'] = { ...document['dist-tags'], [tag]: manifest.version };
        if (document.time) document.time = { ...document.time, [manifest.version]: new Date().toISOString() };
        const body = Buffer.from(JSON.stringify(document));
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : body); return;
      }
      // fetch has already decoded any content encoding.
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream', 'content-length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error.message) }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  return { url: `${base}/`, tarballPath, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** Remove every Compose container, volume, network and project image of these projects; return what remains. */
export function cleanupProjects(projects, { failed }) {
  const quiet = args => { try { return docker(args); } catch (error) { console.error(`docker ${args.join(' ')} failed: ${error.message}`); return ''; } };
  const ids = args => quiet(args).split('\n').map(line => line.trim()).filter(Boolean);
  for (const project of projects) {
    const label = `label=com.docker.compose.project=${project}`;
    if (failed) {
      console.log(quiet(['compose', '--project-name', project, 'ps', '--all']));
      console.log(quiet(['compose', '--project-name', project, 'logs', '--no-color', '--tail', '200']));
    }
    quiet(['compose', '--project-name', project, 'down', '--volumes', '--remove-orphans', '--timeout', '30']);
    for (const id of ids(['ps', '--all', '--quiet', '--filter', label])) quiet(['rm', '--force', '--volumes', id]);
    for (const name of ids(['volume', 'ls', '--quiet', '--filter', label])) quiet(['volume', 'rm', name]);
    for (const id of ids(['network', 'ls', '--quiet', '--filter', label])) quiet(['network', 'rm', id]);
    for (const tag of ids(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=${project}:*`])) quiet(['image', 'rm', '--force', tag]);
  }
  return [...projects].flatMap(project => [
    ...ids(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]),
    ...ids(['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]),
    ...ids(['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]),
    ...ids(['image', 'ls', '--quiet', '--filter', `reference=${project}:*`]),
  ]);
}
