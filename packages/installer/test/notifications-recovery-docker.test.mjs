// Real Compose run of the shipped recovery helper under the state-operation
// service contract: read-only root, non-root user and no /tmp tmpfs (issue #56).
// The toolchain base image stands in for a built maintenance image; this
// checkout's maintenance scripts and build records are fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { realEffects } from '../lib/effects.mjs';
import { readBuildRecords, initializeBuildMarker } from '../assets/scripts/maintenance/build-context.mjs';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const cores = ['daemon', 'telegram', 'cowork', 'messenger'];
function generation(root, name, version) {
  const path = join(root, name); fs.mkdirSync(path, { mode: 0o700 });
  const vendor = '@ours.network/sdk', relativePath = 'docker/vendor/ours.network-sdk.tgz';
  const integrity = 'sha512-' + createHash('sha512').update(name).digest('base64');
  const records = {
    'package-lock.json': Buffer.from(JSON.stringify({ name: 'ours-container-runtime', version: '0.1.0', lockfileVersion: 3, packages: { '': { dependencies: { [vendor]: 'file:' + relativePath } }, ['node_modules/' + vendor]: { version, integrity, resolved: 'file:' + relativePath } } })),
    'dependency-tree.json': Buffer.from(JSON.stringify({ name: 'ours-container-runtime', version: '0.1.0', dependencies: { [vendor]: { version, resolved: 'file:' + join(path, relativePath) } } })),
  };
  records['build-context.json'] = Buffer.from(JSON.stringify({ schema: 1, buildRoot: path, records: Object.fromEntries(Object.entries(records).map(([n, bytes]) => [n, createHash('sha256').update(bytes).digest('hex')])), vendors: [{ name: vendor, version, relativePath, integrity }] }, null, 2) + '\n');
  for (const [file, bytes] of Object.entries(records)) fs.writeFileSync(join(path, file), bytes, { mode: 0o600 });
  return path;
}
function snapshot(root) {
  const entries = {};
  function visit(path, relative) {
    const st = fs.lstatSync(path, { bigint: true });
    entries[relative] = { uid: Number(st.uid), gid: Number(st.gid), mode: Number(st.mode) & 0o7777, ...(st.isFile() ? { bytes: fs.readFileSync(path).toString('base64'), mtime: String(st.mtimeNs) } : {}) };
    if (st.isDirectory()) for (const name of fs.readdirSync(path)) visit(join(path, name), relative + '/' + name);
  }
  visit(root, ''); return entries;
}

test('Docker recovery helper runs under the shipped read-only state-operation contract', { skip: process.env.OURS_TEST_DOCKER !== '1', timeout: 180000 }, async t => {
  // The fixture service below must keep mirroring what installations retain.
  const shipped = fs.readFileSync(join(assets, 'docker-compose.yaml'), 'utf8').match(/\n  state-operation:\n(?:    .*\n)+/)[0];
  for (const line of ['read_only: true', 'network_mode: none', 'cap_drop: [ALL]', 'security_opt: [no-new-privileges:true]', 'user: "${OURS_UID:-1000}:${OURS_GID:-1000}"']) assert.ok(shipped.includes(`    ${line}\n`), line);
  assert.doesNotMatch(shipped, /tmpfs/);
  const image = fs.readFileSync(join(assets, 'Dockerfile'), 'utf8').match(/^FROM (\S+) AS maintenance$/m)[1];

  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ours-notification-recovery-docker-')));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = generation(root, 'previous', '1.0.0'), target = generation(root, 'runtime', '2.0.0');
  const storage = join(root, 'storage'), live = join(storage, 'state'), candidateRoot = join(root, '.build-fixture');
  for (const path of [storage, live, candidateRoot]) fs.mkdirSync(path, { mode: 0o700 });
  fs.cpSync(previous, join(candidateRoot, 'previous-build'), { recursive: true }); fs.chmodSync(join(candidateRoot, 'previous-build'), 0o700);
  for (const name of [...cores, 'notifications', 'mcp', 'credentials']) {
    const directory = join(live, name); fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(join(directory, 'retained'), 'fixture opaque ' + name, { mode: 0o600 });
    if ([...cores, 'notifications'].includes(name)) initializeBuildMarker(join(directory, '.ours-provenance'), readBuildRecords(name === 'notifications' ? previous : target));
  }
  const resolved = createRequire(import.meta.url).resolve('koffi'), modules = resolved.slice(0, resolved.lastIndexOf('/node_modules/koffi/')) + '/node_modules';
  const bind = (source, destination, read_only = true) => ({ type: 'bind', source, target: destination, read_only });
  fs.writeFileSync(join(target, 'docker-compose.yaml'), JSON.stringify({ services: { 'state-operation': {
    image, user: '${OURS_UID}:${OURS_GID}', network_mode: 'none', read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    environment: { OURS_STATE_DOMAIN: '${OURS_STATE_DOMAIN}', OURS_STATE_ROOT: '/storage', OURS_LIVE_ROOT: '${OURS_LIVE_ROOT}', OURS_BUILD_ROOT: target, OURS_COWORK_CLI_PATH: '/usr/bin/true', OURS_COWORK_CONFIG: '/storage/state/cowork/config.json' },
    // Fixture records embed their build root, so it keeps the same path inside the container.
    volumes: [bind(storage, '/storage', false), bind(target, target), bind(join(assets, 'scripts/maintenance'), '/opt/ours/docker'), bind(modules, '/opt/ours/node_modules')],
  } } }), { mode: 0o600 });
  const project = 'ours-recovery-test-' + process.pid;
  const record = { schema: 2, mode: 'docker', root, workDir: target, sourcesPath: join(root, 'sources.json'), configPath: join(live, 'daemon/config.json'), project, instanceId: '12345678-1234-1234-1234-123456789abc', services: cores, uid: process.getuid(), gid: process.getgid() };
  const candidate = { ...record, root: candidateRoot, workDir: join(candidateRoot, 'runtime'), project: project + '-candidate' };
  record.buildTransition = { operation: 'update', compatible: true, phase: 'runtime-activated', candidate, runningServices: [] };
  const effects = realEffects({ env: { ...process.env, OURS_UID: String(record.uid), OURS_GID: String(record.gid) }, home: root, out() {} });

  const before = snapshot(live);
  assert.throws(() => initializeBuildMarker(join(live, 'notifications/.ours-provenance'), readBuildRecords(target)), /existing state provenance differs/);
  assert.equal(await effects.recoverServerBuildNotifications(record, candidate, 'runtime-activated'), true);
  assert.doesNotThrow(() => initializeBuildMarker(join(live, 'notifications/.ours-provenance'), readBuildRecords(target)));
  const strip = entries => Object.fromEntries(Object.entries(entries).filter(([name]) => !name.includes('/notifications/.ours-provenance')));
  assert.deepEqual(strip(snapshot(live)), strip(before));
  assert.equal(fs.readdirSync(join(storage, 'backups')).length, 1);
  // Retry after an interrupted readiness is a verified no-op.
  const repaired = snapshot(storage);
  assert.equal(await effects.recoverServerBuildNotifications(record, candidate, 'runtime-activated'), true);
  assert.deepEqual(snapshot(storage), repaired);
});
