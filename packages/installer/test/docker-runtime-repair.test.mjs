import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { qualifyDockerRuntime, refreshDockerPolicyCopy } from '../lib/docker-runtime-repair.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'ours-repair-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = '{"packages":{}}\n';
  const record = { root, workDir: root, project: 'ours-fixture', sourcesPath: join(root, 'sources.json'), uid: 12345, gid: 12345 };
  fs.writeFileSync(record.sourcesPath, source, { mode: 0o600 });
  fs.writeFileSync(join(root, 'Dockerfile'), 'FROM node:24\nCOPY sources.json /opt/ours/sources.json\n');
  const hash = createHash('sha256').update(source).digest('hex');
  const id = 'sha256:' + 'a'.repeat(64), repairedId = 'sha256:' + 'b'.repeat(64);
  const config = { User: '1000:1000', Env: ['X=y'], Entrypoint: ['/bin/sh', '/entrypoint'], Cmd: null, Labels: { 'network.ours.build-context': '1' } };
  const base = { Id: id, Config: config, RootFS: { Layers: ['original-layer'] } };
  const candidate = { Id: repairedId, Config: options.changedConfig ? { ...config, User: '0' } : config, RootFS: { Layers: ['original-layer', 'permissions-layer'] } };
  const report = { uid: 0, gid: 0, mode: 0o600, regular: true, links: 1, policyHash: hash, records: { 'package-lock.json': 'lockhash', 'dependency-tree.json': 'treehash', 'build-context.json': 'contextHash' } };
  let current = options.healthy ? candidate : base;
  let injected = false;
  const calls = [];
  const effects = { out: () => {}, async run(command, args, runOptions = {}) {
    calls.push({ command, args, options: runOptions });
    if (args[0] === 'image' && args[1] === 'inspect') {
      const target = args.at(-1);
      const value = target === 'ours-fixture:runtime' ? current : target === id || target.endsWith(':base') ? base : candidate;
      return { code: 0, stdout: JSON.stringify([value]) };
    }
    if (args[0] === 'run') {
      assert(args.includes('--read-only') && args.includes('--cap-drop') && args.includes('none'));
      assert(!args.includes('--mount') && !args.includes('--volume'));
      assert.equal(runOptions.timeout, 60000);
      const rootProbe = args[args.indexOf('--user') + 1] === '0:0';
      const image = args[args.indexOf('--entrypoint') + 2];
      if (image === id && !rootProbe) return { code: options.unknownFailure ? 1 : 74, stdout: '' };
      const result = { ...report, mode: image === repairedId ? 0o644 : options.unsafeMode ? 0o666 : 0o600 };
      if (options.policyMismatch && rootProbe) result.policyHash = 'different';
      if (options.recordsChanged && image === repairedId) result.records = { ...report.records, 'package-lock.json': 'changed' };
      return { code: 0, stdout: JSON.stringify(result) };
    }
    if (args[0] === 'build') {
      assert.match(fs.readFileSync(join(args.at(-1), 'Dockerfile'), 'utf8'), /COPY --chmod=644 sources.json \/opt\/ours\/sources.json/);
      if (options.buildFailure) throw new Error('build failed');
      if (options.race) current = { ...base, Id: 'sha256:' + 'c'.repeat(64) };
    }
    if (args[0] === 'image' && args[1] === 'tag' && args.at(-1) === 'ours-fixture:runtime') {
      current = candidate;
      if (options.interruptAfterTag && !injected) { injected = true; throw new Error('interrupted after tag'); }
    }
    return { code: 0, stdout: '' };
  } };
  return { record, effects, calls, base, candidate, current: () => current };
}

test('repair qualifies exact owner image without mounting state and preserves host privacy', async t => {
  const f = fixture(t);
  refreshDockerPolicyCopy(f.record);
  await qualifyDockerRuntime(f.record, f.effects);
  assert.equal(f.current().Id, f.candidate.Id);
  assert.equal(fs.statSync(f.record.sourcesPath).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(join(f.record.workDir, 'Dockerfile'), 'utf8'), /COPY --chmod=644/);
  const count = f.calls.filter(x => x.args[0] === 'build').length;
  await qualifyDockerRuntime(f.record, f.effects);
  assert.equal(f.calls.filter(x => x.args[0] === 'build').length, count);
});

for (const option of ['unknownFailure', 'unsafeMode', 'policyMismatch', 'recordsChanged', 'changedConfig', 'race', 'buildFailure']) {
  test(`repair refuses ${option} without replacing the selected image`, async t => {
    const f = fixture(t, { [option]: true });
    await assert.rejects(qualifyDockerRuntime(f.record, f.effects));
    assert(!f.calls.some(x => x.args[0] === 'image' && x.args[1] === 'tag' && x.args.at(-1) === 'ours-fixture:runtime'));
  });
}

test('retry after tag publication interruption retains the repaired image', async t => {
  const f = fixture(t, { interruptAfterTag: true });
  await assert.rejects(qualifyDockerRuntime(f.record, f.effects), /interrupted/);
  const id = f.current().Id;
  await qualifyDockerRuntime(f.record, f.effects);
  assert.equal(f.current().Id, id);
  assert.equal(f.calls.filter(x => x.args[0] === 'build').length, 1);
});

test('retained Dockerfile normalization is narrow and refuses links', async t => {
  const f = fixture(t);
  refreshDockerPolicyCopy(f.record);
  const path = join(f.record.workDir, 'Dockerfile'), fixed = fs.readFileSync(path, 'utf8');
  refreshDockerPolicyCopy(f.record);
  assert.equal(fs.readFileSync(path, 'utf8'), fixed);
  fs.unlinkSync(path); fs.symlinkSync(f.record.sourcesPath, path);
  assert.throws(() => refreshDockerPolicyCopy(f.record), /Unsafe/);
});

test('owner asset copied with mode0664 inside private runtime is normalized and refreshed', t => {
  const f = fixture(t), path = join(f.record.workDir, 'Dockerfile');
  fs.chmodSync(path, 0o664);
  refreshDockerPolicyCopy(f.record);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path, 'utf8'), /COPY --chmod=644/);
  fs.chmodSync(path, 0o664); // Current instruction still needs mode normalization.
  refreshDockerPolicyCopy(f.record);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
});

for (const boundary of ['shared-directory', 'linked-directory', 'hardlinked-file', 'special-mode']) {
  test(`Dockerfile normalization refuses ${boundary}`, t => {
    const f = fixture(t), path = join(f.record.workDir, 'Dockerfile');
    if (boundary === 'shared-directory') fs.chmodSync(f.record.workDir, 0o775);
    if (boundary === 'linked-directory') {
      const alias = f.record.root + '-alias'; fs.symlinkSync(f.record.root, alias); t.after(() => fs.unlinkSync(alias)); f.record.workDir = alias;
    }
    if (boundary === 'hardlinked-file') fs.linkSync(path, join(f.record.root, 'other-link'));
    if (boundary === 'special-mode') fs.chmodSync(path, 0o2644);
    assert.throws(() => refreshDockerPolicyCopy(f.record), /Unsafe/);
  });
}
