import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Docker layout staging separates complete MCP state and preserves original source and credentials', async () => {
  const { stageDockerLayout, bindDockerLayout, prepareDockerLayout, cleanupDockerSource, validateDockerLayout } = await import('../assets/scripts/maintenance/docker-layout-conversion.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ours-docker-layout-')));
  const source = join(root, 'source');
  const staging = join(root, 'staging');
  const instanceId = '12345678-1234-1234-1234-123456789abc';
  const provenance = { 'package-lock.json': Buffer.from('{}'), 'dependency-tree.json': Buffer.from('{}') };
  const options = { uid: process.getuid(), gid: process.getgid(), instanceId, provenance };
  const write = (path, value) => fs.writeFileSync(path, value, { mode: 0o600 });
  try {
    for (const component of ['daemon', 'telegram', 'cowork', 'messenger']) {
      const data = join(source, component, 'data');
      fs.mkdirSync(join(data, '.ours-provenance'), { recursive: true, mode: 0o700 });
      for (const [name, bytes] of Object.entries(provenance)) write(join(data, '.ours-provenance', name), bytes);
      write(join(data, 'opaque-state'), `${component} state`);
      if (component !== 'daemon') {
        const credentials = join(source, `${component}-credential`);
        fs.mkdirSync(credentials, { mode: 0o700 });
        write(join(credentials, 'daemon-token'), `${component} credential`);
      }
    }
    const mcp = join(source, 'daemon/data/.mcp');
    fs.mkdirSync(mcp, { mode: 0o700 });
    write(join(mcp, 'config.json'), '{"preferences":"preserved"}');
    write(join(mcp, 'other-state'), 'entire MCP tree');
    const profile = { endpoint: 'http://127.0.0.1:3050', expectedInstanceId: instanceId, credentialPath: '/var/lib/ours/daemon-token' };
    write(join(mcp, 'profile.json'), JSON.stringify(profile));
    const configPath = join(source, 'daemon/data/config.json');
    const config = { stateDir: '/var/lib/ours', port: 3050, custom: 'keep', networkMcp: { profile, applicationConfigPath: '/var/lib/ours/.mcp/config.json' } };
    write(configPath, JSON.stringify(config));
    write(join(source, 'daemon/data/daemon-token'), 'current local credential');
    write(join(source, 'cowork/data/config.json'), JSON.stringify({ stateDir: '/var/lib/ours-cowork' }));
    const original = fs.readFileSync(configPath);
    const unsafeStaging = join(source, 'telegram-credential', 'conversion');
    await assert.rejects(stageDockerLayout(source, unsafeStaging, options), /outside.*source/i);
    assert.equal(fs.existsSync(unsafeStaging), false);
    await stageDockerLayout(source, staging, options);
    assert.deepEqual(fs.readFileSync(join(staging, 'daemon/config.json')), original, 'backup receives the original config');
    bindDockerLayout(staging, options);
    assert.deepEqual(fs.readFileSync(configPath), original);
    assert.equal(fs.existsSync(join(staging, 'daemon/.mcp')), false);
    assert.equal(fs.readFileSync(join(staging, 'mcp/other-state'), 'utf8'), 'entire MCP tree');
    assert.equal(JSON.parse(fs.readFileSync(join(staging, 'daemon/config.json'))).networkMcp.applicationConfigPath, '/var/lib/ours-mcp/config.json');
    assert.equal(JSON.parse(fs.readFileSync(join(staging, 'daemon/config.json'))).custom, 'keep');
    for (const service of ['telegram', 'cowork', 'messenger']) {
      assert.equal(fs.readFileSync(join(staging, 'credentials', service, 'daemon-token'), 'utf8'), `${service} credential`);
      assert.equal(fs.readFileSync(join(staging, service, 'opaque-state'), 'utf8'), `${service} state`);
    }
    fs.rmSync(staging, { recursive: true });
    const storage = join(root, 'storage');
    fs.mkdirSync(storage, { mode: 0o700 });
    const cli = join(root, 'owner.mjs');
    write(cli, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nif (args[0] !== 'config' || args[1] !== 'access-retain') process.exit(2);\nif (!fs.existsSync(${JSON.stringify(join(storage, 'backups/original'))})) process.exit(3);\n`);
    fs.chmodSync(cli, 0o700);
    await prepareDockerLayout(source, storage, 'original', { ...options, cli, configPath });
    const published = join(storage, 'state');
    const backup = fs.readFileSync(join(storage, 'backups/original/state.tar'));
    const managedConfigPath = join(published, 'daemon/config.json');
    const retainedConfig = JSON.parse(fs.readFileSync(managedConfigPath));
    const freshConfig = { ...retainedConfig }; delete freshConfig.networkMcp;
    write(managedConfigPath, JSON.stringify(freshConfig));
    assert.doesNotThrow(() => validateDockerLayout(published, options), 'fresh installs have no embedded networkMcp');
    for (const networkMcp of [null, {}, { ...retainedConfig.networkMcp, applicationConfigPath: '/external/config.json' }]) {
      write(managedConfigPath, JSON.stringify({ ...freshConfig, networkMcp }));
      assert.throws(() => validateDockerLayout(published, options), /configuration is inconsistent/);
    }
    write(managedConfigPath, JSON.stringify(retainedConfig));

    assert.equal(fs.readFileSync(join(published, 'mcp/other-state'), 'utf8'), 'entire MCP tree');
    assert.equal(JSON.parse(fs.readFileSync(join(published, 'daemon/config.json'))).networkMcp.applicationConfigPath, '/var/lib/ours-mcp/config.json');
    assert.deepEqual(fs.readFileSync(configPath), original);
    write(join(published, 'unpublished-residue'), 'discard on schema-1 retry');
    await assert.rejects(prepareDockerLayout(source, storage, 'original', { ...options, cli: '/missing-owner', configPath }));
    assert.equal(fs.readFileSync(join(published, 'unpublished-residue'), 'utf8'), 'discard on schema-1 retry');
    assert.deepEqual(fs.readFileSync(configPath), original);
    await prepareDockerLayout(source, storage, 'original', { ...options, cli, configPath });
    assert.equal(fs.existsSync(join(published, 'unpublished-residue')), false);
    assert.deepEqual(fs.readFileSync(join(storage, 'backups/original/state.tar')), backup);
    await assert.rejects(prepareDockerLayout(source, storage, '../outside', { ...options, cli, configPath }), /label/i);
    if (process.getuid() !== 0 && process.getgid() !== 0) {
      const build = join(root, 'build');
      fs.mkdirSync(build, { mode: 0o700 });
      for (const [name, bytes] of Object.entries(provenance)) write(join(build, name), bytes);
      const cowork = join(root, 'cowork.mjs');
      write(cowork, `#!${process.execPath}\nif(process.argv.slice(2).join(' ')!=='--json prepare-backup')process.exit(2);`);
      fs.chmodSync(cowork, 0o700);
      const entrypoint = fileURLToPath(new URL('../assets/scripts/maintenance/docker-layout-conversion.mjs', import.meta.url));
      const bin = join(build, 'node_modules/.bin'); fs.mkdirSync(bin, { recursive: true }); fs.symlinkSync(cli, join(bin, 'ours-daemon'));
      const env = { ...process.env, OURS_STATE_ROOT: storage, OURS_CONVERSION_SOURCE: source,
        OURS_BUILD_ROOT: build, OURS_DAEMON_ID: instanceId, OURS_CLI_PATH: undefined, OURS_DAEMON_BIN_DIR: bin,
        OURS_DAEMON_CONFIG: configPath, OURS_COWORK_CLI_PATH: cowork };
      execFileSync(process.execPath, [entrypoint, 'validate'], { env });
      write(join(published, 'cowork/config.json'), '{}');
      assert.throws(() => execFileSync(process.execPath, [entrypoint, 'validate'], { env, stdio: 'pipe' }));
      execFileSync(process.execPath, [entrypoint, 'prepare', 'original'], { env });
      assert.equal(JSON.parse(fs.readFileSync(join(published, 'cowork/config.json'))).stateDir, '/var/lib/ours-cowork');
    }
    write(configPath, JSON.stringify({ ...config, networkMcp: { ...config.networkMcp, applicationConfigPath: '/external/config.json' } }));
    await assert.rejects(stageDockerLayout(source, staging, options), /MCP.*source/i);
    assert.equal(fs.existsSync(staging), false);
    assert.equal(fs.readFileSync(join(mcp, 'other-state'), 'utf8'), 'entire MCP tree');
    fs.mkdirSync(join(source, 'cowork/backups'), { mode: 0o700 });
    write(join(source, 'cowork/backups/keep'), 'protected older backup');
    const empty = cleanupDockerSource(source, options);
    assert.ok(empty.includes('daemon'));
    assert.equal(empty.includes('cowork'), false);
    assert.equal(fs.existsSync(join(source, 'daemon/data')), false);
    assert.equal(fs.existsSync(join(source, 'telegram-credential/daemon-token')), false);
    assert.equal(fs.readFileSync(join(source, 'cowork/backups/keep'), 'utf8'), 'protected older backup');
    assert.equal(fs.readFileSync(join(published, 'mcp/other-state'), 'utf8'), 'entire MCP tree');
    assert.deepEqual(fs.readFileSync(join(storage, 'backups/original/state.tar')), backup);
    assert.deepEqual(cleanupDockerSource(source, options), empty);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
