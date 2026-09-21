import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { introducedCommitLevel, commitLevel, nextVersion, registryMetadata, bumpInstaller } from './bump-installer-version.mjs';
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
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'rev-parse' && args[1] === '--verify') return args[2].slice(0, 40);
    if (args[0] === 'rev-parse') return calls.some(call => call[0] === 'commit') ? 'b'.repeat(40) : 'a'.repeat(40);
    if (args[0] === 'status') return '';
    throw new Error(`Unexpected git call ${JSON.stringify(args)}`);
  };
  return { root, release, files, calls, snapshot, setMessage(value) { message = value; }, options: { root, mode: channel, env: { GITHUB_REF_NAME: channel === 'stable' ? 'main' : 'prerelease', GITHUB_EVENT_NAME: 'push', BEFORE_SHA: 'c'.repeat(40), GITHUB_SHA: 'a'.repeat(40), GITHUB_OUTPUT: join(root, 'output') }, git, readRegistry: async () => ({ latest: '1.1.1', versions: ['1.1.1', '1.2.1-nightly.1', '1.2.1-nightly.4'] }) } };
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
  await assert.rejects(bumpInstaller(f.options), /required packages and optional daemon artifact/);
  assert.deepEqual(f.snapshot(), pending);
});

function historyFixture(t) {
  const f = fixture(t);
  const git = args => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Version fixture']);
  git(['config', 'user.email', 'version-fixture@example.invalid']);
  git(['add', '.']);
  git(['commit', '-m', 'chore: fixture base']);
  const before = git(['rev-parse', 'HEAD']);
  const addCommit = message => git(['commit', '--allow-empty', '-m', message]);
  const options = () => ({ ...f.options, git, env: { ...f.options.env, BEFORE_SHA: before, GITHUB_SHA: git(['rev-parse', 'HEAD']) } });
  return { ...f, git, before, addCommit, options };
}

test('a merged breaking feature bumps major despite the merge subject and later docs', async t => {
  const f = historyFixture(t);
  f.git(['checkout', '-b', 'feature']);
  f.addCommit('feat!: replace installer interface');
  f.addCommit('docs: explain interface');
  f.git(['checkout', 'main']);
  f.git(['merge', '--no-ff', 'feature', '-m', 'Merge pull request #123 from feature']);
  const result = await bumpInstaller(f.options());
  assert.equal(result.version, '2.0.0');
});

test('an introduced feature followed by docs still bumps minor', async t => {
  const f = historyFixture(t);
  f.addCommit('feat: add guided installation');
  f.addCommit('docs: update guide');
  const result = await bumpInstaller(f.options());
  assert.equal(result.version, '1.3.0');
});

test('merge bookkeeping and all nonshipping or skip-marked constituents do not bump', async t => {
  const f = historyFixture(t);
  f.git(['checkout', '-b', 'documentation']);
  for (const message of ['docs: clarify', 'ci: gate', 'test: coverage', 'chore: metadata', 'feat!: release machinery [skip ci]']) f.addCommit(message);
  f.git(['checkout', 'main']);
  f.git(['merge', '--no-ff', 'documentation', '-m', 'Merge pull request #124 from documentation']);
  const before = f.snapshot();
  const result = await bumpInstaller({ ...f.options(), readRegistry: async () => { throw new Error('must not query'); } });
  assert.equal(result.bumped, false);
  assert.deepEqual(f.snapshot(), before);
});

test('missing, malformed, and unavailable introduced endpoints fail before mutation or registry reads', async t => {
  const f = historyFixture(t); f.addCommit('feat: new option');
  const before = f.snapshot();
  for (const changed of [{ BEFORE_SHA: undefined }, { GITHUB_SHA: undefined }, { BEFORE_SHA: '0'.repeat(40) }, { BEFORE_SHA: 'main' }, { BEFORE_SHA: 'f'.repeat(40) }]) {
    const options = f.options();
    await assert.rejects(bumpInstaller({ ...options, env: { ...options.env, ...changed }, readRegistry: async () => { throw new Error('must not query'); } }), /requires explicit|Unavailable introduced-range/);
    assert.deepEqual(f.snapshot(), before);
  }
});

test('nonancestor ranges and a mismatched checkout are rejected without mutation', async t => {
  const f = historyFixture(t);
  f.git(['checkout', '-b', 'side']); f.addCommit('feat: side branch');
  const side = f.git(['rev-parse', 'HEAD']);
  f.git(['checkout', 'main']); f.addCommit('fix: main branch');
  const before = f.snapshot(); const options = f.options();
  await assert.rejects(bumpInstaller({ ...options, env: { ...options.env, BEFORE_SHA: side } }), /must be an ancestor/);
  await assert.rejects(bumpInstaller({ ...options, env: { ...options.env, GITHUB_SHA: f.before } }), /must match checked-out HEAD/);
  assert.deepEqual(f.snapshot(), before);
});

test('range classification selects the strongest introduced commit level', () => {
  const before = 'a'.repeat(40), after = 'b'.repeat(40);
  const git = args => args[0] === 'rev-parse' ? args[2].slice(0, 40) : args[0] === 'merge-base' ? '' : 'fix: repair\0feat: feature\0fix!: incompatible\0docs: guide\0';
  assert.equal(introducedCommitLevel({ before, after, head: after, git }), 'major');
});
