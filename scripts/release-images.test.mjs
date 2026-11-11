import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageTags, planImages, readPlan, stageImages, bakeIndexes, resolveDigests, imagesManifest, existingTags, RELEASE_TAG, SNAPSHOT_TAG } from './release-images.mjs';
import { policyHash, IMAGE_REPOSITORIES } from '../packages/installer/lib/image-acquisition.mjs';
import { resolveSourcePolicy } from '../packages/installer/lib/plan.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';
const d = c => 'sha256:' + c.repeat(64);

test('tags: release versions and main snapshots are immutable, anchored and role-specific', () => {
  assert.deepEqual(imageTags({ channel: 'stable', installerVersion: '2.2.0', commit, kind: 'release' }), { server: '2.2.0-server', daemon: '2.2.0-daemon' });
  assert.deepEqual(imageTags({ channel: 'nightly', installerVersion: '2.2.1-nightly.3', commit, kind: 'release' }), { server: '2.2.1-nightly.3-server', daemon: '2.2.1-nightly.3-daemon' });
  assert.deepEqual(imageTags({ channel: 'stable', installerVersion: '2.2.0', commit, kind: 'snapshot' }), { server: 'snapshot-stable-0123456789ab-server', daemon: 'snapshot-stable-0123456789ab-daemon' });
  assert.throws(() => imageTags({ channel: 'nightly', installerVersion: '2.2.1-nightly.3', commit, kind: 'snapshot' }));
  for (const alias of ['stable-server', 'nightly-daemon', 'latest', 'server']) assert.ok(!RELEASE_TAG.test(alias) && !SNAPSHOT_TAG.test(alias), alias);
});

test('plan carries the exact role policies the host retains', async t => {
  const plan = await planImages({ commit, kind: 'release' });
  const pkg = JSON.parse(readFileSync(new URL('../packages/installer/package.json', import.meta.url)));
  assert.equal(plan.installerVersion, pkg.version);
  const packaged = JSON.parse(readFileSync(new URL('../packages/installer/assets/sources.json', import.meta.url)));
  for (const role of ['server', 'daemon']) assert.equal(plan.policies[role], JSON.stringify(await resolveSourcePolicy(packaged, role), null, 2) + '\n');
  assert.deepEqual(Object.keys(JSON.parse(plan.policies.daemon).packages).sort(), ['@ours.network/cli', '@ours.network/daemon', '@ours.network/sdk'], 'plugin-only never selects workspace packages');
  const path = join(mkdtempSync(join(tmpdir(), 'ours-plan-')), 'plan.json');
  t.after(() => rmSync(path, { force: true }));
  writeFileSync(path, JSON.stringify(plan));
  assert.deepEqual(readPlan(path), plan);
  writeFileSync(path, JSON.stringify({ ...plan, tags: { ...plan.tags, server: 'stable-server' } }));
  assert.throws(() => readPlan(path), /tags differ/);
  await assert.rejects(planImages({ commit: 'main', kind: 'release' }), /full release commit/);
});

