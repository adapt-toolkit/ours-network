import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLegacyMigration, executeLegacyMigration } from '../lib/legacy-migration.mjs';
import { atomicWriteConfig } from '../lib/config.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'legacy-migration-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceStateDir = join(root, 'custom-state');
  const sourceConfig = join(root, 'config.json');
  const targetRoot = join(root, 'managed');
  mkdirSync(sourceStateDir, { mode: 0o700 }); mkdirSync(targetRoot, { mode: 0o700 });
  const sourceConfigBytes = JSON.stringify({ stateDir: sourceStateDir, port: 4050 }) + '\n';
  writeFileSync(sourceConfig, sourceConfigBytes, { mode: 0o600 });
  const identities = [{ name: 'Human', kind: 'root', cid: 'human-cid' }, { name: 'Builder', kind: 'role', cid: 'builder-cid' }];
  const events = [];
  let failAt, failed = false, copied = false, failComplete = false;
  const at = name => { events.push(name); if (failAt === name && !failed) { failed = true; throw new Error(`fixture failure: ${name}`); } };
  const record = { schema: 2, root: targetRoot, mode: 'packages', sourcesPath: join(targetRoot, 'sources.json'), port: 4050, instanceId: '12345678-1234-1234-1234-123456789abc' };
  const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path)) : null;
  const deps = {
    prepareMigrationCliRuntime: async () => { at('prepare-cli'); return '/fixture/install.mjs'; },
    inspectManagedCli: async () => ({ originalProgram: 'ours' }),
    installManagedCli: async () => at('cli-cutover'),
    ensureLegacyLockSupport: async () => at('lock-support'),
    inspectLegacyState(configPath) {
      const config = readJson(configPath);
      assert.equal(config?.stateDir, sourceStateDir, 'inspection must retain the original custom state selection');
      return { configPath, stateDir: sourceStateDir, config, rootName: 'Human' };
    },
    stageLegacyState(source) {
      assert.equal(source.stateDir, sourceStateDir);
      at(copied ? 'reuse-state' : 'copy-state'); copied = true;
    },
    withLegacyStateLock: async state => { assert.equal(state, sourceStateDir); at('lock'); return { close: async () => at('unlock') }; },
    atomicWriteConfig(path, contents) {
      if (failComplete && path === join(targetRoot, 'legacy-migration.json') && JSON.parse(contents).phase === 'complete') {
        failComplete = false; throw new Error('fixture failure: complete journal write');
      }
      atomicWriteConfig(path, contents);
    },
  };
  const effects = {
    readJson, out: text => events.push(`out:${text}`),
    async run(_command, args) {
      const name = `${args[0]}:${args[1]}${args.includes('--dry-run') ? ':dry-run' : ''}`; at(name);
      if (name === 'daemon:status') return { stdout: JSON.stringify({ state: 'running', stateDir: sourceStateDir }) };
      if (name === 'identity:list') return { stdout: JSON.stringify(identities) };
      return { stdout: JSON.stringify({ changed: false }) };
    },
    writeJson: (path, contents) => writeFileSync(path, contents, { mode: 0o600 }),
    resolveSourcePolicy: async policy => policy ?? {},
    async initializeSelection(selected, manifest) { at('initialize'); writeFileSync(selected.sourcesPath, JSON.stringify(manifest), { mode: 0o600 }); },
    async prepareInstallation(_selected, options) { at(options?.runtimeOnly ? 'build-runtime' : 'configure-runtime'); },
    async serverLifecycle(_selected, operation) { at(`target:${operation}`); },
    async serverEnsureIdentity() { throw new Error('must never create a replacement Human'); },
    async serverListIdentities() { at('target:identities'); return structuredClone(identities); },
    async serverAccess(_selected, action, options) {
      at(`access:${action}`);
      if (options?.output) writeFileSync(options.output, 'fixture-issued-credential', { mode: 0o600 });
    },
  };
  const install = async (args, wrapped) => {
    if (!existsSync(join(targetRoot, 'installation.json'))) {
      await wrapped.initializeSelection(record, {});
      writeFileSync(join(targetRoot, 'installation.json'), JSON.stringify(record), { mode: 0o600 });
    }
    await wrapped.prepareInstallation(record);
    await wrapped.serverLifecycle(record, 'stop');
    await wrapped.serverAccess(record, 'access-init', { migrate: args.migrate });
    await wrapped.serverLifecycle(record, 'start', ['daemon']);
    await wrapped.serverEnsureIdentity(record, 'Requested name must not replace Human');
    await wrapped.serverLifecycle(record, 'start', ['messenger']);
    return 0;
  };
  const args = { stateDir: targetRoot, migrateFrom: sourceConfig, identityName: 'Human', sourcePolicy: { packages: {} } };
  return { root, sourceStateDir, sourceConfig, sourceConfigBytes, targetRoot, identities, events, effects, deps, args, install,
    fail(name) { failAt = name; failed = false; }, failCompleteWrite() { failComplete = true; },
    async run() { const legacyPlan = await inspectLegacyMigration(args, effects, deps); return executeLegacyMigration({ ...args, legacyPlan }, effects, install, deps); }, readJson };
}

