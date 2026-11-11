import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateImagesManifest, readPackagedImages, selectServerImages, generationEntry, readGenerations, rememberGeneration, pruneGenerations,
  pullServerImages, policyBytes, policyHash, imagesRoot, IMAGE_REPOSITORIES } from '../lib/image-acquisition.mjs';

const d = c => 'sha256:' + c.repeat(64);
const h = c => c.repeat(64);
const target = (name, c) => ({ repository: IMAGE_REPOSITORIES[name], index: d(c), manifest: d(String.fromCharCode(c.charCodeAt(0) + 1)), config: d(String.fromCharCode(c.charCodeAt(0) + 2)) });
const release = { schema: 1, channel: 'stable', installerVersion: '2.2.0', packages: {} };
const manifest = (over = {}) => ({ schema: 1, channel: 'stable', installerVersion: '2.2.0', commit: 'a'.repeat(40), platform: 'linux/amd64',
  variants: { server: { policySha256: h('1'), runtime: target('runtime', '2'), maintenance: target('maintenance', '5') },
    daemon: { policySha256: h('8'), runtime: target('runtime', 'a'), maintenance: target('maintenance', 'c') } }, ...over });
const fixture = t => { const root = mkdtempSync(join(tmpdir(), 'ours-images-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };

test('descriptor accepts only the fixed repositories, platform, release binding and digests', () => {
  assert.equal(validateImagesManifest(manifest(), release).installerVersion, '2.2.0');
  const bad = [
    manifest({ platform: 'linux/arm64' }), manifest({ channel: 'nightly' }), manifest({ installerVersion: '2.1.9' }), manifest({ extra: 1 }),
    manifest({ commit: 'abc' }), manifest({ variants: { server: manifest().variants.server } }),
  ];
  for (const value of bad) assert.throws(() => validateImagesManifest(value, release));
  const foreign = manifest(); foreign.variants.server.runtime = { ...foreign.variants.server.runtime, repository: 'docker.io/evil/ours-runtime' };
  assert.throws(() => validateImagesManifest(foreign, release));
  const swapped = manifest(); swapped.variants.daemon.maintenance = { ...swapped.variants.daemon.maintenance, repository: IMAGE_REPOSITORIES.runtime };
  assert.throws(() => validateImagesManifest(swapped, release));
  const tagged = manifest(); tagged.variants.server.runtime = { ...tagged.variants.server.runtime, index: 'latest' };
  assert.throws(() => validateImagesManifest(tagged, release));
  const unknown = manifest(); unknown.variants.server.runtime = { ...unknown.variants.server.runtime, tag: '2.2.0-server' };
  assert.throws(() => validateImagesManifest(unknown, release));
});

test('a development checkout has no packaged descriptor', t => {
  assert.equal(readPackagedImages(release, join(fixture(t), 'images.json')), null);
});

test('selection: retained generation, then packaged release, else explicit build; released mismatch refuses', t => {
  const root = fixture(t), sourcesPath = join(root, 'sources.json');
  const selected = { packages: { a: 1 } }, bytes = policyBytes(selected), hash = policyHash(bytes);
  writeFileSync(sourcesPath, bytes);
  const packaged = manifest(); packaged.variants.server.policySha256 = hash;
  // Fresh install of the packaged release: pull and remember.
  const fresh = selectServerImages({ root, sourcesPath, role: 'server', packaged, releasedHash: hash });
  assert.deepEqual([fresh.kind, fresh.remember, fresh.entry.runtime.index], ['pull', true, packaged.variants.server.runtime.index]);
  // Released selection, but the descriptor lacks it: never a silent build.
  assert.throws(() => selectServerImages({ root, sourcesPath, role: 'server', packaged: manifest(), releasedHash: hash }), /published image descriptor does not match/);
  // Custom or earlier selection with a published installer, and a development installer: explicit build.
  assert.match(selectServerImages({ root, sourcesPath, role: 'server', packaged: manifest(), releasedHash: h('f') }).reason, /differ from this installer release/);
  assert.match(selectServerImages({ root, sourcesPath, role: 'server', packaged: null, releasedHash: hash, published: false }).reason, /development checkout/);
  // A published package that lost its descriptor refuses its own release selection.
  assert.throws(() => selectServerImages({ root, sourcesPath, role: 'server', packaged: null, releasedHash: hash, published: true }), /lacks its published image descriptor/);
  assert.equal(selectServerImages({ root, sourcesPath, role: 'server', packaged: null, releasedHash: h('f'), published: true }).kind, 'build');
  assert.equal(selectServerImages({ root, sourcesPath, role: 'server', packaged, releasedHash: hash, buildLocally: true }).kind, 'build');
  // A plugin-only selection never takes the workspace variant.
  assert.equal(selectServerImages({ root, sourcesPath, role: 'daemon', packaged: manifest(), releasedHash: h('f') }).kind, 'build');
});

test('repair uses the retained generation even when the current installer publishes a newer one', t => {
  const root = fixture(t), sourcesPath = join(root, 'sources.json');
  const bytes = policyBytes({ packages: { old: 1 } }), hash = policyHash(bytes);
  writeFileSync(sourcesPath, bytes);
  const older = manifest({ installerVersion: '2.1.9' });
  rememberGeneration(root, hash, generationEntry(older, 'server'));
  const newer = manifest(); // different policy hash, newer version
  const plan = selectServerImages({ root, sourcesPath, role: 'server', packaged: newer, releasedHash: newer.variants.server.policySha256 });
  assert.deepEqual([plan.kind, plan.remember, plan.entry.installerVersion], ['pull', undefined, '2.1.9']);
  assert.throws(() => selectServerImages({ root, sourcesPath, role: 'daemon', packaged: newer }), /different installation role/);
});

test('generations are private, conflict-checked, stored at the installation root and pruned to active and previous', t => {
  const root = fixture(t), candidate = join(root, '.build-x');
  mkdirSync(candidate);
  assert.equal(imagesRoot(candidate), root);
  rememberGeneration(candidate, h('1'), generationEntry(manifest(), 'server'));
  assert.equal(statSync(join(root, 'images.json')).mode & 0o777, 0o600);
  assert.ok(!existsSync(join(candidate, 'images.json')));
  rememberGeneration(root, h('1'), generationEntry(manifest(), 'server'));
  assert.throws(() => rememberGeneration(root, h('1'), generationEntry(manifest({ installerVersion: '2.2.1' }), 'server')), /different image generation/);
  rememberGeneration(root, h('2'), generationEntry(manifest({ installerVersion: '2.2.1' }), 'server'));
  rememberGeneration(root, h('3'), generationEntry(manifest({ installerVersion: '2.2.2' }), 'server'));
  pruneGenerations(root, [h('3'), h('2')]);
  assert.deepEqual(Object.keys(readGenerations(root)).sort(), [h('2'), h('3')]);
  writeFileSync(join(root, 'images.json'), JSON.stringify({ schema: 1, generations: { [h('4')]: { role: 'server' } } }));
  assert.throws(() => readGenerations(root), /Invalid image descriptor/);
});

test('an interrupted switch always leaves a generation for the retained selection', t => {
  // Order: remember new generation -> replace sources.json -> prune. Every prefix is consistent.
  const root = fixture(t), sourcesPath = join(root, 'sources.json');
  const before = policyBytes({ packages: { v: 1 } }), after = policyBytes({ packages: { v: 2 } });
  writeFileSync(sourcesPath, before);
  rememberGeneration(root, policyHash(before), generationEntry(manifest({ installerVersion: '2.2.0' }), 'server'));
  const resolve = () => selectServerImages({ root, sourcesPath, role: 'server', packaged: null, published: false });
  rememberGeneration(root, policyHash(after), generationEntry(manifest({ installerVersion: '2.2.1' }), 'server'));
  assert.equal(resolve().entry.installerVersion, '2.2.0');
  writeFileSync(sourcesPath, after);
  assert.equal(resolve().entry.installerVersion, '2.2.1');
  pruneGenerations(root, [policyHash(after), policyHash(before)]);
  assert.equal(resolve().entry.installerVersion, '2.2.1');
});

const engine = (overrides = {}) => {
  const calls = [];
  const effects = { out() {}, env: {}, run: async (command, args) => {
    calls.push(args);
    if (args[0] === 'image' && args[1] === 'inspect') {
      const ref = args[2], entry = generationEntry(manifest(), 'server'), name = ref.includes('maintenance') ? 'maintenance' : 'runtime';
      const value = overrides.inspect?.(ref) ?? { Id: entry[name].config, RepoDigests: [`adaptframework/ours-${name}@${entry[name].index}`], Config: { Labels: { 'network.ours.build-context': '1' } } };
      return { code: 0, stdout: JSON.stringify([value]) };
    }
    if (args[0] === 'run') return { code: 0, stdout: overrides.pair?.(args) ?? '{"package-lock.json":"x"}' };
    return { code: 0, stdout: '' };
  } };
  return { effects, calls };
};
const record = { mode: 'docker', containerEngine: 'docker', project: 'ours-abc', root: '/r', uid: 1000, gid: 1000 };

test('pull is digest-bound, platform-pinned, verified, tagged for the project and pair-checked', async () => {
  const { effects, calls } = engine();
  const entry = generationEntry(manifest(), 'server');
  await pullServerImages(effects, record, entry);
  assert.deepEqual(calls.filter(a => a[0] === 'pull'), [
    ['pull', '--platform', 'linux/amd64', `${IMAGE_REPOSITORIES.runtime}@${entry.runtime.index}`],
    ['pull', '--platform', 'linux/amd64', `${IMAGE_REPOSITORIES.maintenance}@${entry.maintenance.index}`]]);
  assert.deepEqual(calls.filter(a => a[0] === 'tag').map(a => a.at(-1)), ['ours-abc:runtime', 'ours-abc:maintenance']);
  const runs = calls.filter(a => a[0] === 'run');
  assert.deepEqual(runs.map(a => a[a.indexOf('--entrypoint') + 2]), ['ours-abc:runtime', 'ours-abc:maintenance']);
  for (const run of runs) for (const flag of ['--read-only', '--cap-drop']) assert.ok(run.includes(flag));
  assert.ok(runs.every(a => a[a.indexOf('--network') + 1] === 'none'));
});

test('pull refuses a mismatched digest, missing build label or a split runtime/maintenance pair', async () => {
  const entry = generationEntry(manifest(), 'server');
  for (const inspect of [() => ({ Id: d('9'), RepoDigests: [`adaptframework/ours-runtime@${entry.runtime.index}`], Config: { Labels: { 'network.ours.build-context': '1' } } }),
    () => ({ Id: entry.runtime.config, RepoDigests: [`adaptframework/ours-runtime@${d('9')}`], Config: { Labels: { 'network.ours.build-context': '1' } } }),
    () => ({ Id: entry.runtime.config, RepoDigests: [`adaptframework/ours-runtime@${entry.runtime.index}`], Config: { Labels: {} } })]) {
    const { effects, calls } = engine({ inspect });
    await assert.rejects(pullServerImages(effects, record, entry), /does not match its published digest/);
    assert.equal(calls.some(a => a[0] === 'tag'), false);
  }
  let n = 0;
  const { effects } = engine({ pair: () => JSON.stringify({ 'package-lock.json': String(n++) }) });
  await assert.rejects(pullServerImages(effects, record, entry), /do not share one build/);
});

test('a containerd image store naming the image by its index digest is accepted; Podman names are normalized', async () => {
  const entry = generationEntry(manifest(), 'server');
  const { effects } = engine({ inspect: ref => {
    const name = ref.includes('maintenance') ? 'maintenance' : 'runtime';
    return { Id: entry[name].index, RepoDigests: [`docker.io/adaptframework/ours-${name}@${entry[name].index}`], Config: { Labels: { 'network.ours.build-context': '1' } } };
  } });
  await pullServerImages(effects, record, entry);
});

test('registry failure names docker login and the explicit local-build opt-in', async () => {
  const entry = generationEntry(manifest(), 'server');
  const effects = { out() {}, env: {}, run: async (command, args) => { if (args[0] === 'pull') { const e = new Error('toomanyrequests'); e.code = 1; throw e; } return { code: 0, stdout: '' }; } };
  await assert.rejects(pullServerImages(effects, record, entry), /docker login.*OURS_BUILD_LOCALLY=1/s);
});

test('retained policy bytes match the installer serializer', () => {
  const policy = { packages: { '@ours.network/sdk': { type: 'npm', version: '5.2.0' } } };
  assert.equal(policyBytes(policy).toString(), JSON.stringify(policy, null, 2) + '\n');
  assert.equal(readFileSync(new URL('../lib/image-acquisition.mjs', import.meta.url), 'utf8').includes('--build-locally'), false);
});
