import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { realEffects } from '../lib/effects.mjs';

test('pending package stop accepts either owned layout and stops both daemon states', async () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'ours-pending-stop-'));
  const root = join(home, 'server');
  const sourceRecord = { schema: 1, mode: 'packages', root, configPath: join(root, 'config.json'),
    sourcesPath: join(root, 'sources.json'), workDir: join(root, 'runtime'), project: 'ours-fixture',
    instanceId: '12345678-1234-1234-1234-123456789abc', services: ['daemon', 'cowork'] };
  const record = { ...sourceRecord, schema: 2, configPath: join(root, 'storage/state/daemon/config.json'),
    layoutConversion: { version: 1, sourceRecord, runningServices: ['daemon'], backupPath: join(root, 'storage/backups/conversion') } };
  const unit = join(home, '.config/systemd/user/ours-cowork.service');
  try {
    for (const path of ['data', 'cowork', 'storage/state/daemon', 'storage/state/cowork']) fs.mkdirSync(join(root, path), { recursive: true });
    fs.writeFileSync(sourceRecord.configPath, '{}');
    fs.writeFileSync(join(root, 'cowork/config.json'), '{}');
    fs.mkdirSync(dirname(unit), { recursive: true });
    fs.writeFileSync(unit, `[Service]\nEnvironment="OURS_COWORK_STATE_DIR=${root}/storage/state/cowork"\n`);
    const effects = realEffects({ env: {}, home });
    effects.platform = { platform: 'linux' };
    const calls = [];
    effects.run = async (command, args, options = {}) => {
      calls.push([command, ...args]);
      if (command.endsWith('ours-cowork') && options.env?.OURS_COWORK_CONFIG === join(root, 'cowork/config.json')
        && !fs.existsSync(options.env.OURS_COWORK_CONFIG)) throw new Error('configured cowork config does not exist');
      return { code: args.includes('is-active') ? 3 : args.includes('status') ? (command.endsWith('ours-cowork') ? 6 : 3) : 0, stdout: '' };
    };
    await effects.stopPendingConversion(record);
    const stopped = calls.filter(call => call.includes('stop') && call.includes('--state-dir')).map(call => call[call.indexOf('--state-dir') + 1]);
    assert.deepEqual(stopped, [join(root, 'storage/state/daemon'), join(root, 'data')]);
    assert.equal(calls.some(call => call.includes('start') || call.includes('install-service')), false);
    assert.equal(fs.existsSync(unit), true);
    fs.unlinkSync(join(root, 'cowork/config.json'));
    calls.length = 0;
    await effects.stopPendingConversion(record);
    assert.ok(calls.some(call => call.includes('stop') && call.includes(join(root, 'storage/state/daemon'))));
    assert.equal(fs.existsSync(join(root, 'cowork/config.json')), false);
    fs.writeFileSync(unit, '[Service]\nEnvironment="OURS_COWORK_STATE_DIR=/other/state"\n');
    calls.length = 0;
    await assert.rejects(effects.stopPendingConversion(record), /unrelated existing cowork/);
    assert.deepEqual(calls, []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('conversion removes owned consumer auto-start definitions only after writers stop', async () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'ours-conversion-services-'));
  const root = join(home, 'server');
  const record = {
    schema: 1, root, mode: 'packages', workDir: join(root, 'runtime'),
    configPath: join(root, 'config.json'), project: 'ours-fixture',
    services: ['daemon', 'cowork'], port: 3050, messengerPort: 8420,
  };
  const unit = join(home, '.config/systemd/user/ours-cowork.service');
  const original = `[Service]\nEnvironment="OURS_COWORK_STATE_DIR=${root}/cowork"\n`;
  try {
    fs.mkdirSync(dirname(unit), { recursive: true });
    fs.writeFileSync(unit, original);
    const effects = realEffects({ env: {}, home });
    effects.platform = { platform: 'linux' };
    const calls = [];
    let refuseStop = true;
    effects.run = async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('stop') && refuseStop) throw new Error('writer stop failed');
      return { code: args.includes('is-active') ? 3 : args.includes('status') ? (command.endsWith('ours-cowork') ? 6 : 3) : 0, stdout: '' };
    };
    await assert.rejects(effects.retireLegacyServices(record), /writer stop failed/);
    assert.equal(fs.readFileSync(unit, 'utf8'), original);
    refuseStop = false;
    calls.length = 0;
    await effects.retireLegacyServices(record);
    assert.equal(fs.existsSync(unit), false);
    const disabled = calls.findIndex(call => call.includes('disable'));
    const stopped = calls.findIndex(call => call.includes('stop'));
    assert.ok(disabled >= 0 && disabled < stopped);
    assert.deepEqual(calls.at(-1), ['systemctl', '--user', 'daemon-reload']);
    assert.equal(calls.some(call => call.includes('start') || call.includes('install-service')), false);

    fs.writeFileSync(unit, '[Service]\nEnvironment="OURS_COWORK_STATE_DIR=/other/state"\n');
    calls.length = 0;
    await assert.rejects(effects.retireLegacyServices(record), /unrelated existing cowork/);
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(unit), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Docker conversion removes stopped containers while retaining source volumes', async () => {
  const record = {
    schema: 1, mode: 'docker', root: '/srv/ours', workDir: '/srv/ours/runtime',
    project: 'ours-fixture', services: ['daemon', 'cowork'],
  };
  const effects = realEffects({ env: {}, home: '/tmp' });
  const calls = [];
  let cleanExit = false;
  effects.run = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('inspect')) return {
      code: 0, stdout: JSON.stringify({ Status: 'exited', ExitCode: cleanExit ? 0 : 137, OOMKilled: false, Dead: false }),
    };
    return { code: 0, stdout: args.includes('-aq') ? 'fixture-container\n' : '' };
  };
  await assert.rejects(effects.retireLegacyServices(record), /stop cleanly/);
  assert.equal(calls.some(call => call.includes('rm')), false);
  calls.length = 0;
  cleanExit = true;
  await effects.retireLegacyServices(record);
  const removal = calls.find(call => call.includes('rm'));
  assert.deepEqual(removal.slice(removal.indexOf('rm')), ['rm', '-f', 'daemon', 'cowork']);
  assert.ok(calls.findIndex(call => call.includes('inspect')) < calls.indexOf(removal));
  assert.equal(calls.some(call => call.includes('-v') || call.includes('down') || call.includes('up')), false);
});
