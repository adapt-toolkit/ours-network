import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createBuildContext, readBuildRecords, equalBuildRecords } from '../assets/scripts/maintenance/build-context.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'ours-context-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@ours.network/sdk', version: '1.0.0' }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OURS_')));
  env.HOME = join(dir, 'home'); fs.mkdirSync(env.HOME);
  const npm = (args, cwd) => execFileSync('npm', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const [{ filename }] = JSON.parse(npm(['pack', '--ignore-scripts', '--json'], source));
  function build(name) {
    const root = join(dir, name); fs.mkdirSync(join(root, 'docker/vendor'), { recursive: true });
    for (const path of [root, join(root, 'docker'), join(root, 'docker/vendor')]) fs.chmodSync(path, 0o700);
    fs.copyFileSync(join(source, filename), join(root, 'docker/vendor/ours.network-sdk.tgz'));
    fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ours-container-runtime', version: '0.1.0', private: true, dependencies: { '@ours.network/sdk': 'file:docker/vendor/ours.network-sdk.tgz' } }));
    npm(['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], root);
    fs.writeFileSync(join(root, 'dependency-tree.json'), npm(['ls', '--omit=dev', '--all', '--json'], root), { mode: 0o600 });
    for (const path of ['package.json', 'package-lock.json', 'dependency-tree.json', 'docker/vendor/ours.network-sdk.tgz']) fs.chmodSync(join(root, path), 0o600);
    return root;
  }
  return { dir, build, source, npm };
}

test('verified equal artifacts compare across roots, including after roots disappear', t => {
  const { build } = fixture(t), a = build('a'), b = build('b');
  assert.equal(equalBuildRecords(readBuildRecords(a), readBuildRecords(b)), false);
  createBuildContext(a); createBuildContext(b);
  const ar = readBuildRecords(a), br = readBuildRecords(b);
  assert.equal(fs.statSync(join(a, 'build-context.json')).mode & 0o777, 0o600);
  fs.rmSync(a, { recursive: true }); fs.rmSync(b, { recursive: true });
  assert.equal(equalBuildRecords(ar, br), true);
  assert.throws(() => equalBuildRecords({ ...ar }, { ...br }), /verified record/);
});

test('creation rejects tar mutation and escaping symlink without publishing context', t => {
  const { build, dir } = fixture(t), a = build('a');
  const tar = join(a, 'docker/vendor/ours.network-sdk.tgz');
  const bytes = fs.readFileSync(tar); fs.appendFileSync(tar, 'changed');
  assert.throws(() => createBuildContext(a), /integrity/);
  assert.equal(fs.existsSync(join(a, 'build-context.json')), false);
  const outside = join(dir, 'outside.tgz'); fs.writeFileSync(outside, bytes);
  fs.unlinkSync(tar); fs.symlinkSync(outside, tar);
  assert.throws(() => createBuildContext(a), /symlink|canonical|regular/);
});

test('record/context tampering and a forged vendor name reject', t => {
  const { build } = fixture(t), a = build('a'); createBuildContext(a);
  const context = join(a, 'build-context.json'), original = fs.readFileSync(context);
  const tree = join(a, 'dependency-tree.json'); fs.appendFileSync(tree, ' ');
  assert.throws(() => readBuildRecords(a), /digest/);
  fs.writeFileSync(tree, fs.readFileSync(tree).subarray(0, -1));
  const value = JSON.parse(original); value.vendors[0].name = '@ours.network/other';
  fs.writeFileSync(context, JSON.stringify(value, null, 2) + '\n');
  assert.throws(() => readBuildRecords(a), /vendor/);
  fs.writeFileSync(context, original);
  assert.throws(() => createBuildContext(a), /exists|existing/i);
});

test('present malformed/unknown context cannot fall back to legacy', t => {
  const { build } = fixture(t), a = build('a'); createBuildContext(a);
  const path = join(a, 'build-context.json'), bytes = fs.readFileSync(path);
  fs.writeFileSync(path, '{'); assert.throws(() => readBuildRecords(a), /invalid JSON/);
  const c = JSON.parse(bytes); c.schema = 99;
  fs.writeFileSync(path, JSON.stringify(c, null, 2) + '\n'); assert.throws(() => readBuildRecords(a), /schema/);
  fs.writeFileSync(path, bytes); fs.chmodSync(path, 0o666);
  assert.throws(() => readBuildRecords(a), /permissions/);
});

test('same vendor bytes never erase nested dependency or unknown record differences', t => {
  const { build } = fixture(t), a = build('a'), b = build('b');
  function change(root, fn) {
    const path = join(root, 'dependency-tree.json'), tree = JSON.parse(fs.readFileSync(path)); fn(tree);
    fs.writeFileSync(path, JSON.stringify(tree));
  }
  change(a, tree => { tree.dependencies['@ours.network/sdk'].dependencies = { nested: { version: '1.0.0', resolved: 'file:/external/a.tgz' } }; });
  change(b, tree => { tree.dependencies['@ours.network/sdk'].dependencies = { nested: { version: '1.0.0', resolved: 'file:/external/b.tgz' } }; });
  createBuildContext(a); createBuildContext(b);
  assert.equal(equalBuildRecords(readBuildRecords(a), readBuildRecords(b)), false);
  fs.unlinkSync(join(b, 'build-context.json'));
  change(b, tree => { tree.unrecognized = true; });
  assert.throws(() => createBuildContext(b), /unsupported build record shape/);
});

test('wrong basename/root references, manifest selection and linked archives refuse creation', t => {
  const { build, dir } = fixture(t), a = build('a');
  const path = join(a, 'dependency-tree.json'), original = fs.readFileSync(path), tree = JSON.parse(original);
  tree.dependencies['@ours.network/sdk'].resolved = 'file:/other/docker/vendor/ours.network-sdk.tgz';
  fs.writeFileSync(path, JSON.stringify(tree));
  assert.throws(() => createBuildContext(a), /tree binding/);
  fs.writeFileSync(path, original);
  const manifestPath = join(a, 'package.json'), manifest = fs.readFileSync(manifestPath), obj = JSON.parse(manifest);
  obj.dependencies['@ours.network/sdk'] = 'file:somewhere-else.tgz'; fs.writeFileSync(manifestPath, JSON.stringify(obj));
  assert.throws(() => createBuildContext(a), /manifest/); fs.writeFileSync(manifestPath, manifest);
  fs.linkSync(join(a, 'docker/vendor/ours.network-sdk.tgz'), join(dir, 'linked.tgz'));
  assert.throws(() => createBuildContext(a), /regular file/);
});

test('format2 retains verified context; missing/mixed context and modified bytes refuse', async t => {
  const { createArchive, validateArchive, extractArchive } = await import('../assets/scripts/maintenance/state-archive.mjs');
  const { build, dir } = fixture(t), a = build('a'); createBuildContext(a);
  const records = readBuildRecords(a), source = join(dir, 'state'), backup = join(dir, 'backup');
  fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(join(source, '.ours-provenance'), { mode: 0o700 });
  for (const [name, bytes] of Object.entries(records)) fs.writeFileSync(join(source, '.ours-provenance', name), bytes, { mode: 0o600 });
  const options = { domain: 'telegram', uid: process.getuid(), gid: process.getgid(), provenance: records };
  const metadata = await createArchive(source, backup, options);
  assert.equal(metadata.format, 2); assert.ok(metadata.sha256['build-context.json']);
  fs.rmSync(a, { recursive: true });
  await extractArchive(backup, join(dir, 'restored'), options);
  assert.deepEqual(fs.readFileSync(join(dir, 'restored/.ours-provenance/build-context.json')), records['build-context.json']);
  const context = fs.readFileSync(join(backup, 'build-context.json'));
  fs.unlinkSync(join(backup, 'build-context.json'));
  await assert.rejects(validateArchive(backup, options), /format files/);
  fs.writeFileSync(join(backup, 'build-context.json'), context, { mode: 0o600 });
  const legacy = { ...records }; delete legacy['build-context.json'];
  await assert.rejects(validateArchive(backup, { ...options, provenance: legacy }), /format files|metadata/);
  fs.appendFileSync(join(backup, 'build-context.json'), ' ');
  await assert.rejects(validateArchive(backup, options), /digest/);
});

test('caller buffer mutation cannot alter comparison or copied records', t => {
  const { build } = fixture(t), a = build('a'), b = build('b');
  createBuildContext(a); createBuildContext(b);
  const ar = readBuildRecords(a), br = readBuildRecords(b), before = ar['dependency-tree.json'];
  ar['dependency-tree.json'].fill(0); ar['build-context.json'].fill(0);
  assert.deepEqual(ar['dependency-tree.json'], before);
  assert.equal(equalBuildRecords(ar, br), true);
});

test('maintenance migrates legacy records only via reviewed update and preserves legacy backup', async t => {
  const { runStateOperation } = await import('../assets/scripts/maintenance/state-operation.mjs');
  const { build, dir } = fixture(t), target = build('new'); createBuildContext(target);
  const legacy = join(dir, 'legacy'), live = join(dir, 'live');
  fs.mkdirSync(legacy, { mode: 0o700 }); fs.mkdirSync(live, { mode: 0o700 });
  for (const name of ['package-lock.json', 'dependency-tree.json']) fs.writeFileSync(join(legacy, name), '{}', { mode: 0o600 });
  const env = { ...process.env, OURS_STATE_ROOT: dir, OURS_LIVE_ROOT: live, OURS_BUILD_ROOT: legacy, OURS_STATE_DOMAIN: 'telegram' };
  await runStateOperation(['init', 'telegram'], env);
  const next = { ...env, OURS_BUILD_ROOT: target };
  await assert.rejects(runStateOperation(['update', 'telegram'], next), /compatibility/);
  await runStateOperation(['update', 'telegram', '--compatible'], next);
  assert.ok(fs.existsSync(join(live, '.ours-provenance/build-context.json')));
  const pre = fs.readdirSync(join(dir, 'backups')).find(n => n.startsWith('pre-update-'));
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'backups', pre, 'metadata.json'))).format, 1);
  await runStateOperation(['backup', 'telegram', 'new-format'], next);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'backups/new-format/metadata.json'))).format, 2);
  // Reviewed restore uses target-runtime records, not the obsolete archive context.
  await runStateOperation(['restore', 'telegram', 'new-format', '--compatible'], env);
  assert.equal(fs.existsSync(join(live, '.ours-provenance/build-context.json')), false);
  assert.equal(fs.readFileSync(join(live, '.ours-provenance/package-lock.json'), 'utf8'), '{}');
});

