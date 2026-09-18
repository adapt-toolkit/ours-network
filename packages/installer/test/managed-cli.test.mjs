import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readlinkSync, rmSync, chmodSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as path from 'node:path';
import vm from 'node:vm';
import { buildManagedCli, inspectManagedCli, installManagedCli } from '../lib/managed-cli.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'managed-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prefix = join(dir, 'prefix');
  const npmRoot = join(prefix, 'lib/node_modules');
  const pkg = join(npmRoot, '@ours.network/cli');
  const binPath = join(prefix, 'bin/ours');
  const originalProgram = join(pkg, 'dist/cli.js');
  const root = join(dir, 'managed');
  mkdirSync(dirname(originalProgram), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(binPath), { recursive: true, mode: 0o700 });
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@ours.network/cli', bin: { ours: 'dist/cli.js' } }), { mode: 0o600 });
  writeFileSync(originalProgram, '#!/usr/bin/env node\n// original package CLI\n', { mode: 0o700 });
  const link = '../lib/node_modules/@ours.network/cli/dist/cli.js';
  symlinkSync(link, binPath);
  const effects = { platform: { platform: 'linux' }, async run(command, args) {
    const key = [command, ...args].join(' ');
    const outputs = { 'npm root --global': npmRoot, 'npm prefix --global': prefix, 'which ours': binPath };
    assert.ok(outputs[key], `unexpected command ${key}`);
    return { code: 0, stdout: `${outputs[key]}\n` };
  } };
  return { effects, root, binPath, originalProgram, link, backup: join(root, 'legacy-backup/managed-cli-original.json') };
}

test('verified npm CLI cutover retains its original program and supports retry', async t => {
  const f = fixture(t);
  const original = readFileSync(f.originalProgram);
  const plan = await inspectManagedCli(f.effects, f.root);
  assert.equal(plan.originalProgram, f.originalProgram);
  assert.equal(plan.binPath, f.binPath);
  const retainedInstaller = join(f.root, 'retained-install.mjs');
  writeFileSync(retainedInstaller, '// fixture retained installer', { mode: 0o600 });
  plan.installerPath = retainedInstaller;
  assert.equal((await installManagedCli({ root: f.root }, plan, f.effects)).changed, true);
  assert.equal(lstatSync(f.binPath).isSymbolicLink(), false);
  assert.match(readFileSync(f.binPath, 'utf8'), /ours-managed-cli-v1/);
  assert.deepEqual(readFileSync(f.originalProgram), original);
  const backup = JSON.parse(readFileSync(f.backup));
  assert.equal(backup.original.link, f.link);
  const retry = await inspectManagedCli(f.effects, f.root);
  assert.equal(retry.installed, true);
  assert.equal(retry.installerPath, retainedInstaller);
  assert.equal((await installManagedCli({ root: f.root }, retry, f.effects)).changed, false);
});

test('failed atomic publication leaves the old selection usable and retries with the original backup', async t => {
  const f = fixture(t);
  const plan = await inspectManagedCli(f.effects, f.root);
  await assert.rejects(installManagedCli({ root: f.root }, plan, f.effects, { rename() { throw new Error('fixture rename failure'); } }), /fixture rename failure/);
  assert.equal(readlinkSync(f.binPath), f.link);
  const backup = readFileSync(f.backup);
  await installManagedCli({ root: f.root }, plan, f.effects);
  assert.deepEqual(readFileSync(f.backup), backup);
});

test('npm reinstall can be repaired without replacing the first recovery backup', async t => {
  const f = fixture(t);
  await installManagedCli({ root: f.root }, await inspectManagedCli(f.effects, f.root), f.effects);
  const backup = readFileSync(f.backup);
  rmSync(f.binPath);
  writeFileSync(f.originalProgram, '#!/usr/bin/env node\n// updated npm package CLI\n');
  symlinkSync(f.link, f.binPath);
  const plan = await inspectManagedCli(f.effects, f.root);
  assert.equal(plan.installed, false);
  await installManagedCli({ root: f.root }, plan, f.effects);
  assert.deepEqual(readFileSync(f.backup), backup);
});

test('foreign PATH selection, foreign symlink, and readonly bin directories fail preflight', async t => {
  const f = fixture(t);
  const foreignEffects = { ...f.effects, run: async (command, args) => command === 'which' ? { code: 0, stdout: '/other/bin/ours\n' } : f.effects.run(command, args) };
  await assert.rejects(inspectManagedCli(foreignEffects, f.root), /PATH selects another/);
  rmSync(f.binPath); symlinkSync('/bin/sh', f.binPath);
  await assert.rejects(inspectManagedCli(f.effects, f.root), /does not target/);
  rmSync(f.binPath); symlinkSync(f.link, f.binPath);
  chmodSync(dirname(f.binPath), 0o500);
  try { await assert.rejects(inspectManagedCli(f.effects, f.root), /read-only/); }
  finally { chmodSync(dirname(f.binPath), 0o700); }
});

