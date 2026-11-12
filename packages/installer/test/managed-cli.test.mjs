import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import vm from 'node:vm';
import { buildManagedCli } from '../lib/managed-cli.mjs';

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
