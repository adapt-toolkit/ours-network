import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runStateOperation } from '../assets/scripts/maintenance/state-operation.mjs';
import { readBuildRecords, initializeBuildMarker } from '../assets/scripts/maintenance/build-context.mjs';
import { extractArchive } from '../assets/scripts/maintenance/state-archive.mjs';
import { tryLock } from '../assets/scripts/maintenance/state-native.mjs';
import { serverBuildTransition } from '../lib/build-transition.mjs';
import { realEffects } from '../lib/effects.mjs';

const cores = ['daemon', 'telegram', 'cowork', 'messenger'];
function generation(root, name) {
  const path = join(root, name); fs.mkdirSync(path, { mode: 0o700 });
  const vendor = '@ours.network/sdk', relativePath = 'docker/vendor/ours.network-sdk.tgz';
  const version = name === 'previous' ? '1.0.0' : name === 'target' ? '2.0.0' : '3.0.0';
  const integrity = 'sha512-' + createHash('sha512').update(name).digest('base64');
  const records = {
    'package-lock.json': Buffer.from(JSON.stringify({ name: 'ours-container-runtime', version: '0.1.0', lockfileVersion: 3, packages: { '': { dependencies: { [vendor]: 'file:' + relativePath } }, ['node_modules/' + vendor]: { version, integrity, resolved: 'file:' + relativePath } } })),
    'dependency-tree.json': Buffer.from(JSON.stringify({ name: 'ours-container-runtime', version: '0.1.0', dependencies: { [vendor]: { version, resolved: 'file:' + join(path, relativePath) } } })),
  };
  records['build-context.json'] = Buffer.from(JSON.stringify({ schema: 1, buildRoot: path, records: Object.fromEntries(Object.entries(records).map(([n, bytes]) => [n, createHash('sha256').update(bytes).digest('hex')])), vendors: [{ name: vendor, version, relativePath, integrity }] }, null, 2) + '\n');
  for (const [name, bytes] of Object.entries(records)) fs.writeFileSync(join(path, name), bytes, { mode: 0o600 });
  readBuildRecords(path, { privateFiles: true });
  return path;
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ours-notification-recovery-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = generation(root, 'previous'), target = generation(root, 'target'), third = generation(root, 'third');
  const live = join(root, 'live'); fs.mkdirSync(live, { mode: 0o700 });
  for (const name of [...cores, 'notifications', 'mcp', 'credentials']) {
    const directory = join(live, name); fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(join(directory, 'retained'), 'fixture opaque ' + name, { mode: 0o600 });
    fs.utimesSync(join(directory, 'retained'), 1000000000, 1000000000);
    if ([...cores, 'notifications'].includes(name)) initializeBuildMarker(join(directory, '.ours-provenance'), readBuildRecords(name === 'notifications' ? previous : target));
  }
  const env = { ...process.env, OURS_STATE_ROOT: root, OURS_LIVE_ROOT: live, OURS_BUILD_ROOT: target, OURS_STATE_DOMAIN: 'server', OURS_PREVIOUS_BUILD_ROOT: previous, OURS_EXPECTED_BUILD_ROOT: target, OURS_COWORK_CLI_PATH: '/usr/bin/true', OURS_COWORK_CONFIG: join(live, 'cowork/config.json') };
  const run = checkpoints => runStateOperation(['recover-notifications', 'server', '--compatible'], env, checkpoints);
  return { root, previous, target, third, live, env, run };
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

test('recovery binds all three records, preserves payload metadata and creates an honest Notifications archive', async t => {
  const f = fixture(t), before = snapshot(f.live);
  assert.throws(() => initializeBuildMarker(join(f.live, 'notifications/.ours-provenance'), readBuildRecords(f.target)), /existing state provenance differs/);
  await assert.rejects(runStateOperation(['update', 'server', '--compatible'], f.env), /provenance/);
  await f.run();
  const after = snapshot(f.live);
  for (const [path, entry] of Object.entries(before)) if (!path.startsWith('/notifications/.ours-provenance')) assert.deepEqual(after[path], entry, path);
  assert.doesNotThrow(() => initializeBuildMarker(join(f.live, 'notifications/.ours-provenance'), readBuildRecords(f.target)));
  const backups = fs.readdirSync(join(f.root, 'backups'));
  assert.equal(backups.length, 1);
  const restored = join(f.root, 'restored');
  await extractArchive(join(f.root, 'backups', backups[0]), restored, { domain: 'notifications', uid: process.getuid(), gid: process.getgid(), provenance: readBuildRecords(f.previous) });
  assert.deepEqual(snapshot(restored), Object.fromEntries(Object.entries(before).filter(([p]) => p === '/notifications' || p.startsWith('/notifications/')).map(([p, entry]) => [p.slice('/notifications'.length), entry])));
  await f.run(); assert.equal(fs.readdirSync(join(f.root, 'backups')).length, 1);
});

for (const point of ['beforeBackup', 'afterBackup', 'beforeExchange', 'afterExchange']) test(`recovery interruption at ${point} preserves a retryable generation`, async t => {
  const f = fixture(t), original = snapshot(f.live);
  await assert.rejects(f.run({ [point]() { throw new Error('fixture interruption'); } }), /fixture interruption/);
  if (point !== 'afterExchange') assert.deepEqual(snapshot(f.live), original);
  else assert.doesNotThrow(() => initializeBuildMarker(join(f.live, 'notifications/.ours-provenance'), readBuildRecords(f.target)));
  await f.run();
  assert.doesNotThrow(() => initializeBuildMarker(join(f.live, 'notifications/.ours-provenance'), readBuildRecords(f.target)));
  for (const name of [...cores, 'notifications', 'mcp', 'credentials']) assert.equal(fs.readFileSync(join(f.live, name, 'retained'), 'utf8'), 'fixture opaque ' + name);
});

const invalid = {
  'third notification generation': f => { fs.rmSync(join(f.live, 'notifications/.ours-provenance'), { recursive: true }); initializeBuildMarker(join(f.live, 'notifications/.ours-provenance'), readBuildRecords(f.third)); },
  'unmigrated core': f => { fs.rmSync(join(f.live, 'telegram/.ours-provenance'), { recursive: true }); initializeBuildMarker(join(f.live, 'telegram/.ours-provenance'), readBuildRecords(f.previous)); },
  'partial notification records': f => fs.unlinkSync(join(f.live, 'notifications/.ours-provenance/dependency-tree.json')),
  'extra notification records': f => fs.writeFileSync(join(f.live, 'notifications/.ours-provenance/extra'), '{}', { mode: 0o600 }),
  'context digest mismatch': f => fs.appendFileSync(join(f.live, 'notifications/.ours-provenance/package-lock.json'), ' '),
  'unsafe marker mode': f => fs.chmodSync(join(f.live, 'notifications/.ours-provenance'), 0o755),
  'unsafe record mode': f => fs.chmodSync(join(f.live, 'notifications/.ours-provenance/build-context.json'), 0o644),
  'symlink notification marker': f => { fs.rmSync(join(f.live, 'notifications/.ours-provenance'), { recursive: true }); fs.symlinkSync(f.previous, join(f.live, 'notifications/.ours-provenance')); },
  'symlink application payload': f => fs.symlinkSync(f.previous, join(f.live, 'notifications/link')),
  'target differs from runtime': f => { f.env.OURS_EXPECTED_BUILD_ROOT = f.third; },
  'previous evidence differs': f => { f.env.OURS_PREVIOUS_BUILD_ROOT = f.third; },
  'missing previous context': f => fs.unlinkSync(join(f.previous, 'build-context.json')),
  'partial target evidence': f => fs.unlinkSync(join(f.target, 'dependency-tree.json')),
};
for (const [name, corrupt] of Object.entries(invalid)) test(`recovery rejects ${name} without publication`, async t => {
  const f = fixture(t); corrupt(f); const before = snapshot(f.live);
  await assert.rejects(f.run()); assert.deepEqual(snapshot(f.live), before);
});

test('recovery refuses the active state lock', async t => {
  const f = fixture(t), before = snapshot(f.live), fd = fs.openSync(f.live, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { assert.equal(tryLock(fd), true); await assert.rejects(f.run(), /already in use/); }
  finally { fs.closeSync(fd); }
  assert.deepEqual(snapshot(f.live), before);
});

for (const phase of ['prepared', 'state-updated', 'runtime-activated']) test(`pending ${phase} recovery retains the candidate and retries readiness`, async t => {
  const f = fixture(t), candidateRoot = fs.mkdtempSync(join(f.root, '.build-'));
  const base = { schema: 2, mode: 'docker', root: f.root, workDir: join(f.root, 'runtime'), sourcesPath: join(f.root, 'sources.json'), configPath: join(f.root, 'storage/state/daemon/config.json'), project: 'ours-fixture', instanceId: '12345678-1234-1234-1234-123456789abc', services: cores, gateway: { port: 4050 } };
  // No gateway schema is needed for this journal fixture; prepareVolumes uses the actual startup gate.
  delete base.gateway;
  const candidate = { ...base, root: candidateRoot, workDir: join(candidateRoot, 'runtime'), sourcesPath: join(candidateRoot, 'sources.json'), configPath: join(candidateRoot, 'storage/state/daemon/config.json'), project: 'ours-build' + 'a'.repeat(32) };
  let record = { ...base, buildTransition: { phase, operation: 'update', compatible: true, candidate, runningServices: ['daemon'] } }, ready = false;
  const events = [], effects = {
    out() {}, writeJson(_path, json) { record = JSON.parse(json); },
    retireServerBuildRuntime: async () => events.push('stop'),
    recoverServerBuildNotifications: async (_r, selected, selectedPhase) => { assert.equal(selected.root, candidate.root); assert.ok(['prepared', 'state-updated', 'runtime-activated'].includes(selectedPhase)); events.push('recover'); return (await f.run()).stateUpdated; },
    updateServerBuildState: async () => assert.fail('Already-exchanged prepared state must not produce a mixed-generation backup'),
    publishServerBuild: async () => events.push('activate'),
    validateServerBuildState: async () => { initializeBuildMarker(join(f.live, 'notifications/.ours-provenance'), readBuildRecords(f.target)); events.push('validate'); },
    serverLifecycle: async (_r, op, selected) => { assert.equal(op, 'start'); assert.deepEqual(selected, ['daemon']); events.push('start'); if (!ready) throw new Error('readiness failed'); },
    discardServerBuild: async () => events.push('discard'),
  };
  await assert.rejects(serverBuildTransition(record, { operation: 'update' }, effects), /readiness failed/);
  assert.equal(record.buildTransition.phase, 'runtime-activated'); assert.equal(record.buildTransition.candidate.root, candidateRoot);
  assert.equal(events.includes('discard'), false);
  ready = true; await serverBuildTransition(record, { operation: 'update' }, effects);
  assert.equal(record.buildTransition, undefined); assert.equal(events.at(-1), 'discard');
  assert.equal(fs.readdirSync(join(f.root, 'backups')).length, 1);
});

test('retained helper stdin transport admits exact records without argument-size limits', async t => {
  const f = fixture(t), encode = path => Object.fromEntries(Object.entries(readBuildRecords(path)).map(([n, bytes]) => [n, bytes.toString('base64')]));
  const input = JSON.stringify({ phase: 'runtime-activated', previous: encode(f.previous), target: encode(f.target) });
  const helper = new URL('../assets/scripts/maintenance/recover-notifications.mjs', import.meta.url);
  execFileSync(process.execPath, [helper.pathname], { input, env: f.env });
  assert.doesNotThrow(() => initializeBuildMarker(join(f.live, 'notifications/.ours-provenance'), readBuildRecords(f.target)));
  const effects = realEffects({ env: {}, home: f.root, out() {} });
  const result = await effects.run(process.execPath, ['-e', 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>process.stdout.write(String(b.length)))'], { input: 'x'.repeat(300000) });
  assert.equal(result.stdout, '300000');
});

// The shipped state-operation service is read_only without a /tmp tmpfs (issue #56 follow-up).
test('retained helper stages evidence in memory when the temporary directory is not writable', { skip: process.platform !== 'linux' || process.getuid() === 0 || !fs.existsSync('/dev/shm') }, async t => {
  const f = fixture(t), encode = path => Object.fromEntries(Object.entries(readBuildRecords(path)).map(([n, bytes]) => [n, bytes.toString('base64')]));
  const input = JSON.stringify({ phase: 'runtime-activated', previous: encode(f.previous), target: encode(f.target) });
  const helper = new URL('../assets/scripts/maintenance/recover-notifications.mjs', import.meta.url);
  const staged = () => fs.readdirSync('/dev/shm').filter(name => name.startsWith('ours-notifications-recovery-'));
  const before = staged();
  for (const TMPDIR of [join(f.root, 'read-only-tmp'), join(f.root, 'missing-tmp')]) {
    if (TMPDIR.endsWith('read-only-tmp')) fs.mkdirSync(TMPDIR, { mode: 0o500 });
    assert.throws(() => fs.mkdtempSync(join(TMPDIR, 'probe-')), /EACCES|ENOENT/);
    const result = JSON.parse(execFileSync(process.execPath, [helper.pathname], { input, env: { ...f.env, TMPDIR }, encoding: 'utf8' }));
    assert.deepEqual(result, { stateUpdated: true });
    assert.deepEqual(staged(), before);
  }
  assert.doesNotThrow(() => initializeBuildMarker(join(f.live, 'notifications/.ours-provenance'), readBuildRecords(f.target)));
  assert.equal(fs.readdirSync(join(f.root, 'backups')).length, 1);
  // Rejected evidence still fails closed and leaves no staged records behind.
  assert.throws(() => execFileSync(process.execPath, [helper.pathname], { input: JSON.stringify({ phase: 'unknown', previous: {}, target: {} }), env: { ...f.env, TMPDIR: join(f.root, 'missing-tmp') }, stdio: 'pipe' }));
  assert.deepEqual(staged(), before);
});

for (const state of ['absent', 'empty', 'current']) test(`recovery preserves supported ${state} Notifications markers`, async t => {
  const f = fixture(t), marker = join(f.live, 'notifications/.ours-provenance');
  fs.rmSync(marker, { recursive: true });
  if (state === 'empty') fs.mkdirSync(marker, { mode: 0o700 });
  if (state === 'current') initializeBuildMarker(marker, readBuildRecords(f.target));
  const before = snapshot(f.live);
  assert.deepEqual(await f.run(), { stateUpdated: true });
  assert.deepEqual(snapshot(f.live), before);
  assert.equal(fs.existsSync(join(f.root, 'backups')), false);
});

test('prepared untouched source state remains unchanged for normal migration; mixed core fails', async t => {
  const f = fixture(t); f.env.OURS_RECOVERY_PHASE = 'prepared';
  for (const name of cores) { fs.rmSync(join(f.live, name, '.ours-provenance'), { recursive: true }); initializeBuildMarker(join(f.live, name, '.ours-provenance'), readBuildRecords(f.previous)); }
  const before = snapshot(f.live);
  assert.deepEqual(await f.run(), { stateUpdated: false }); assert.deepEqual(snapshot(f.live), before);
  fs.rmSync(join(f.live, 'daemon/.ours-provenance'), { recursive: true }); initializeBuildMarker(join(f.live, 'daemon/.ours-provenance'), readBuildRecords(f.target));
  const mixed = snapshot(f.live); await assert.rejects(f.run(), /core provenance/); assert.deepEqual(snapshot(f.live), mixed);
});

for (const [operation, compatible] of [['update', false], ['rebuild', false], ['rebuild', true]]) test(`recovery does not escalate ${operation} compatibility=${compatible}`, async t => {
  const f = fixture(t), candidateRoot = fs.mkdtempSync(join(f.root, '.build-'));
  const base = { schema: 2, mode: 'docker', root: f.root, workDir: join(f.root, 'runtime'), sourcesPath: join(f.root, 'sources.json'), configPath: join(f.root, 'storage/state/daemon/config.json'), project: 'ours-fixture', instanceId: '12345678-1234-1234-1234-123456789abc', services: cores };
  const candidate = { ...base, root: candidateRoot, workDir: join(candidateRoot, 'runtime'), sourcesPath: join(candidateRoot, 'sources.json'), configPath: join(candidateRoot, 'storage/state/daemon/config.json'), project: 'ours-build' + 'a'.repeat(32) };
  const record = { ...base, buildTransition: { phase: 'runtime-activated', operation, compatible, candidate, runningServices: ['daemon'] } };
  const effects = realEffects({ env: {}, home: f.root, out() {} });
  effects.run = async () => assert.fail('Unauthorized recovery reached transport');
  await assert.rejects(effects.recoverServerBuildNotifications(record, candidate, 'runtime-activated'), /retained compatible Docker update/);
  const before = snapshot(f.live);
  await assert.rejects(serverBuildTransition(record, { operation, compatible: true }, {
    retireServerBuildRuntime: async () => {}, recoverServerBuildNotifications: async () => assert.fail('Recorded attestation must not escalate'),
    validateServerBuildState: async () => initializeBuildMarker(join(f.live, 'notifications/.ours-provenance'), readBuildRecords(f.target)),
  }), /existing state provenance differs/);
  assert.deepEqual(snapshot(f.live), before);
});

for (const boundary of ['old-runtime-retained', 'candidate-moved']) test(`recovery preserves publication retry after ${boundary}`, async t => {
  const f = fixture(t), candidateRoot = fs.mkdtempSync(join(f.root, '.build-'));
  const base = { schema: 2, mode: 'docker', root: f.root, workDir: join(f.root, 'runtime'), sourcesPath: join(f.root, 'sources.json'), configPath: join(f.root, 'storage/state/daemon/config.json'), project: 'ours-fixture', instanceId: '12345678-1234-1234-1234-123456789abc', services: cores };
  const candidate = { ...base, root: candidateRoot, workDir: join(candidateRoot, 'runtime'), sourcesPath: join(candidateRoot, 'sources.json'), configPath: join(candidateRoot, 'storage/state/daemon/config.json'), project: 'ours-build' + 'a'.repeat(32) };
  for (const path of [base.workDir, candidate.workDir]) fs.mkdirSync(path, { mode: 0o700 });
  fs.mkdirSync(join(candidateRoot, 'previous-build'), { mode: 0o700 });
  for (const [name, bytes] of Object.entries(readBuildRecords(f.previous))) fs.writeFileSync(join(candidateRoot, 'previous-build', name), bytes, { mode: 0o600 });
  for (const [name, bytes] of Object.entries(readBuildRecords(f.target))) fs.writeFileSync(join(candidate.workDir, name), bytes, { mode: 0o600 });
  fs.writeFileSync(join(base.workDir, 'previous.fixture'), 'protected previous runtime', { mode: 0o600 });
  fs.writeFileSync(base.sourcesPath, '{}', { mode: 0o600 }); fs.writeFileSync(candidate.sourcesPath, '{"target":true}', { mode: 0o600 });
  fs.renameSync(base.workDir, join(candidateRoot, 'previous-runtime'));
  if (boundary === 'candidate-moved') fs.renameSync(candidate.workDir, base.workDir);
  let record = { ...base, buildTransition: { phase: 'state-updated', operation: 'update', compatible: true, candidate, runningServices: ['daemon'] } };
  const effects = realEffects({ env: {}, home: f.root, out() {} });
  effects.retireServerBuildRuntime = async () => {};
  let transports = 0;
  effects.run = async (command, args, options) => {
    assert.equal(command, 'docker');
    if (args.includes('--input-type=module')) {
      transports++;
      assert.equal(args[args.indexOf('--project-directory') + 1], boundary === 'candidate-moved' ? base.workDir : candidate.workDir);
      assert.equal(options.env.OURS_MAINTENANCE_IMAGE, candidate.project + ':maintenance');
      const evidence = JSON.parse(options.input); assert.equal(evidence.phase, 'state-updated');
      for (const [name, bytes] of Object.entries(readBuildRecords(f.target))) assert.deepEqual(Buffer.from(evidence.target[name], 'base64'), bytes);
      return { stdout: JSON.stringify(await f.run()), code: 0 };
    }
    return { code: 0, stdout: '' }; // Docker immutable image tagging is irrelevant to this filesystem boundary.
  };
  effects.writeJson = (_p, json) => { record = JSON.parse(json); };
  effects.validateServerBuildState = async () => initializeBuildMarker(join(f.live, 'notifications/.ours-provenance'), readBuildRecords(f.target));
  effects.serverLifecycle = async () => {};
  effects.discardServerBuild = async () => {};
  await serverBuildTransition(record, { operation: 'update' }, effects);
  assert.equal(transports, 1); assert.equal(record.buildTransition, undefined);
  assert.equal(fs.existsSync(candidate.workDir), false);
  assert.equal(fs.readFileSync(join(candidateRoot, 'previous-runtime/previous.fixture'), 'utf8'), 'protected previous runtime');
  assert.equal(fs.readFileSync(base.sourcesPath, 'utf8'), '{"target":true}');
});

test('recovery retains accepted readable descendants and directory timestamps', async t => {
  const f = fixture(t), nested = join(f.live, 'notifications/accepted');
  fs.mkdirSync(nested, { mode: 0o755 }); fs.chmodSync(nested, 0o755);
  fs.writeFileSync(join(nested, 'data'), 'opaque accepted read-only payload', { mode: 0o644 }); fs.chmodSync(join(nested, 'data'), 0o644);
  fs.utimesSync(nested, 1000000000, 1000000000); fs.utimesSync(join(f.live, 'notifications'), 1000000001, 1000000001);
  const before = snapshot(f.live);
  const timestamps = [f.live, join(f.live, 'notifications'), nested].map(p => String(fs.lstatSync(p, { bigint: true }).mtimeNs));
  await f.run();
  const after = snapshot(f.live);
  for (const [path, entry] of Object.entries(before)) if (!path.startsWith('/notifications/.ours-provenance')) assert.deepEqual(after[path], entry, path);
  assert.deepEqual([f.live, join(f.live, 'notifications'), nested].map(p => String(fs.lstatSync(p, { bigint: true }).mtimeNs)), timestamps);
});
