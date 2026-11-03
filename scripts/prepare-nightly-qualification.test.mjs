import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { prepareNightlyQualification, qualificationEvent, NIGHTLY_RELEASE_FILES } from './prepare-nightly-qualification.mjs';
import { bumpInstaller } from './bump-installer-version.mjs';
import { PACKAGE_NAMES } from './release-manifest.mjs';

const PR = { CI: 'true', GITHUB_ACTIONS: 'true', OURS_NIGHTLY_QUALIFICATION: '1', GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'prerelease', GITHUB_REF: 'refs/pull/7/merge', GITHUB_REF_NAME: '7/merge' };
const registry = async () => ({ latest: '1.1.1', versions: ['1.1.1', '1.2.1-nightly.1', '1.2.1-nightly.4'] });

/** A real Git checkout with the three release files committed. */
function checkout(t) {
  const root = mkdtempSync(join(tmpdir(), 'installer-nightly-qualification-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages/installer'), { recursive: true });
  mkdirSync(join(root, 'releases'));
  const local = '1.2.0-nightly.3';
  const release = { schema: 1, channel: 'nightly', installerVersion: local, packages: Object.fromEntries(PACKAGE_NAMES.map(name => [name, { version: '9.0.1-nightly.1', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` }])) };
  const files = {
    'packages/installer/package.json': { name: '@ours.network/install', version: local },
    'package-lock.json': { lockfileVersion: 3, packages: { '': { version: '0.0.0' }, 'packages/installer': { version: local } } },
    'releases/nightly.json': release,
    'releases/stable.json': { schema: 1, channel: 'stable' },
  };
  for (const [path, value] of Object.entries(files)) writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
  return { root, release, git };
}

test('qualification runs only in its CI job, for prerelease, without publish credentials', () => {
  assert.equal(qualificationEvent(PR), 'pull_request');
  assert.equal(qualificationEvent({ ...PR, GITHUB_EVENT_NAME: 'push', GITHUB_BASE_REF: '', GITHUB_REF: 'refs/heads/prerelease' }), 'push');
  for (const env of [
    {},
    { ...PR, CI: undefined },
    { ...PR, GITHUB_ACTIONS: undefined },
    { ...PR, OURS_NIGHTLY_QUALIFICATION: undefined },
  ]) assert.throws(() => qualificationEvent(env), /only in its GitHub Actions job/);
  for (const env of [
    { ...PR, GITHUB_BASE_REF: 'main' },
    { ...PR, GITHUB_EVENT_NAME: 'pull_request_target' },
    { ...PR, GITHUB_EVENT_NAME: 'push', GITHUB_BASE_REF: '', GITHUB_REF: 'refs/heads/main' },
    { ...PR, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_BASE_REF: '', GITHUB_REF: 'refs/heads/prerelease' },
    { ...PR, GITHUB_EVENT_NAME: 'schedule', GITHUB_BASE_REF: '', GITHUB_REF: 'refs/heads/prerelease' },
  ]) assert.throws(() => qualificationEvent(env), /Refusing nightly qualification for event/);
  for (const name of ['NODE_AUTH_TOKEN', 'NPM_TOKEN']) assert.throws(() => qualificationEvent({ ...PR, [name]: 'x' }), new RegExp(`${name} set`));
});

test('a pull request to prerelease gets the exact nightly release state, uncommitted', async t => {
  const f = checkout(t);
  const head = f.git('rev-parse', 'HEAD');
  const output = join(f.root, 'github-output');
  const result = await prepareNightlyQualification({ root: f.root, env: { ...PR, GITHUB_OUTPUT: output }, readRegistry: registry });
  assert.deepEqual(result, { version: '1.2.1-nightly.5', head });
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('rev-list', '--count', 'HEAD'), '1');
  assert.deepEqual(f.git('diff', '--name-only').split('\n').sort(), [...NIGHTLY_RELEASE_FILES].sort());
  assert.equal(JSON.parse(readFileSync(join(f.root, 'packages/installer/package.json'))).version, result.version);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'package-lock.json'))).packages['packages/installer'].version, result.version);
  const release = JSON.parse(readFileSync(join(f.root, 'releases/nightly.json')));
  assert.equal(release.installerVersion, result.version);
  assert.deepEqual(release.packages, f.release.packages);
  assert.throws(() => readFileSync(output), { code: 'ENOENT' });
});

test('the production nightly guard still refuses the same pull request', async t => {
  const f = checkout(t);
  await assert.rejects(bumpInstaller({ mode: 'nightly', root: f.root, env: PR, readRegistry: registry }), /Refusing nightly version bump/);
  await assert.rejects(bumpInstaller({ mode: 'nightly', root: f.root, env: { ...PR, GITHUB_REF_NAME: 'prerelease' }, readRegistry: registry }), /Refusing nightly version bump/);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('refuses a modified checkout and any change beyond the release files', async t => {
  const dirty = checkout(t);
  writeFileSync(join(dirty.root, 'releases/stable.json'), '{}\n');
  await assert.rejects(prepareNightlyQualification({ root: dirty.root, env: PR, readRegistry: registry }), /unmodified checkout/);
  const f = checkout(t);
  const unexpected = async () => { writeFileSync(join(f.root, 'releases/stable.json'), '{}\n'); return registry(); };
  await assert.rejects(prepareNightlyQualification({ root: f.root, env: PR, readRegistry: unexpected }), /unexpected paths: package-lock.json, packages\/installer\/package.json, releases\/nightly.json, releases\/stable.json/);
  await assert.rejects(prepareNightlyQualification({ root: checkout(t).root, env: { ...PR, GITHUB_BASE_REF: 'main' }, readRegistry: registry }), /Refusing nightly qualification/);
});
