import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyReleaseGraph, releaseBinding } from '../assets/scripts/maintenance/release-graph.mjs';
import { resolveSourcePolicy } from '../lib/plan.mjs';
import { networkEffects } from '../lib/effects.mjs';

const names = ['sdk', 'cli', 'tg-connector', 'cowork', 'messenger-server', 'fleet', 'mcp', 'codex', 'claude-code'].map(name => '@ours.network/' + name);
const sdk = names[0], cli = names[1];
const sri = 'sha512-' + createHash('sha512').update('registry fixture').digest('base64');
function policy() {
  const release = { schema: 1, channel: 'nightly', installerVersion: '1.2.3-nightly.1', packages: Object.fromEntries(names.map((name, index) => [name, { version: `${index + 1}.0.1-nightly.1`, integrity: sri }])) };
  return { release, packages: Object.fromEntries([sdk, cli].map(name => [name, { type: 'npm', version: release.packages[name].version }])) };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ours-release-graph-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selected = policy();
  const write = (path, value) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), JSON.stringify(value)); };
  const manifest = { name: 'runtime', private: true, dependencies: Object.fromEntries(Object.entries(selected.packages).map(([name, p]) => [name, p.version])) };
  const entries = Object.fromEntries([sdk, cli].map(name => [`node_modules/${name}`, { ...selected.release.packages[name], resolved: `https://registry.npmjs.org/${name}/-/fixture.tgz` }]));
  const lock = { lockfileVersion: 3, packages: { '': manifest, ...entries } };
  const installed = { lockfileVersion: 3, packages: structuredClone(entries) };
  write('package.json', manifest); write('sources.json', selected);
  for (const name of [sdk, cli]) write(`node_modules/${name}/package.json`, { name, version: selected.release.packages[name].version });
  const save = () => { write('package-lock.json', lock); write('node_modules/.package-lock.json', installed); };
  save();
  return { root, selected, lock, installed, write, save };
}
test('accepts independent exact component versions in both installed and root graphs', t => {
  const f = fixture(t); assert.equal(verifyReleaseGraph(f.root, f.selected).verified, true);
});
for (const target of ['root', 'installed']) for (const field of ['version', 'integrity']) test(`rejects ${target} graph ${field} drift`, t => {
  const f = fixture(t); (target === 'root' ? f.lock : f.installed).packages[`node_modules/${sdk}`][field] = 'wrong'; f.save();
  assert.throws(() => verifyReleaseGraph(f.root, f.selected), /release/i);
});
for (const kind of ['version', 'integrity', 'unknown']) test(`rejects nested ours ${kind} drift`, t => {
  const f = fixture(t), name = kind === 'unknown' ? '@ours.network/unselected' : sdk;
  const entry = { ...f.lock.packages[`node_modules/${sdk}`] };
  if (kind !== 'unknown') entry[kind] = 'wrong';
  for (const lock of [f.lock, f.installed]) lock.packages[`node_modules/${cli}/node_modules/${name}`] = entry;
  f.save(); assert.throws(() => verifyReleaseGraph(f.root, f.selected), /release/i);
});
test('rejects actual installed version drift even when both locks agree', t => {
  const f = fixture(t); f.write(`node_modules/${sdk}/package.json`, { name: sdk, version: '0.0.0' });
  assert.throws(() => verifyReleaseGraph(f.root, f.selected), /release/i);
});
test('rejects a missing installed package and symlinked package', t => {
  const f = fixture(t); rmSync(join(f.root, `node_modules/${sdk}`), { recursive: true });
  assert.throws(() => verifyReleaseGraph(f.root, f.selected));
  symlinkSync(join(f.root, `node_modules/${cli}`), join(f.root, `node_modules/${sdk}`));
  assert.throws(() => verifyReleaseGraph(f.root, f.selected), /release/i);
});
test('rejects missing direct graph entries', t => {
  const f = fixture(t); delete f.lock.packages[`node_modules/${sdk}`]; delete f.installed.packages[`node_modules/${sdk}`]; f.save();
  assert.throws(() => verifyReleaseGraph(f.root, f.selected), /release/i);
});
test('checks vendor bytes against the release, not only self-consistent lock metadata', t => {
  const f = fixture(t); const path = 'docker/vendor/ours.network-sdk.tgz'; mkdirSync(join(f.root, 'docker/vendor'), { recursive: true }); writeFileSync(join(f.root, path), 'registry fixture');
  for (const lock of [f.lock, f.installed]) lock.packages[`node_modules/${sdk}`].resolved = `file:${path}`;
  f.save(); assert.equal(verifyReleaseGraph(f.root, f.selected).verified, true);
  writeFileSync(join(f.root, path), 'wrong archive'); assert.throws(() => verifyReleaseGraph(f.root, f.selected), /release/i);
});
test('explicit development sources remain usable without a release binding', t => {
  const f = fixture(t); delete f.selected.release;
  f.selected.packages[sdk] = { source: 'sdk' }; f.selected.sources = { sdk: { type: 'git', url: '/development', commit: 'a'.repeat(40) } };
  rmSync(join(f.root, 'package-lock.json')); assert.equal(verifyReleaseGraph(f.root, f.selected).verified, false);
});
test('a malformed or mismatched binding cannot fall back to development', t => {
  const f = fixture(t); assert.throws(() => releaseBinding({ ...f.selected, release: null }), /release/i);
  f.selected.packages[sdk].version = '0.0.0'; assert.throws(() => verifyReleaseGraph(f.root, f.selected), /release/i);
});
test('role filtering preserves the full immutable release binding without dist-tag resolution', async t => {
  const f = fixture(t); const result = await resolveSourcePolicy(f.selected, 'client', ['sdk'], () => { throw Error('must not resolve exact versions'); });
  assert.deepEqual(result.release, f.selected.release); assert.deepEqual(Object.keys(result.packages), [sdk]);
});
test('client acquisition refuses drift before readiness or global command installation', async t => {
  const f = fixture(t), calls = [];
  // Exercise real acquisition orchestration; only the npm process boundary is fake.
  const sources = join(f.root, 'sources.json');
  f.selected.packages['@ours.network/codex'] = { type: 'npm', version: f.selected.release.packages['@ours.network/codex'].version }; f.write('sources.json', f.selected);
  const effects = { env: {}, home: f.root, async run(command, args, options) {
    calls.push([command, ...args]);
    if (args[0] === 'install' && !args.includes('--global')) {
      const root = options.cwd;
      writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, [`node_modules/${sdk}`]: { version: '0.0.0', integrity: sri } } }));
      mkdirSync(join(root, 'node_modules'), { recursive: true }); writeFileSync(join(root, 'node_modules/.package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    }
    return { code: 0, stdout: '' };
  } };
  await assert.rejects(networkEffects(effects).acquireClientPackages(join(f.root, 'profile.json'), sources, ['codex']), /release/i);
  assert.equal(calls.some(call => call.includes('--global')), false);
  const root = join(f.root, '.ours-client-install', createHash('sha256').update(join(f.root, 'profile.json')).digest('hex').slice(0, 16));
  assert.equal(existsSync(join(root, '.packages-ready')), false);
});