test('migration builds before stopping source, retains every identity and publishes a client profile after verification', async t => {
  const f = fixture(t);
  const originalList = f.effects.serverListIdentities;
  f.effects.serverListIdentities = async record => {
    assert.equal(readFileSync(f.sourceConfig, 'utf8'), f.sourceConfigBytes, 'source config remains unchanged throughout activation');
    return originalList(record);
  };
  assert.equal(await f.run(), 0);
  assert(f.events.indexOf('build-runtime') < f.events.indexOf('daemon:uninstall-service'));
  assert(f.events.indexOf('daemon:stop') < f.events.indexOf('lock'));
  assert(f.events.indexOf('lock') < f.events.indexOf('copy-state'));
  assert(f.events.indexOf('target:identities') < f.events.lastIndexOf('target:start'));
  assert.equal(f.events.at(-1), 'unlock');
  assert.equal(f.readJson(join(f.targetRoot, 'legacy-migration.json')).phase, 'complete');
  assert.equal(readFileSync(f.sourceConfig, 'utf8'), f.sourceConfigBytes);
  assert.equal(f.readJson(join(f.targetRoot, 'legacy-client/profile.json')).endpoint, 'http://127.0.0.1:4050');
  assert.equal(readFileSync(join(f.targetRoot, 'legacy-backup/config.json'), 'utf8'), f.sourceConfigBytes);
});

test('a missing retained role fails migration without creating a replacement Human or restarting source', async t => {
  const f = fixture(t);
  f.effects.serverListIdentities = async () => [f.identities[0]];
  await assert.rejects(f.run(), /identities differ/);
  assert.equal(readFileSync(f.sourceConfig, 'utf8'), f.sourceConfigBytes);
  assert.equal(f.events.filter(event => event === 'target:stop').length, 2);
  assert(!f.events.includes('daemon:start')); assert.equal(f.events.at(-1), 'unlock');
});

test('runtime build failure before source retirement remains retryable with the same managed target', async t => {
  const f = fixture(t); f.fail('build-runtime');
  await assert.rejects(f.run(), /before activation/);
  assert(!f.events.includes('daemon:stop')); assert(!f.events.includes('copy-state'));
  assert.equal(readFileSync(f.sourceConfig, 'utf8'), f.sourceConfigBytes);
  assert(existsSync(join(f.targetRoot, 'legacy-migration.json')), 'persist retry journal before installation writes');
  assert.equal(await f.run(), 0);
});

test('initial selection failure persists enough transaction state to retry safely', async t => {
  const f = fixture(t); f.fail('initialize');
  await assert.rejects(f.run(), /before activation/);
  assert(!f.events.includes('daemon:stop'));
  assert(existsSync(join(f.targetRoot, 'legacy-migration.json')));
  assert.equal(await f.run(), 0);
});

test('failure after activation repairs the imported target forward without recopying source or starting it', async t => {
  const f = fixture(t); f.fail('target:identities');
  await assert.rejects(f.run(), /repair the retained target/);
  const stopCount = f.events.filter(event => event === 'daemon:stop').length;
  assert.equal(await f.run(), 0);
  assert.equal(f.events.filter(event => event === 'copy-state').length, 1);
  assert.equal(f.events.filter(event => event === 'daemon:stop').length, stopCount);
  assert(!f.events.includes('daemon:start'));
});