test('a changed global command is never overwritten after preflight', async t => {
  const f = fixture(t);
  const plan = await inspectManagedCli(f.effects, f.root);
  writeFileSync(f.originalProgram, 'changed package content');
  await assert.rejects(installManagedCli({ root: f.root }, plan, f.effects), /changed after inspection/);
  assert.equal(readlinkSync(f.binPath), f.link);
});

function launch(args, { mode = 'packages', result = { status: 0 } } = {}) {
  const root = '/private/managed';
  const recordPath = `${root}/installation.json`;
  const installer = '/private/installer/install.mjs';
  const record = { schema: 2, root, mode, instanceId: '11111111-2222-3333-4444-555555555555', port: 3050,
    workDir: `${root}/runtime`, configPath: `${root}/storage/state/daemon/config.json`, project: 'ours-fixture' };
  const calls = [], errors = [], signals = [];
  let status;
  const done = new Error('exit sentinel');
  const process = { argv: ['node', '/prefix/bin/ours', ...args], execPath: '/node', env: { PATH: '/bin', OURS_STATE_DIR: '/old', OURS_DAEMON_ID: 'old', OURS_ENDPOINT: 'old' },
    getuid: () => 123, pid: 456, exit(code) { status = code; throw done; }, kill(pid, signal) { signals.push({ pid, signal }); throw done; } };
  const require = name => ({
    'node:fs': { lstatSync: () => ({ isFile: () => true, nlink: 1, uid: 123, mode: 0o600 }), realpathSync: () => recordPath, readFileSync: () => JSON.stringify(record) },
    'node:path': path,
    'node:child_process': { spawnSync(command, args, options) { calls.push({ command, args, options }); return result; } },
  })[name];
  try { vm.runInNewContext(buildManagedCli(recordPath, installer), { require, process, console: { error: message => errors.push(message) } }); }
  catch (error) { if (error !== done) throw error; }
  return { record, calls, errors, status, signals, installer };
}

test('default native ours uses managed state, UUID, inherited stdio, and exact argument boundaries', () => {
  const r = launch(['identity', 'show', 'name with spaces'], { result: { status: 7 } });
  assert.equal(r.status, 7);
  assert.equal(r.calls[0].command, `${r.record.workDir}/node_modules/.bin/ours`);
  assert.deepEqual(Array.from(r.calls[0].args), ['identity', 'show', 'name with spaces', '--config', r.record.configPath, '--state-dir', `${r.record.root}/storage/state/daemon`]);
  assert.equal(r.calls[0].options.env.OURS_DAEMON_ID, r.record.instanceId);
  assert.equal(r.calls[0].options.env.OURS_ENDPOINT, undefined);
  assert.equal(r.calls[0].options.stdio, 'inherit');
});

test('default Docker ours executes in the selected daemon container without ambient host selection', () => {
  const r = launch(['identity', 'list', '--json'], { mode: 'docker' });
  assert.equal(r.calls[0].command, 'docker');
  assert.deepEqual(Array.from(r.calls[0].args), ['exec', '-i', 'ours-fixture-daemon-1', 'node', '/opt/ours/node_modules/@ours.network/cli/dist/cli.js', 'identity', 'list', '--json', '--config', '/var/lib/ours/config.json', '--state-dir', '/var/lib/ours']);
  assert.equal(Object.keys(r.calls[0].options.env).some(key => key.startsWith('OURS_')), false);
  assert.equal(r.calls[0].options.stdio, 'inherit');
});

test('daemon lifecycle routes through installer, and bypasses and selection overrides are rejected', () => {
  for (const verb of ['start', 'stop', 'restart', 'status']) {
    const r = launch(['daemon', verb, ...(verb === 'status' ? ['--json'] : [])]);
    assert.equal(r.calls[0].command, '/node');
    assert.deepEqual(Array.from(r.calls[0].args), [r.installer, 'server', verb, '--state-dir', r.record.root]);
  }
  for (const args of [['daemon', 'start', '--json'], ['daemon', 'serve'], ['daemon', 'install-service'], ['daemon', '--json', 'stop'], ['config', 'set'], ['identity', 'list', '--endpoint=https://other'], ['identity', 'list', '--state-dir', '/old']]) {
    const r = launch(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.calls.length, 0);
  }
});

test('version retains its own flags and child signals propagate', () => {
  const version = launch(['version', '--json']);
  assert.deepEqual(Array.from(version.calls[0].args), ['version', '--json']);
  const signal = launch(['identity', 'list'], { result: { status: null, signal: 'SIGINT' } });
  assert.deepEqual(signal.signals, [{ pid: 456, signal: 'SIGINT' }]);
});
