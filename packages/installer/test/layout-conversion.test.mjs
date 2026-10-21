import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installationPaths } from '../lib/plan.mjs';

test('legacy package staging preserves opaque data and uses final deployment paths', async () => {
  const { stageLegacyPackageState, prepareLegacyPackageState, convertPackageInstallation } = await import('../lib/layout-conversion.mjs');
  const { extractArchive } = await import('../assets/scripts/maintenance/state-archive.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ours-layout-conversion-')));
  const record = {
    schema: 1, mode: 'packages', root, configPath: join(root, 'config.json'),
    sourcesPath: join(root, 'sources.json'), workDir: join(root, 'runtime'),
    project: 'ours-fixture', instanceId: '12345678-1234-1234-1234-123456789abc',
    services: ['daemon', 'telegram', 'cowork', 'messenger'], port: 3050,
  };
  const paths = installationPaths(record);
  const staging = join(root, 'storage/.maintenance/conversion');
  const write = (path, value) => fs.writeFileSync(path, value, { mode: 0o600 });
  try {
    for (const path of [paths.daemon, paths.mcp, paths.telegram, paths.cowork, paths.messenger, record.workDir, join(root, 'credentials'), join(root, 'storage/.maintenance')]) fs.mkdirSync(path, { recursive: true, mode: 0o700 });
    for (const name of ['package-lock.json', 'dependency-tree.json']) write(join(record.workDir, name), '{}');
    // npm produces a public-readable lockfile; archived state remains private.
    fs.chmodSync(join(record.workDir, 'package-lock.json'), 0o644);
    const config = {
      stateDir: paths.daemon, port: 3050, brokerUrl: 'preserved-setting',
      networkMcp: {
        profile: { endpoint: 'http://127.0.0.1:3050', expectedInstanceId: record.instanceId, credentialPath: join(paths.daemon, 'daemon-token') },
        applicationConfigPath: join(paths.mcp, 'config.json'),
      },
    };
    write(record.configPath, JSON.stringify(config));
    write(join(paths.daemon, 'daemon-token'), 'opaque-daemon-token');
    write(join(paths.daemon, 'identity-and-contacts'), 'opaque identity keys and contacts');
    write(join(paths.mcp, 'config.json'), '{"applicationPreferences":"opaque"}');
    write(join(paths.cowork, 'config.json'), JSON.stringify({ version: 1, stateDir: paths.cowork, rest: { port: 3052 }, custom: 'keep' }));
    for (const service of ['telegram', 'cowork', 'messenger']) {
      write(join(paths[service], 'keep'), service);
      write(paths.credentials[service], `opaque-${service}`);
    }
    const sourceConfig = fs.readFileSync(record.configPath);
    const unsafeBackup = join(paths.daemon, 'conversion-backup');
    await assert.rejects(prepareLegacyPackageState(record, staging, unsafeBackup), /backup.*directory/i);
    assert.equal(fs.existsSync(unsafeBackup), false);
    assert.equal(fs.existsSync(staging), false);
    const result = await stageLegacyPackageState(record, staging);
    assert.deepEqual(fs.readFileSync(join(staging, 'daemon/config.json')), sourceConfig, 'backup payload precedes deployment rebinding');
    fs.rmSync(staging, { recursive: true });
    const backupParent = join(root, 'storage/backups');
    fs.mkdirSync(backupParent, { mode: 0o700 });
    const backup = join(backupParent, 'conversion');
    await prepareLegacyPackageState(record, staging, backup);
    const restored = join(root, 'storage/.maintenance/restored');
    await extractArchive(backup, restored, {
      domain: 'server', uid: process.getuid(), gid: process.getgid(),
      provenance: {
        'package-lock.json': Buffer.from('{}'),
        'dependency-tree.json': Buffer.from('{}'),
      },
    });
    assert.deepEqual(fs.readFileSync(join(restored, 'daemon/config.json')), sourceConfig);
    assert.equal(fs.readFileSync(join(restored, 'daemon/identity-and-contacts'), 'utf8'), 'opaque identity keys and contacts');
    assert.equal(result.schema, 2);
    assert.equal(fs.existsSync(join(root, 'installation.json')), false, 'staging does not publish a selection');
    assert.equal(fs.existsSync(join(root, 'storage/state')), false, 'staging does not activate state');
    assert.deepEqual(fs.readFileSync(record.configPath), sourceConfig);
    assert.equal(fs.readFileSync(join(staging, 'daemon/identity-and-contacts'), 'utf8'), 'opaque identity keys and contacts');
    assert.equal(fs.readFileSync(join(staging, 'mcp/config.json'), 'utf8'), '{"applicationPreferences":"opaque"}');
    const converted = JSON.parse(fs.readFileSync(join(staging, 'daemon/config.json')));
    assert.equal(converted.stateDir, join(root, 'storage/state/daemon'));
    assert.equal(converted.brokerUrl, 'preserved-setting');
    assert.equal(converted.networkMcp.profile.credentialPath, join(root, 'storage/state/daemon/daemon-token'));
    assert.equal(converted.networkMcp.applicationConfigPath, join(root, 'storage/state/mcp/config.json'));
    assert.equal(JSON.parse(fs.readFileSync(join(staging, 'cowork/config.json'))).stateDir, join(root, 'storage/state/cowork'));
    for (const service of ['telegram', 'cowork', 'messenger']) {
      assert.equal(fs.readFileSync(join(staging, service, 'keep'), 'utf8'), service);
      assert.equal(fs.readFileSync(join(staging, 'credentials', service, 'daemon-token'), 'utf8'), `opaque-${service}`);
    }
    fs.rmSync(staging, { recursive: true });
    const backupBytes = fs.readFileSync(join(backup, 'state.tar'));
    await assert.rejects(prepareLegacyPackageState(record, staging, backup), { code: 'EEXIST' });
    assert.equal(fs.existsSync(staging), false, 'failed backup must not leave a prepared target');
    assert.deepEqual(fs.readFileSync(join(backup, 'state.tar')), backupBytes);
    assert.deepEqual(fs.readFileSync(record.configPath), sourceConfig);
    write(join(paths.daemon, 'config.json'), '{"conflict":true}');
    await assert.rejects(stageLegacyPackageState(record, staging), /conflicting.*config/i);
    assert.equal(fs.existsSync(staging), false);
    fs.unlinkSync(join(paths.daemon, 'config.json'));

    // A failed first activation keeps both the backup and old source; retry must
    // continue from the published new state instead of restoring an old identity.
    const selectionPath = join(root, 'installation.json');
    write(selectionPath, JSON.stringify(record));
    const events = [];
    let failActivation = true;
    let failRetention = true;
    const cli = process.env.OURS_TEST_ACCESS_CLI
      ? join(process.env.OURS_TEST_ACCESS_CLI, 'dist/cli.js') : null;
    const access = (operation, ...args) => execFileSync(process.execPath, [
      cli, 'config', operation, '--config', record.configPath, ...args, '--json',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const effects = {
      writeJson: (path, bytes) => write(path, bytes),
      prepareInstallation: async (_record, options) => {
        assert.equal(options.runtimeOnly, true);
        events.push('runtime');
      },
      serverLifecycle: async (selected, operation) => {
        if (operation === 'status') return ['daemon'];
        assert.equal(JSON.parse(fs.readFileSync(selectionPath)).schema, 2);
        assert.equal(selected.schema, 2);
        if (operation === 'stop') { events.push('stop'); return; }
        events.push('start');
        if (failActivation) throw new Error('activation failed');
      },
      retireLegacyServices: async () => {
        assert.equal(JSON.parse(fs.readFileSync(selectionPath)).layoutConversion.version, 1);
        events.push('retire');
      },
      prepareLegacyPackageSource: async () => { events.push('prepare-source'); },
      retainConvertedPackageAuthority: async (_record, daemon) => {
        assert.equal(fs.existsSync(join(daemon, 'identity-and-contacts')), true);
        events.push('retain');
        if (failRetention) throw new Error('retention interrupted');
        if (cli) access('access-retain', '--target-state-dir', daemon);
      },
    };
    write(record.configPath, JSON.stringify({ ...config, stateDir: '/different/authority' }));
    await assert.rejects(convertPackageInstallation(record, 'install', effects), /authority.*source/i);
    assert.deepEqual(events, []);
    write(record.configPath, sourceConfig);
    const authority = new Map();
    if (cli) {
      access('access-init', '--migrate');
      const credentials = [[join(paths.daemon, 'daemon-token'), 'daemon/daemon-token'],
        ...['telegram', 'cowork', 'messenger'].map(service => [paths.credentials[service], `credentials/${service}/daemon-token`])];
      for (const [source, destination] of credentials) {
        access('access-issue', '--output', source, '--replace');
        authority.set(destination, fs.readFileSync(source));
      }
      authority.set('daemon/api-master.key', fs.readFileSync(join(paths.daemon, 'api-master.key')));
    }
    await assert.rejects(convertPackageInstallation(record, 'install', effects), /retention interrupted/);
    const preparing = JSON.parse(fs.readFileSync(selectionPath));
    assert.equal(preparing.schema, 1);
    assert.ok(preparing.layoutConversion);
    const firstBackup = fs.readFileSync(join(preparing.layoutConversion.backupPath, 'state.tar'));
    assert.equal(fs.existsSync(join(root, 'storage/state')), false);
    assert.ok(fs.existsSync(paths.daemon));
    failRetention = false;
    events.length = 0;
    await assert.rejects(convertPackageInstallation(preparing, 'install', effects), /activation failed/);
    const pending = JSON.parse(fs.readFileSync(selectionPath));
    assert.equal(pending.schema, 2);
    assert.ok(pending.layoutConversion);
    assert.ok(fs.existsSync(join(pending.layoutConversion.backupPath, 'state.tar')));
    assert.equal(pending.layoutConversion.backupPath, preparing.layoutConversion.backupPath);
    assert.deepEqual(fs.readFileSync(join(pending.layoutConversion.backupPath, 'state.tar')), firstBackup);
    assert.ok(fs.existsSync(paths.daemon));
    assert.deepEqual(events, ['runtime', 'retire', 'prepare-source', 'retain', 'start']);
    const activatedIdentity = join(root, 'storage/state/daemon/identity-and-contacts');
    write(activatedIdentity, 'new state after selection commit');
    failActivation = false;
    events.length = 0;
    const convertedCowork = join(root, 'storage/state/cowork/config.json');
    const validCowork = fs.readFileSync(convertedCowork);
    write(convertedCowork, '{');
    await assert.rejects(convertPackageInstallation(pending, 'start', effects));
    assert.deepEqual(events, ['stop', 'prepare-source']);
    assert.ok(fs.existsSync(paths.daemon), 'invalid stopped component must retain the old source');
    assert.ok(JSON.parse(fs.readFileSync(selectionPath)).layoutConversion);
    write(convertedCowork, validCowork);
    events.length = 0;
    await convertPackageInstallation(pending, 'start', effects);
    assert.deepEqual(events, ['stop', 'prepare-source', 'start']);
    assert.equal(fs.readFileSync(activatedIdentity, 'utf8'), 'new state after selection commit');
    assert.equal(fs.existsSync(paths.daemon), false);
    assert.equal(fs.existsSync(paths.mcp), false);
    assert.equal(fs.existsSync(record.configPath), false);
    assert.equal(fs.existsSync(record.workDir), true);
    assert.ok(fs.existsSync(pending.layoutConversion.backupPath));
    assert.equal(JSON.parse(fs.readFileSync(selectionPath)).layoutConversion, undefined);
    for (const [path, bytes] of authority) {
      assert.deepEqual(fs.readFileSync(join(root, 'storage/state', path)), bytes);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