test('staged contexts match the host build context byte for byte, and bake builds both targets per role', async t => {
  const plan = await planImages({ commit, kind: 'release' });
  const out = mkdtempSync(join(tmpdir(), 'ours-stage-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const bake = JSON.parse(readFileSync(stageImages(plan, out, { push: true }), 'utf8'));
  assert.deepEqual(Object.keys(bake.target).sort(), ['maintenance-daemon', 'maintenance-server', 'runtime-daemon', 'runtime-server']);
  for (const [name, target] of Object.entries(bake.target)) {
    const [kind, role] = name.split('-');
    assert.equal(target.context, role);
    assert.equal(target.target, kind);
    assert.deepEqual(target.platforms, ['linux/amd64']);
    assert.equal(target.output[0], `type=image,name=${IMAGE_REPOSITORIES[kind]},push-by-digest=true,name-canonical=true,push=true`);
    assert.equal(target.labels['network.ours.policy-sha256'], policyHash(Buffer.from(plan.policies[role])));
    assert.equal(readFileSync(join(out, target.context, 'sources.json'), 'utf8'), plan.policies[role]);
  }
  for (const role of ['server', 'daemon']) {
    const files = readdirSync(join(out, role), { recursive: true }).sort();
    assert.ok(!files.includes('images.json'), 'descriptors are never image content');
    const maintenance = JSON.parse(readFileSync(join(out, role, 'scripts/maintenance/package.json'), 'utf8'));
    assert.deepEqual(maintenance.dependencies, JSON.parse(readFileSync(new URL('../packages/installer/package.json', import.meta.url))).dependencies);
  }
  const local = JSON.parse(readFileSync(stageImages(plan, join(out, 'pr'), { push: false }), 'utf8'));
  assert.deepEqual(local.target['runtime-server'].output, ['type=docker']);
  assert.equal(local.target['runtime-server'].attest, undefined);
});

test('descriptor: index → single linux/amd64 manifest → config, from bake metadata or reused tags', async () => {
  const plan = await planImages({ commit, kind: 'release' });
  const raw = {};
  let n = 0;
  const indexes = {};
  for (const role of ['server', 'daemon']) for (const target of ['runtime', 'maintenance']) {
    const index = d(n.toString(16)), manifest = d((n + 4).toString(16)), config = d((n + 8).toString(16)); n++;
    (indexes[role] ??= {})[target] = index;
    raw[`${IMAGE_REPOSITORIES[target]}@${index}`] = JSON.stringify({ manifests: [
      { digest: manifest, platform: { os: 'linux', architecture: 'amd64' } },
      { digest: d('f'), platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } }] });
    raw[`${IMAGE_REPOSITORIES[target]}@${manifest}`] = JSON.stringify({ config: { digest: config } });
  }
  const metadata = Object.fromEntries(Object.entries(indexes).flatMap(([role, t]) => Object.entries(t).map(([target, digest]) => [`${target}-${role}`, { 'containerimage.digest': digest }])));
  assert.deepEqual(bakeIndexes(metadata), indexes);
  const manifest = imagesManifest(plan, indexes, ref => raw[ref]);
  assert.equal(manifest.variants.server.policySha256, policyHash(Buffer.from(plan.policies.server)));
  assert.equal(manifest.variants.daemon.maintenance.repository, IMAGE_REPOSITORIES.maintenance);
  assert.throws(() => bakeIndexes({ ...metadata, 'runtime-server': {} }), /lacks the runtime-server digest/);
  assert.throws(() => resolveDigests(IMAGE_REPOSITORIES.runtime, d('0'), () => JSON.stringify({ manifests: [] })), /single linux\/amd64/);
});

test('retry: no tags builds, a complete published pair is reused, a partial pair refuses', async () => {
  const plan = await planImages({ commit, kind: 'release' });
  assert.equal(existingTags(plan, () => null), null);
  const all = existingTags(plan, ref => d(ref.includes('maintenance') ? 'a' : 'b'));
  assert.deepEqual(Object.keys(all).sort(), ['daemon', 'server']);
  assert.throws(() => existingTags(plan, ref => ref.endsWith('-server') ? d('a') : null), /publish a new version/);
});

test('workflow: images are qualified before tags, and npm publication needs the qualified descriptor', () => {
  const workflow = readFileSync(new URL('../.github/workflows/installer.yml', import.meta.url), 'utf8');
  for (const step of ['release-images.mjs plan', 'release-images.mjs stage', 'docker buildx bake', 'release-images.mjs describe', 'release-images.mjs qualify', 'release-images.mjs tag', 'release-images.mjs verify-pack', 'release-images.mjs qualify-local'])
    assert.ok(workflow.includes(step), step);
  const order = ['release-images.mjs describe', 'release-images.mjs qualify ', 'release-images.mjs tag'].map(step => workflow.indexOf(step));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(workflow, /DOCKERHUB_ADAPTFRAMEWORK/);
  assert.doesNotMatch(workflow, /docker\/build-push-action/);
});

test('the published package whitelist excludes test/, which marks a published installer', () => {
  const { files } = JSON.parse(readFileSync(new URL('../packages/installer/package.json', import.meta.url)));
  assert.ok(files.length && !files.some(entry => entry === 'test' || entry.startsWith('test/')));
});
