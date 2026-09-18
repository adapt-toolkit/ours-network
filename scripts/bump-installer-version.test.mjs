import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commitLevel, nextVersion, registryMetadata, bumpInstaller } from './bump-installer-version.mjs';
import { PACKAGE_NAMES } from './release-manifest.mjs';

function fixture(t, channel = 'stable') {
  const root = mkdtempSync(join(tmpdir(), 'installer-bump-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages/installer'), { recursive: true });
  mkdirSync(join(root, 'releases'));
  const local = '1.2.0-nightly.3';
  const release = { schema: 1, channel, installerVersion: local, packages: Object.fromEntries(PACKAGE_NAMES.map(name => [name, { version: channel === 'stable' ? '9.0.0' : '9.0.1-nightly.1', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` }])) };
  const files = {
    'packages/installer/package.json': { name: '@ours.network/install', version: local, dependencies: { unchanged: '1.0.0' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': { version: '0.0.0' }, 'packages/installer': { version: local }, 'node_modules/unchanged': { version: '1.0.0' } } },
    [`releases/${channel}.json`]: release,
  };
  for (const [path, value] of Object.entries(files)) writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n');
  const snapshot = () => Object.fromEntries(Object.keys(files).map(path => [path, readFileSync(join(root, path), 'utf8')]));
  const calls = [];
  let message = 'fix: repair installation';
  const git = args => {
    calls.push(args);
    if (args[0] === 'log') return message;
    if (args[0] === 'rev-parse') return calls.some(call => call[0] === 'commit') ? 'b'.repeat(40) : 'a'.repeat(40);
    if (args[0] === 'status') return '';
    throw new Error(`Unexpected git call ${JSON.stringify(args)}`);
  };
  return { root, release, files, calls, snapshot, setMessage(value) { message = value; }, options: { root, mode: channel, env: { GITHUB_REF_NAME: channel === 'stable' ? 'main' : 'prerelease', GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: join(root, 'output') }, git, readRegistry: async () => ({ latest: '1.1.1', versions: ['1.1.1', '1.2.1-nightly.1', '1.2.1-nightly.4'] }) } };
}

test('conventional commits choose major/minor/patch and nonshipping commits are noops', () => {
  for (const message of ['feat!: incompatible', 'fix(api)!: incompatible', 'fix: change\n\nBREAKING CHANGE: incompatible']) assert.equal(commitLevel(message), 'major');
  assert.equal(commitLevel('feat(installer): new option'), 'minor');
  for (const message of ['fix: repair', 'refactor: simplify', 'unstructured change']) assert.equal(commitLevel(message), 'patch');
  for (const message of ['docs: update', 'ci: gate', 'test: coverage', 'chore: metadata', 'feat: new [skip ci]', 'fix: repair [ci skip]']) assert.equal(commitLevel(message), null);
});

test('stable starts above greater local core or registry latest; refuses collisions', () => {
  assert.equal(nextVersion({ mode: 'stable', localVersion: '1.2.0-nightly.3', latest: '1.1.1', versions: [], level: 'minor' }), '1.3.0');
  assert.equal(nextVersion({ mode: 'stable', localVersion: '1.2.0', latest: '2.3.4', versions: [], level: 'patch' }), '2.3.5');
  assert.equal(nextVersion({ mode: 'stable', localVersion: '1.2.0', latest: '2.3.4', versions: [], level: 'major' }), '3.0.0');
  assert.throws(() => nextVersion({ mode: 'stable', localVersion: '1.2.0', latest: '1.1.1', versions: ['1.2.1'] }), /already published/);
});

test('nightly increments highest matching published counter and ignores unrelated cores', () => {
  assert.equal(nextVersion({ mode: 'nightly', localVersion: '1.2.0-nightly.3', latest: '1.1.1', versions: ['1.2.1-nightly.1', '1.2.1-nightly.8', '1.2.2-nightly.90'] }), '1.2.1-nightly.9');
  assert.equal(nextVersion({ mode: 'nightly', localVersion: '1.2.0', latest: '2.0.0', versions: [] }), '2.0.1-nightly.1');
  assert.throws(() => nextVersion({ mode: 'nightly', localVersion: 'latest', latest: '1.0.0', versions: [] }));
});

test('official registry reads refuse failures and malformed or prerelease latest', async () => {
  let url;
  const metadata = await registryMetadata(async (address, options) => { url = address; assert.equal(options.redirect, 'error'); return { ok: true, json: async () => ({ name: '@ours.network/install', 'dist-tags': { latest: '1.1.1' }, versions: { '1.1.1': {} } }) }; });
  assert.equal(url, 'https://registry.npmjs.org/@ours.network%2finstall');
  assert.deepEqual(metadata, { latest: '1.1.1', versions: ['1.1.1'] });
  await assert.rejects(registryMetadata(async () => ({ ok: false, status: 404 })), /HTTP 404/);
  await assert.rejects(registryMetadata(async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(registryMetadata(async () => ({ ok: true, json: async () => ({ name: '@ours.network/install', 'dist-tags': { latest: '1.2.0-nightly.1' }, versions: {} }) })), /Invalid version/);
});

test('stable commits only the three release files and pushes main with skip-ci marker', async t => {
  const f = fixture(t); const git = f.options.git;
  f.options.git = args => ['config', 'add', 'commit', 'push'].includes(args[0]) ? (f.calls.push(args), '') : git(args);
  const output = await bumpInstaller({ ...f.options, commit: true });
  assert.deepEqual(output, { bumped: true, 'new-sha': 'b'.repeat(40), version: '1.2.1' });
  assert.deepEqual(f.calls.find(call => call[0] === 'add'), ['add', '--', 'packages/installer/package.json', 'package-lock.json', 'releases/stable.json']);
  assert.match(f.calls.find(call => call[0] === 'commit')[2], /\[skip ci\]/);
  assert.deepEqual(f.calls.find(call => call[0] === 'push'), ['push', 'origin', 'HEAD:refs/heads/main']);
  const updated = JSON.parse(readFileSync(join(f.root, 'releases/stable.json')));
  assert.deepEqual(updated.packages, f.release.packages);
  assert.equal(updated.installerVersion, output.version);
  const lock = JSON.parse(readFileSync(join(f.root, 'package-lock.json')));
  assert.equal(lock.packages['packages/installer'].version, output.version);
  assert.equal(lock.packages[''].version, '0.0.0');
  assert.equal(lock.packages['node_modules/unchanged'].version, '1.0.0');
  assert.match(readFileSync(join(f.root, 'output'), 'utf8'), /bumped=true\nnew-sha=b{40}\nversion=1.2.1\n/);
});

test('nightly updates matching metadata without git writes and preserves component pins', async t => {
  const f = fixture(t, 'nightly'); const output = await bumpInstaller(f.options);
  assert.equal(output.version, '1.2.1-nightly.5');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'releases/nightly.json'))).packages, f.release.packages);
  assert.equal(f.calls.some(call => ['add', 'commit', 'push', 'config'].includes(call[0])), false);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'packages/installer/package.json'))).version, output.version);
});

test('nonshipping stable commits do not read registry or modify files', async t => {
  const f = fixture(t); f.setMessage('docs: clarify'); const before = f.snapshot();
  const output = await bumpInstaller({ ...f.options, readRegistry: async () => { throw new Error('must not query'); } });
  assert.equal(output.bumped, false); assert.deepEqual(f.snapshot(), before);
});

test('branch guards, pending component sets, and registry errors leave files untouched', async t => {
  const f = fixture(t); const before = f.snapshot();
  await assert.rejects(bumpInstaller({ ...f.options, env: { GITHUB_REF_NAME: 'prerelease' } }), /Refusing/);
  await assert.rejects(bumpInstaller({ ...f.options, mode: 'nightly', commit: true }), /never commits/);
  await assert.rejects(bumpInstaller({ ...f.options, readRegistry: async () => { throw new Error('registry unavailable'); } }), /registry unavailable/);
  assert.deepEqual(f.snapshot(), before);
  f.release.packages = {};
  writeFileSync(join(f.root, 'releases/stable.json'), JSON.stringify(f.release));
  const pending = f.snapshot();
  await assert.rejects(bumpInstaller(f.options), /nine required/);
  assert.deepEqual(f.snapshot(), pending);
});
