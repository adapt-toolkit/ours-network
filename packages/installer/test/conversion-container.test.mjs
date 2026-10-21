import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realEffects } from '../lib/effects.mjs';

test('conversion container uses named sources and switches owner mounts after publication', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ours-conversion-container-'));
  const record = { root, project: 'ours-fixture', uid: 1000, gid: 1000, instanceId: '12345678-1234-1234-1234-123456789abc' };
  const volumes = { target: 'ours-fixture_server-storage', sources: Object.fromEntries(
    ['daemon', 'cowork', 'telegram', 'messenger', 'cowork-credential', 'telegram-credential', 'messenger-credential']
      .map(name => [name, `ours-fixture_${name}`])) };
  const effects = realEffects({ env: {}, home: root });
  const definitions = [];
  effects.run = async (_command, args) => {
    definitions.push(JSON.parse(fs.readFileSync(args[args.indexOf('--file') + 1])));
    assert.ok(args.includes('--rm'));
    return { code: 0, stdout: args.includes('cleanup') ? '{"emptyVolumes":["daemon"]}' : '' };
  };
  try {
    await effects.runDockerConversion(record, volumes, 'prepare', 'original');
    await effects.runDockerConversion(record, volumes, 'validate');
    assert.deepEqual(await effects.runDockerConversion(record, volumes, 'cleanup'), { emptyVolumes: ['daemon'] });
    const [before, after] = definitions.map(value => value.services['state-operation']);
    const mount = (service, target) => service.volumes.find(value => value.target === target);
    assert.equal(mount(before, '/var/lib/ours').source, 'source-daemon');
    assert.equal(mount(before, '/var/lib/ours').volume.subpath, 'data');
    assert.equal(mount(before, '/var/lib/ours').read_only, true);
    assert.equal(mount(before, '/var/lib/ours-cowork').read_only, false);
    assert.equal(mount(after, '/var/lib/ours-cowork').source, 'storage');
    assert.equal(mount(after, '/var/lib/ours-cowork').volume.subpath, 'state/cowork');
    const cleanup = definitions[2].services['state-operation'];
    assert.equal(mount(cleanup, '/var/lib/ours'), undefined);
    assert.equal(mount(cleanup, '/source/daemon').read_only, false);
    assert.ok(definitions.every(value => Object.values(value.volumes).every(volume => volume.external === true)));
    assert.ok(definitions.every(value => value.services['state-operation'].volumes.every(volume => volume.type === 'volume')));
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a collaboration-tools installation validates only its daemon state after an update', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ours-conversion-plugin-only-'));
  const effects = realEffects({ env: {}, home: root });
  const definitions = [];
  effects.run = async (_command, args) => { definitions.push(JSON.parse(fs.readFileSync(args[args.indexOf('--file') + 1]))); return { code: 0, stdout: '' }; };
  try {
    const base = { root, project: 'ours-fixture', uid: 1000, gid: 1000, instanceId: '12345678-1234-1234-1234-123456789abc' };
    await effects.runDockerConversion({ ...base, product: 'plugin-only', services: ['daemon'] }, { target: 'ours-fixture_server-storage' }, 'validate');
    await effects.runDockerConversion({ ...base, services: ['daemon', 'telegram', 'cowork', 'messenger', 'gateway'] }, { target: 'ours-fixture_server-storage' }, 'validate');
    const [plugin, workspace] = definitions.map(value => value.services['state-operation']);
    assert.deepEqual(plugin.volumes.map(v => v.target).sort(), ['/storage', '/var/lib/ours']);
    assert.equal(plugin.environment.OURS_SERVER_APPLICATIONS, 'daemon');
    assert.ok(workspace.volumes.some(v => v.target === '/var/lib/ours-cowork'), 'the workspace keeps its full validation');
    assert.equal(workspace.environment.OURS_SERVER_APPLICATIONS, '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
