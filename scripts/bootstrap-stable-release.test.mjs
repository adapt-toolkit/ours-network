import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSelections, stableManifest } from './bootstrap-stable-release.mjs';

const names = Object.keys(JSON.parse(readFileSync(new URL('../releases/nightly.json', import.meta.url))).packages);
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const args = names.map(name => `${name}@9.0.0`);

test('every nightly component needs exactly one exact stable selection', () => {
  assert.equal(Object.keys(parseSelections(args, names)).length, names.length);
  assert.throws(() => parseSelections(args.slice(1), names), /Missing stable selections/);
  assert.throws(() => parseSelections([...args, args[0]], names), /selected twice/);
  assert.throws(() => parseSelections(args.map(a => a.replace('@9.0.0', '@9.0.1-nightly.1')), names), /exact stable version/);
  assert.throws(() => parseSelections([...args, '@ours.network/other@1.0.0'], names), /not a component/);
});

test('the bootstrapped manifest is a complete stable set with host CLI and an unbound installer', () => {
  const manifest = stableManifest(Object.fromEntries(names.map(name => [name, { version: '9.0.0', integrity }])));
  assert.equal(manifest.channel, 'stable');
  assert.equal(manifest.installerVersion, null);
  assert.deepEqual(Object.keys(manifest.packages).sort(), [...names].sort());
  assert.deepEqual(manifest.hostCli, { '@ours.network/sdk': { version: '9.0.0', integrity }, '@ours.network/cli': { version: '9.0.0', integrity } });
  assert.throws(() => stableManifest(Object.fromEntries(names.map(name => [name, { version: '9.0.0', integrity: 'sha512-x' }]))), /integrity/);
});
