import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Docker conversion commits selection before activation and retries cleanup on the new side', async () => {
  const { convertDockerInstallation } = await import('../lib/docker-layout-installation.mjs');
  const root = fs.mkdtempSync(join(tmpdir(), 'ours-docker-convert-'));
  const source = { schema: 1, mode: 'docker', root, configPath: join(root, 'config.json'),
    workDir: join(root, 'runtime'), sourcesPath: join(root, 'sources.json'), project: 'ours-fixture',
    instanceId: '12345678-1234-1234-1234-123456789abc', services: ['daemon', 'cowork'] };
  let selected = source;
  const events = [];
  let fail = 'prepare';
  const effects = {
    writeJson(path, bytes) { selected = JSON.parse(bytes); fs.writeFileSync(path, bytes); events.push(`record:${selected.schema}`); },
    async selectConversionVolumes() { return { sources: { daemon: 'old-daemon' }, target: 'new-state', targetExists: selected.schema === 2 }; },
    async prepareDockerConversionRuntime() { events.push('runtime'); },
    async serverLifecycle(record, operation, services) {
      events.push(`${operation}:${record.schema}`);
      if (operation === 'status') return ['daemon'];
      if (operation === 'start') {
        assert.equal(selected.schema, 2);
        assert.deepEqual(services, ['daemon', 'cowork']);
        if (fail === 'start') throw new Error('start failed');
      }
    },
    async retireLegacyServices() { assert.ok(selected.layoutConversion); events.push('retire'); },
    async prepareInstallation() { events.push('initialize-volume'); },
    async confirmDockerWritersStopped() { events.push('clean-exit'); if (fail === 'clean-exit') throw new Error('unclean exit'); },
    async runDockerConversion(_record, _volumes, operation) {
      events.push(operation);
      if (fail === operation) throw new Error(`${operation} failed`);
      return operation === 'cleanup' ? { emptyVolumes: ['daemon'] } : undefined;
    },
    async run(_command, args) { assert.deepEqual(args, ['volume', 'rm', 'old-daemon']); events.push('remove-volume'); },
  };
  fs.writeFileSync(source.configPath, '{}', { mode: 0o600 });
  try {
    await assert.rejects(convertDockerInstallation(source, 'start', effects), /prepare failed/);
    assert.equal(selected.schema, 1);
    const backup = selected.layoutConversion.backupPath;
    assert.ok(events.indexOf('record:1') < events.indexOf('retire'));
    assert.equal(events.includes('cleanup'), false);
    fail = 'start';
    await assert.rejects(convertDockerInstallation(selected, 'start', effects), /start failed/);
    assert.equal(selected.schema, 2);
    assert.equal(selected.layoutConversion.backupPath, backup);
    assert.equal(fs.existsSync(source.configPath), true);
    fail = 'clean-exit';
    await assert.rejects(convertDockerInstallation(selected, 'start', effects), /unclean exit/);
    assert.equal(fs.existsSync(source.configPath), true);
    fail = '';
    events.length = 0;
    const result = await convertDockerInstallation(selected, 'start', effects);
    assert.equal(result.layoutConversion, undefined);
    assert.equal(events.includes('prepare'), false);
    assert.ok(events.indexOf('stop:2') < events.indexOf('validate'));
    assert.ok(events.indexOf('start:2') < events.indexOf('cleanup'));
    assert.equal(fs.existsSync(source.configPath), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