test('completion journal failure after profile publication repairs custom-state migration forward', async t => {
  const f = fixture(t); f.failCompleteWrite();
  await assert.rejects(f.run(), /complete journal write/);
  assert.equal(readFileSync(f.sourceConfig, 'utf8'), f.sourceConfigBytes);
  assert.equal(f.readJson(join(f.targetRoot, 'legacy-client/profile.json')).endpoint, 'http://127.0.0.1:4050');
  assert.equal(await f.run(), 0);
  assert.equal(f.readJson(join(f.targetRoot, 'legacy-migration.json')).phase, 'complete');
  assert.equal(f.events.filter(event => event === 'copy-state').length, 1);
  assert(!f.events.includes('daemon:start'));
});

test('unverified source service ownership is refused before any target or source mutations', async t => {
  const f = fixture(t); const originalRun = f.effects.run;
  f.effects.run = async (command, args, options) => args.includes('--dry-run') ? { stdout: JSON.stringify({ conflict: { message: 'unowned unit' } }) } : originalRun(command, args, options);
  await assert.rejects(f.run(), /ownership could not be verified/);
  assert(!f.events.includes('initialize')); assert(!f.events.includes('daemon:stop'));
  assert(!existsSync(join(f.targetRoot, 'installation.json')));
});

test('repeating a completed migration verifies retained identities without invoking Human creation fallback', async t => {
  const f = fixture(t);
  assert.equal(await f.run(), 0);
  const copied = f.events.filter(event => event === 'copy-state').length;
  const stopped = f.events.filter(event => event === 'daemon:stop').length;
  assert.equal(await f.run(), 0);
  assert.equal(f.events.filter(event => event === 'copy-state').length, copied);
  assert.equal(f.events.filter(event => event === 'daemon:stop').length, stopped);
  assert.equal(readFileSync(f.sourceConfig, 'utf8'), f.sourceConfigBytes);
});

 test('persistent management preparation failure leaves the source running and resumes before shutdown', async t => {
  const f = fixture(t); f.fail('prepare-cli');
  await assert.rejects(f.run(), /before activation/);
  assert(!f.events.includes('daemon:stop')); assert(!f.events.includes('daemon:uninstall-service'));
  assert.equal(readFileSync(f.sourceConfig, 'utf8'), f.sourceConfigBytes);
  assert.equal(await f.run(), 0);
});

for (const dryRun of [false, true]) {
  test(`Podman legacy migration is refused before inspection or execution (dryRun=${dryRun})`, async t => {
    const f = fixture(t);
    const args = { ...f.args, mode: 'docker', containerEngine: 'podman', dryRun };
    await assert.rejects(inspectLegacyMigration(args, f.effects, f.deps), /Legacy migration to Podman is not supported/);
    await assert.rejects(executeLegacyMigration({ ...args, legacyPlan: {} }, f.effects, f.install, f.deps), /Legacy migration to Podman is not supported/);
    assert.deepEqual(f.events, []);
    assert.equal(readFileSync(f.sourceConfig, 'utf8'), f.sourceConfigBytes);
    assert.deepEqual(f.readJson(join(f.targetRoot, 'installation.json')), null);
  });
}

for (const phase of ['prepared', 'stopped', 'copied', 'activating', 'verified', 'complete']) {
  for (const location of ['journal', 'installation', 'legacyPlan']) {
    test(`retained Podman ${location} refuses ${phase} migration before any effects`, async t => {
      const f = fixture(t);
      const journal = { schema: 1, targetRoot: f.targetRoot, sourceConfig: f.sourceConfig, phase, identities: f.identities };
      const record = { mode: 'docker', containerEngine: 'podman', root: f.targetRoot };
      if (location === 'journal') journal.record = record;
      if (location === 'installation') writeFileSync(join(f.targetRoot, 'installation.json'), JSON.stringify(record), { mode: 0o600 });
      if (location !== 'legacyPlan') writeFileSync(join(f.targetRoot, 'legacy-migration.json'), JSON.stringify(journal), { mode: 0o600 });
      const args = { ...f.args, legacyPlan: { journal: { ...journal, ...(location === 'legacyPlan' ? { record } : {}) } } };
      await assert.rejects(inspectLegacyMigration(args, f.effects, f.deps), /Legacy migration to Podman is not supported/);
      await assert.rejects(executeLegacyMigration(args, f.effects, f.install, f.deps), /Legacy migration to Podman is not supported/);
      assert.deepEqual(f.events, []);
      assert.equal(readFileSync(f.sourceConfig, 'utf8'), f.sourceConfigBytes);
    });
  }
}