test('published dated Cowork nightlies remain valid independent component versions', t => {
  const f = fixture(t); f.selected.release.packages['@ours.network/cowork'].version = '1.3.2-nightly.20260918.4d9242e';
  assert.equal(verifyReleaseGraph(f.root, f.selected).verified, true);
});
test('native build recording rejects release drift before publishing provenance', async t => {
  const f = fixture(t); f.installed.packages[`node_modules/${sdk}`].integrity = 'wrong'; f.save();
  let ran = false; const effects = { home: f.root, env: {}, async run() { ran = true; return { stdout: '{}' }; } };
  await assert.rejects(networkEffects(effects).recordRuntimeBuild({ mode: 'packages', workDir: f.root }), /release/i);
  assert.equal(ran, false); assert.equal(existsSync(join(f.root, 'dependency-tree.json')), false);
});
test('marketplace drift refuses publication of its registration manifest', async t => {
  const f = fixture(t), codex = '@ours.network/codex';
  const artifact = f.selected.release.packages[codex];
  const source = { name: codex, version: artifact.version, dependencies: { [sdk]: f.selected.release.packages[sdk].version } };
  f.selected.packages[codex] = { type: 'npm', version: artifact.version }; f.write('sources.json', f.selected);
  for (const lock of [f.lock, f.installed]) lock.packages[`node_modules/${codex}`] = { ...artifact, resolved: `https://registry.npmjs.org/${codex}/-/fixture.tgz` };
  f.write(`node_modules/${codex}/package.json`, source);
  const runtime = JSON.parse(readFileSync(join(f.root, 'package.json'))); runtime.dependencies[codex] = artifact.version;
  f.write('package.json', runtime); f.lock.packages[''] = runtime; f.save();
  let published = false;
  const effects = { home: f.root, env: {}, writeJson() { published = true; }, async run(command, args, options) {
    const root = options.cwd;
    const entries = { [`node_modules/${sdk}`]: { ...f.selected.release.packages[sdk], integrity: 'wrong', resolved: `https://registry.npmjs.org/${sdk}/-/fixture.tgz` } };
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': source, ...entries } }));
    writeFileSync(join(root, 'node_modules/.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: entries }));
    return { stdout: '' };
  } };
  await assert.rejects(networkEffects(effects).prepareClientMarketplace('codex', join(f.root, 'node_modules', codex)), /release/i);
  assert.equal(published, false);
  const prepared = JSON.parse(readFileSync(join(f.root, 'marketplaces/codex/plugins/ours/package.json')));
  assert.equal(prepared.dependencies[sdk], f.selected.release.packages[sdk].version, 'published dependencies remain registry pins, never local repacks');
});

for (const missing of [[sdk], [sdk, cli]]) test('cannot silently drop selected direct packages: ' + missing.join(','), t => {
  const f = fixture(t), manifest = JSON.parse(readFileSync(join(f.root, 'package.json')));
  for (const name of missing) { delete manifest.dependencies[name]; delete f.lock.packages[`node_modules/${name}`]; delete f.installed.packages[`node_modules/${name}`]; }
  f.write('package.json', manifest); f.lock.packages[''] = manifest; f.save();
  assert.throws(() => verifyReleaseGraph(f.root, f.selected), /direct package set/);
});
test('direct ranges cannot masquerade as exact release pins', t => {
  const f = fixture(t), manifest = JSON.parse(readFileSync(join(f.root, 'package.json'))); manifest.dependencies[sdk] = '^' + f.selected.release.packages[sdk].version;
  f.write('package.json', manifest); assert.throws(() => verifyReleaseGraph(f.root, f.selected), /direct package spec/);
});
