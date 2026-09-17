import test from 'node:test';
import assert from 'node:assert/strict';
import { realEffects } from '../lib/effects.mjs';

test('Docker conversion selects owned named volumes and refuses missing or bind sources and foreign targets', async () => {
  const record = { schema: 1, mode: 'docker', root: '/srv/ours', workDir: '/srv/ours/runtime', project: 'ours-fixture', services: ['daemon', 'telegram', 'cowork', 'messenger'] };
  const rendered = { services: {}, volumes: {} };
  const inventory = {};
  for (const service of record.services) {
    const key = `${service}-state`;
    rendered.volumes[key] = { name: `${record.project}_${key}` };
    rendered.services[service] = { volumes: [{ type: 'volume', source: key, target: service === 'daemon' ? '/var/lib/ours' : `/var/lib/ours-${service}`, volume: { subpath: 'data' } }] };
    if (service !== 'daemon') {
      const credential = `${service}-credential`;
      rendered.volumes[credential] = { name: `${record.project}_${credential}` };
      rendered.services[service].volumes.push({ type: 'volume', source: credential, target: `/credentials/${service}` });
    }
  }
  for (const [key, value] of Object.entries(rendered.volumes)) {
    inventory[value.name] = { Name: value.name, Driver: 'local', Options: null, Labels: { 'com.docker.compose.project': record.project, 'com.docker.compose.volume': key } };
  }
  const effects = realEffects({ env: {}, home: '/tmp' });
  const calls = [];
  let unavailable;
  effects.run = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('config')) return { code: 0, stdout: JSON.stringify(rendered) };
    if (args.includes('ls')) return { code: 0, stdout: Object.keys(inventory).join('\n') };
    if (args.at(-1) === unavailable) return { code: 1, stdout: '' };
    const volume = inventory[args.at(-1)];
    return volume ? { code: 0, stdout: JSON.stringify(volume) } : { code: 1, stdout: '' };
  };
  const result = await effects.selectConversionVolumes(record);
  assert.equal(result.sources.daemon, 'ours-fixture_daemon-state');
  assert.equal(result.sources['cowork-credential'], 'ours-fixture_cowork-credential');
  assert.equal(result.target, 'ours-fixture_server-storage');
  assert.equal(result.targetExists, false);
  assert.ok(calls.every(call => call.includes('config') || call.includes('inspect') || call.includes('ls')));
  const savedVolume = inventory[result.sources.daemon];
  delete inventory[result.sources.daemon];
  await assert.rejects(effects.selectConversionVolumes(record), /source volume.*missing/i);
  const partial = await effects.selectConversionVolumes({ ...record, layoutConversion: {} }, { allowMissingSources: true });
  assert.equal(Object.hasOwn(partial.sources, 'daemon'), false);
  inventory[result.sources.daemon] = savedVolume;
  unavailable = result.sources.daemon;
  await assert.rejects(effects.selectConversionVolumes({ ...record, layoutConversion: {} }, { allowMissingSources: true }), /unavailable/i);
  unavailable = undefined;
  savedVolume.Options = { type: 'none', o: 'bind', device: '/external/state' };
  await assert.rejects(effects.selectConversionVolumes(record), /external.*storage/i);
  savedVolume.Options = null;

  inventory[result.target] = { Name: result.target, Driver: 'local', Options: null, Labels: { 'com.docker.compose.project': 'unrelated', 'com.docker.compose.volume': 'server-storage' } };
  await assert.rejects(effects.selectConversionVolumes({ ...record, layoutConversion: {} }), /ownership/i);
  inventory[result.target].Labels['com.docker.compose.project'] = record.project;
  await assert.rejects(effects.selectConversionVolumes(record), /destination.*exists/i);
  assert.equal((await effects.selectConversionVolumes({ ...record, layoutConversion: {} })).targetExists, true);

  rendered.services.daemon.volumes[0].type = 'bind';
  await assert.rejects(effects.selectConversionVolumes(record), /source.*mount/i);
});
