import test from 'node:test';
import assert from 'node:assert/strict';
import { runInstall } from '../lib/orchestrate.mjs';
import { fx } from './fake-effects.mjs';

test('pending conversion refuses unrelated mutations and status reports the selected side', async () => {
  const sourceRecord = {
    schema: 1, mode: 'packages', root: '/srv/ours', configPath: '/srv/ours/config.json',
    sourcesPath: '/srv/ours/sources.json', workDir: '/srv/ours/runtime', project: 'ours-fixture',
    instanceId: '12345678-1234-1234-1234-123456789abc', services: ['daemon', 'cowork'],
  };
  for (const schema of [1, 2]) {
    const record = {
      ...sourceRecord, schema,
      configPath: schema === 1 ? sourceRecord.configPath : '/srv/ours/storage/state/daemon/config.json',
      layoutConversion: {
        version: 1, sourceRecord, backupPath: '/srv/ours/storage/backups/conversion', runningServices: ['daemon'],
      },
    };
    const effects = fx({ json: { '/srv/ours/installation.json': record } });
    const events = [];
    effects.serverPreflight = async () => {};
    effects.serverAccess = async () => { events.push('access'); };
    effects.serverMaintenance = async () => { events.push('maintenance'); };
    effects.stopPendingConversion = async selected => {
      assert.equal(selected, record);
      events.push('stop-pending');
    };
    effects.serverLifecycle = async (_record, operation) => {
      events.push(operation);
      return [];
    };
    for (const operation of [
      ['access-issue', '--output', '/tmp/token'], ['access-replace', '--confirm'],
      ['backup', 'server', 'snapshot'], ['restore', 'server', 'snapshot'], ['reset', 'daemon', '--confirm'],
    ]) {
      assert.equal(await runInstall(['server', ...operation, '--state-dir', record.root], effects), 2);
    }
    assert.deepEqual(events, []);
    assert.match(effects.recorder.out.join('\n'), /conversion.*(install|start)/i);
    effects.recorder.out.length = 0;
    assert.equal(await runInstall(['server', 'status', '--state-dir', record.root], effects), 0);
    assert.deepEqual(events, ['status']);
    const status = JSON.parse(effects.recorder.out.find(line => line.startsWith('{')));
    assert.equal(status.layoutConversion, schema === 1 ? 'preparation-pending' : 'activation-pending');
    assert.equal(status.schema, schema);
    events.length = 0;
    assert.equal(await runInstall(['server', 'stop', '--state-dir', record.root], effects), 0);
    assert.deepEqual(events, ['stop-pending']);
    assert.deepEqual(effects.recorder.wrote, []);
  }
});

test('managed setup enters conversion without issuing replacement credentials', async () => {
  for (const mode of ['packages', 'docker']) {
    const record = {
      schema: 1, mode, root: '/srv/ours', configPath: '/srv/ours/config.json',
      sourcesPath: '/srv/ours/sources.json', workDir: '/srv/ours/runtime', project: 'ours-fixture',
      instanceId: '12345678-1234-1234-1234-123456789abc', services: ['daemon', 'cowork'],
    };
    for (const operation of ['install', 'start', 'restart']) {
      const effects = fx({ json: { '/srv/ours/installation.json': record } });
      const events = [];
      effects.serverPreflight = async () => {};
      effects[mode === 'packages' ? 'convertPackageInstallation' : 'convertDockerInstallation'] = async (source, selectedOperation) => {
        assert.equal(source, record);
        events.push(selectedOperation);
        return { ...record, schema: 2, configPath: '/srv/ours/storage/state/daemon/config.json' };
      };
      effects.serverAccess = async () => { throw new Error('conversion must not issue credentials'); };
      assert.equal(await runInstall(['server', operation, '--state-dir', record.root], effects), 0);
      assert.deepEqual(events, [operation]);
    }
  }
});