test('fresh finalizer handles npm umask0002 without weakening private context', async t => {
  const { finalizeBuild } = await import('../assets/scripts/build/record-build.mjs');
  const { build } = fixture(t), a = build('a');
  for (const path of [a, join(a, 'docker'), join(a, 'docker/vendor')]) fs.chmodSync(path, 0o775);
  for (const path of ['package.json', 'package-lock.json', 'docker/vendor/ours.network-sdk.tgz']) fs.chmodSync(join(a, path), 0o664);
  fs.unlinkSync(join(a, 'dependency-tree.json'));
  const mask = process.umask(0o002);
  try { finalizeBuild(a); } finally { process.umask(mask); }
  for (const path of ['package.json', 'package-lock.json', 'dependency-tree.json', 'build-context.json', 'docker/vendor/ours.network-sdk.tgz']) assert.equal(fs.statSync(join(a, path)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(a).mode & 0o777, 0o700);
  assert.throws(() => finalizeBuild(a), /Existing context/);
});

test('real admission normalizes verified paths but rejects malformed context even with compatibility', async t => {
  const { realEffects } = await import('../lib/effects.mjs');
  const { build, dir } = fixture(t), a = build('a'), b = build('b'); createBuildContext(a); createBuildContext(b);
  const sources = join(dir, 'sources.json'); fs.writeFileSync(sources, '{}', { mode: 0o600 });
  const current = { mode: 'packages', root: dir, workDir: a, sourcesPath: sources }, candidate = { ...current, workDir: b };
  const effects = realEffects({ env: {}, home: dir });
  await effects.checkServerBuild(current, candidate, false, 'rebuild');
  fs.writeFileSync(join(b, 'build-context.json'), '{}');
  for (const [operation, compatible] of [['rebuild', false], ['update', true]]) await assert.rejects(effects.checkServerBuild(current, candidate, compatible, operation), /context/);
});

test('Docker context-copy failure never publishes a partial record set as legacy', async t => {
  const { realEffects } = await import('../lib/effects.mjs');
  const { build, dir } = fixture(t), source = build('source'); createBuildContext(source);
  const destination = join(dir, 'destination'); fs.mkdirSync(destination, { mode: 0o700 });
  const effects = realEffects({ env: {}, home: dir }); const events = [];
  effects.run = async (command, args) => {
    assert.equal(command, 'docker'); events.push(args[0]);
    if (args[0] === 'image') return { stdout: '1\n' };
    if (args[0] === 'cp') {
      const name = args[1].split('/').at(-1);
      if (name === 'build-context.json') throw new Error('injected context-copy failure');
      fs.copyFileSync(join(source, name), args[2]);
    }
    return { stdout: '', code: 0 };
  };
  await assert.rejects(effects.copyDockerBuildRecords({ project: 'fixture' }, destination), /injected/);
  assert.deepEqual(fs.readdirSync(destination), []); assert.ok(events.includes('rm'));
});

test('independently verified changed tar bytes at the same name/version still refuse admission', t => {
  const { build, source, npm } = fixture(t), a = build('a'); createBuildContext(a);
  fs.writeFileSync(join(source, 'README.md'), 'different package bytes');
  npm(['pack', '--ignore-scripts', '--json'], source);
  const b = build('b'); createBuildContext(b);
  const ar = readBuildRecords(a), br = readBuildRecords(b);
  assert.equal(JSON.parse(ar['build-context.json']).vendors[0].version, JSON.parse(br['build-context.json']).vendors[0].version);
  assert.notEqual(JSON.parse(ar['build-context.json']).vendors[0].integrity, JSON.parse(br['build-context.json']).vendors[0].integrity);
  assert.equal(equalBuildRecords(ar, br), false);
});

test('full-server failed transitions never mix record generations around backup/exchange', async t => {
  const { runStateOperation } = await import('../assets/scripts/maintenance/state-operation.mjs');
  const { initializeBuildMarker } = await import('../assets/scripts/maintenance/build-context.mjs');
  const { build, dir } = fixture(t), target = build('target'); createBuildContext(target);
  const legacy = join(dir, 'legacy'); fs.mkdirSync(legacy, { mode: 0o700 });
  for (const name of ['package-lock.json', 'dependency-tree.json']) fs.writeFileSync(join(legacy, name), '{}', { mode: 0o600 });
  const old = readBuildRecords(legacy), next = readBuildRecords(target);
  for (const point of ['beforeBackup', 'afterBackup', 'beforeExchange', 'afterExchange']) {
    const state = join(dir, point), live = join(state, 'live'); fs.mkdirSync(state, { mode: 0o700 }); fs.mkdirSync(live, { mode: 0o700 });
    for (const name of ['daemon', 'telegram', 'cowork', 'messenger', 'mcp', 'credentials']) {
      fs.mkdirSync(join(live, name), { mode: 0o700 });
      if (!['mcp', 'credentials'].includes(name)) initializeBuildMarker(join(live, name, '.ours-provenance'), old);
    }
    const env = { ...process.env, OURS_STATE_ROOT: state, OURS_LIVE_ROOT: live, OURS_BUILD_ROOT: target, OURS_STATE_DOMAIN: 'server', OURS_COWORK_CLI_PATH: '/usr/bin/true', OURS_COWORK_CONFIG: join(live, 'cowork/config.json') };
    await assert.rejects(runStateOperation(['update', 'server', '--compatible'], env, { [point]: () => { throw new Error('injected ' + point); } }), /injected/);
    const expected = point === 'afterExchange' ? next : old;
    for (const component of ['daemon', 'telegram', 'cowork', 'messenger']) {
      const actual = readBuildRecords(join(live, component, '.ours-provenance'), { privateFiles: true, marker: true });
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
      for (const name of Object.keys(expected)) assert.deepEqual(actual[name], expected[name]);
    }
    const backups = fs.readdirSync(join(state, 'backups'));
    assert.equal(backups.length, point === 'beforeBackup' ? 0 : 1);
    if (backups.length) assert.equal(JSON.parse(fs.readFileSync(join(state, 'backups', backups[0], 'metadata.json'))).format, 1);
  }
});

test('maintenance restores equivalent format2 after old build root deletion and retargets markers', async t => {
  const { runStateOperation } = await import('../assets/scripts/maintenance/state-operation.mjs');
  const { build, dir } = fixture(t), a = build('a'), b = build('b'); createBuildContext(a); createBuildContext(b);
  const live = join(dir, 'live'); fs.mkdirSync(live, { mode: 0o700 });
  const env = { ...process.env, OURS_STATE_ROOT: dir, OURS_LIVE_ROOT: live, OURS_BUILD_ROOT: a, OURS_STATE_DOMAIN: 'telegram' };
  await runStateOperation(['init', 'telegram'], env);
  await runStateOperation(['backup', 'telegram', 'original'], env);
  const archived = fs.readFileSync(join(dir, 'backups/original/build-context.json'));
  fs.rmSync(a, { recursive: true });
  const next = { ...env, OURS_BUILD_ROOT: b };
  await runStateOperation(['update', 'telegram'], next);
  await runStateOperation(['restore', 'telegram', 'original'], next);
  assert.deepEqual(fs.readFileSync(join(live, '.ours-provenance/build-context.json')), fs.readFileSync(join(b, 'build-context.json')));
  assert.deepEqual(fs.readFileSync(join(dir, 'backups/original/build-context.json')), archived);
});

test('fresh marker publication rejects partial or older generations instead of filling context', async t => {
  const { initializeBuildMarker } = await import('../assets/scripts/maintenance/build-context.mjs');
  const { build, dir } = fixture(t), a = build('a'); createBuildContext(a);
  const records = readBuildRecords(a), parent = join(dir, 'state'); fs.mkdirSync(parent, { mode: 0o700 });
  const marker = join(parent, '.ours-provenance'); fs.mkdirSync(marker, { mode: 0o700 });
  fs.writeFileSync(join(marker, 'package-lock.json'), records['package-lock.json'], { mode: 0o600 });
  assert.throws(() => initializeBuildMarker(marker, records));
  fs.writeFileSync(join(marker, 'dependency-tree.json'), records['dependency-tree.json'], { mode: 0o600 });
  assert.throws(() => initializeBuildMarker(marker, records), /reviewed update/);
  assert.equal(fs.existsSync(join(marker, 'build-context.json')), false);
});

test('maintenance init publishes complete generations and never repairs a partial marker', async t => {
  const { runStateOperation } = await import('../assets/scripts/maintenance/state-operation.mjs');
  const { build, dir } = fixture(t), target = build('target'); createBuildContext(target);
  const live = join(dir, 'live'); fs.mkdirSync(live, { mode: 0o700 });
  const env = { ...process.env, OURS_STATE_ROOT: dir, OURS_LIVE_ROOT: live, OURS_BUILD_ROOT: target, OURS_STATE_DOMAIN: 'telegram' };
  const marker = join(live, '.ours-provenance');
  await assert.rejects(runStateOperation(['init', 'telegram'], env, { beforeInitialMarker() { throw new Error('injected'); } }), /injected/);
  assert.equal(fs.existsSync(marker), false);
  await assert.rejects(runStateOperation(['init', 'telegram'], env, { afterInitialMarker() { throw new Error('injected'); } }), /injected/);
  assert.deepEqual(Object.keys(readBuildRecords(marker, { privateFiles: true, marker: true })).sort(), ['build-context.json', 'dependency-tree.json', 'package-lock.json']);
  await runStateOperation(['init', 'telegram'], env);
  fs.rmSync(marker, { recursive: true }); fs.mkdirSync(marker, { mode: 0o700 });
  fs.copyFileSync(join(target, 'package-lock.json'), join(marker, 'package-lock.json'));
  await assert.rejects(runStateOperation(['init', 'telegram'], env));
  assert.deepEqual(fs.readdirSync(marker), ['package-lock.json']);
});

test('server rejects a context carried by only some component markers before backup', async t => {
  const { runStateOperation } = await import('../assets/scripts/maintenance/state-operation.mjs');
  const { initializeBuildMarker } = await import('../assets/scripts/maintenance/build-context.mjs');
  const { build, dir } = fixture(t), target = build('target'); createBuildContext(target);
  const records = readBuildRecords(target), live = join(dir, 'live'); fs.mkdirSync(live, { mode: 0o700 });
  for (const component of ['daemon', 'telegram', 'cowork', 'messenger', 'mcp', 'credentials']) {
    fs.mkdirSync(join(live, component), { mode: 0o700 });
    if (!['mcp', 'credentials'].includes(component)) initializeBuildMarker(join(live, component, '.ours-provenance'), records);
  }
  fs.unlinkSync(join(live, 'telegram/.ours-provenance/build-context.json'));
  const env = { ...process.env, OURS_STATE_ROOT: dir, OURS_LIVE_ROOT: live, OURS_BUILD_ROOT: target, OURS_STATE_DOMAIN: 'server', OURS_COWORK_CLI_PATH: '/usr/bin/true', OURS_COWORK_CONFIG: join(live, 'cowork/config.json') };
  await assert.rejects(runStateOperation(['backup', 'server', 'mixed'], env), /provenance/);
  assert.equal(fs.existsSync(join(dir, 'backups')), false);
});
