import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('JS state operation backs up before restore and reset and restores selected data', async () => {
  const { runStateOperation } = await import('../assets/scripts/maintenance/state-operation.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ours-state-op-js-')));
  const state = join(root, 'storage'), live = join(state, 'state'), build = join(root, 'build');
  try {
    for (const path of [state, live, build]) fs.mkdirSync(path, { mode: 0o700 });
    for (const name of ['package-lock.json', 'dependency-tree.json']) fs.writeFileSync(join(build, name), '{}', { mode: 0o600 });
    const env = { ...process.env, OURS_STATE_ROOT: state, OURS_LIVE_ROOT: live, OURS_BUILD_ROOT: build, OURS_STATE_DOMAIN: 'telegram' };
    fs.writeFileSync(join(live, 'state.json'), '{"retained":true}', { mode: 0o600 });
    await runStateOperation(['init', 'telegram', '--adopt-existing'], env);
    await runStateOperation(['backup', 'telegram', 'original'], env);
    fs.writeFileSync(join(live, 'state.json'), '{"changed":true}');
    await runStateOperation(['restore', 'telegram', 'original'], env);
    assert.equal(fs.readFileSync(join(live, 'state.json'), 'utf8'), '{"retained":true}');
    assert.equal(fs.readdirSync(join(state, 'backups')).filter(name => name.startsWith('pre-restore-')).length, 1);
    await runStateOperation(['reset', 'telegram', '--confirm'], env);
    assert.deepEqual(fs.readdirSync(live), ['.ours-provenance']);
    assert.equal(fs.readdirSync(join(state, 'backups')).filter(name => name.startsWith('pre-reset-')).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const binary of ['ours-daemon', 'ours']) for (const domain of ['server', 'daemon']) test(`JS ${domain} ${binary} restore retains current authority through the actual SDK`, { skip: !process.env.OURS_TEST_ACCESS_CLI }, async () => {
  const { runStateOperation } = await import('../assets/scripts/maintenance/state-operation.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ours-state-sdk-js-')));
  try {
    const live = join(root, 'state'), build = join(root, 'build');
    fs.mkdirSync(live, { mode: 0o700 }); fs.mkdirSync(build, { mode: 0o700 });
    const names = ['daemon', 'telegram', 'cowork', 'messenger'];
    const records = ['package-lock.json', 'dependency-tree.json'];
    for (const name of [...names, 'mcp', 'credentials']) fs.mkdirSync(join(live, name), { mode: 0o700 });
    for (const name of records) fs.writeFileSync(join(build, name), '{}', { mode: 0o600 });
    const config = join(live, 'daemon/config.json');
    const masterKeyPath = join(live, 'daemon/api-master.key');
    const mcpProfilePath = join(live, 'mcp/profile.json');
    for (const name of ['mcp', 'telegram', 'cowork', 'messenger']) fs.writeFileSync(join(live, name, 'keep'), name, { mode: 0o600 });
    const profile = { endpoint: 'http://127.0.0.1:3050', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: join(live, 'daemon/daemon-token') };
    fs.writeFileSync(config, JSON.stringify({ stateDir: join(live, 'daemon'), apiVisibility: 'owner', port: 3050, brokerUrl: 'archived-setting', networkMcp: { profile, applicationConfigPath: join(live, 'mcp/config.json') } }), { mode: 0o600 });
    fs.writeFileSync(mcpProfilePath, JSON.stringify(profile), { mode: 0o600 });
    fs.writeFileSync(join(live, 'cowork/config.json'), JSON.stringify({ version: 1, stateDir: join(live, 'cowork'), rest: { enabled: true, host: '127.0.0.1', port: 3052 } }), { mode: 0o600 });
    const cli = join(process.env.OURS_TEST_ACCESS_CLI, 'dist/cli.js');
    const access = (op, ...args) => execFileSync(process.execPath, [cli, 'config', op, '--config', config, ...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    access('access-init');
    fs.writeFileSync(join(live, 'daemon/keep'), 'daemon application data', { mode: 0o600 });
    for (const name of names) {
      fs.mkdirSync(join(live, name, '.ours-provenance'), { mode: 0o700 });
      for (const record of records) fs.writeFileSync(join(live, name, '.ours-provenance', record), '{}', { mode: 0o600 });
    }
    const tokens = ['daemon/daemon-token'];
    for (const name of ['telegram', 'cowork', 'messenger']) { fs.mkdirSync(join(live, 'credentials', name), { mode: 0o700 }); tokens.push(`credentials/${name}/daemon-token`); }
    for (const path of tokens) access('access-issue', '--output', join(live, path));
    const compose = fs.readFileSync(new URL('../assets/docker-compose.yaml', import.meta.url), 'utf8');
    const selectedBin = compose.match(/(OURS_DAEMON_BIN_DIR): (\/opt\/ours\/node_modules\/\.bin)/);
    assert.ok(selectedBin, 'compose must select a runtime bin directory, not the thin CLI');
    assert.doesNotMatch(compose, /OURS_CLI_PATH:/);
    const bin = join(build, 'node_modules/.bin'); fs.mkdirSync(bin, { recursive: true }); fs.symlinkSync(cli, join(bin, binary));
    const env = { ...process.env, [selectedBin[1]]: bin, OURS_CLI_PATH: undefined, OURS_STATE_ROOT: root, OURS_LIVE_ROOT: live, OURS_BUILD_ROOT: build, OURS_STATE_DOMAIN: domain, OURS_DAEMON_CONFIG: config, OURS_COWORK_CLI_PATH: '/usr/bin/true', OURS_COWORK_CONFIG: join(live, 'cowork/config.json') };
    // This fixture has no Cowork sockets; only its offline-preparation command is stubbed.
    await runStateOperation(['backup', domain, 'before-rotation'], env);
    fs.writeFileSync(join(live, 'mcp/keep'), 'changed MCP preferences');
    for (const name of ['telegram', 'cowork', 'messenger']) fs.writeFileSync(join(live, name, 'keep'), 'current ' + name);
    const current = JSON.parse(fs.readFileSync(config)); current.port = 4050; current.brokerUrl = 'changed-setting'; current.networkMcp.profile.endpoint = 'http://127.0.0.1:4050'; fs.writeFileSync(config, JSON.stringify(current));
    fs.writeFileSync(mcpProfilePath, JSON.stringify(current.networkMcp.profile));
    access('access-replace', '--confirm');
    for (const path of tokens) access('access-issue', '--output', join(live, path), '--replace');
    const master = fs.readFileSync(masterKeyPath);
    const credentials = tokens.map(path => fs.readFileSync(join(live, path)));
    await runStateOperation(['restore', domain, 'before-rotation'], env);
    assert.deepEqual(fs.readFileSync(masterKeyPath), master);
    for (const [index, path] of tokens.entries()) assert.deepEqual(fs.readFileSync(join(live, path)), credentials[index]);
    assert.equal(JSON.parse(fs.readFileSync(config)).port, 4050);
    assert.equal(JSON.parse(fs.readFileSync(config)).brokerUrl, 'archived-setting');
    assert.equal(fs.readFileSync(join(live, 'mcp/keep'), 'utf8'), 'mcp');
    assert.deepEqual(JSON.parse(fs.readFileSync(mcpProfilePath)), current.networkMcp.profile);
    for (const name of ['telegram', 'cowork', 'messenger']) assert.equal(fs.readFileSync(join(live, name, 'keep'), 'utf8'), domain === 'daemon' ? 'current ' + name : name);
    if (domain === 'daemon') {
      await assert.rejects(runStateOperation(['reset', 'daemon', '--confirm'], { ...env, OURS_CLI_PATH: '/usr/bin/false' }), /owning package/);
      assert.equal(fs.readFileSync(join(live, 'daemon/keep'), 'utf8'), 'daemon application data');
      assert.equal(fs.readFileSync(join(live, 'mcp/keep'), 'utf8'), 'mcp');
      await runStateOperation(['reset', 'daemon', '--confirm'], env);
      assert.equal(fs.existsSync(join(live, 'daemon/keep')), false);
      assert.deepEqual(fs.readdirSync(join(live, 'mcp')), ['profile.json']);
      assert.deepEqual(JSON.parse(fs.readFileSync(mcpProfilePath)), current.networkMcp.profile);
      assert.deepEqual(fs.readFileSync(masterKeyPath), master);
      for (const [index, path] of tokens.entries()) assert.deepEqual(fs.readFileSync(join(live, path)), credentials[index]);
      for (const name of ['telegram', 'cowork', 'messenger']) assert.equal(fs.readFileSync(join(live, name, 'keep'), 'utf8'), 'current ' + name);
      const reset = JSON.parse(fs.readFileSync(config));
      assert.equal(reset.port, 4050); assert.equal(reset.stateDir, join(live, 'daemon'));
      assert.equal(reset.brokerUrl, undefined);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('owner refusal preserves live state; successful preparation and retention precede replacement', async () => {
  const { runStateOperation } = await import('../assets/scripts/maintenance/state-operation.mjs');
  await assert.rejects(runStateOperation(['backup', 'daemon', 'snapshot'], {}), /OURS_STATE_ROOT/);
  for (const domain of ['cowork']) {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ours-state-owner-js-')));
    try {
      const live = join(root, 'live'), build = join(root, 'build'), config = join(root, 'config.json'), owner = join(root, 'owner.mjs');
      for (const path of [live, build]) fs.mkdirSync(path, { mode: 0o700 });
      for (const name of ['package-lock.json', 'dependency-tree.json']) fs.writeFileSync(join(build, name), '{}', { mode: 0o600 });
      fs.writeFileSync(config, '{}', { mode: 0o600 });
      fs.writeFileSync(join(live, 'keep'), 'original', { mode: 0o600 });
      fs.writeFileSync(owner, `#!/usr/bin/env node
import * as fs from 'node:fs';import assert from 'node:assert/strict';
assert.equal(fs.readFileSync(process.env.OURS_LIVE_ROOT+'/keep','utf8'),'original');
if(process.env.OURS_FIXTURE_OWNER_FAIL)process.exit(1);
const args=process.argv.slice(2);
if(args.includes('prepare-backup')) {assert.deepEqual(args,['--json','prepare-backup']);assert.equal(process.env.OURS_COWORK_CONFIG,${JSON.stringify(config)});}
else {assert.equal(args[1],'access-retain');assert.equal(args[args.indexOf('--config')+1],${JSON.stringify(config)});const stage=args[args.indexOf('--target-state-dir')+1];fs.writeFileSync(stage+'/owner-retained','opaque',{mode:0o600});}
`, { mode: 0o700 });
      const env = { ...process.env, OURS_STATE_ROOT: root, OURS_LIVE_ROOT: live, OURS_BUILD_ROOT: build, OURS_STATE_DOMAIN: domain,
        OURS_CLI_PATH: owner, OURS_DAEMON_CONFIG: config, OURS_COWORK_CLI_PATH: owner, OURS_COWORK_CONFIG: config };
      await runStateOperation(['init', domain, '--adopt-existing'], env);
      await assert.rejects(runStateOperation(['reset', domain, '--confirm'], { ...env, OURS_FIXTURE_OWNER_FAIL: '1' }), /owning package/);
      assert.equal(fs.readFileSync(join(live, 'keep'), 'utf8'), 'original');
      await runStateOperation(['reset', domain, '--confirm'], env);
      assert.equal(fs.existsSync(join(live, 'keep')), false);
      if (domain === 'daemon') assert.equal(fs.readFileSync(join(live, 'owner-retained'), 'utf8'), 'opaque');
      assert.ok(fs.readdirSync(join(root, 'backups')).some(name => name.startsWith('pre-reset-')));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

for (const operation of ['update', 'rebuild']) test(`full-server ${operation} backs up old provenance and preserves all component data`, async () => {
  const { runStateOperation } = await import('../assets/scripts/maintenance/state-operation.mjs');
  const { extractArchive } = await import('../assets/scripts/maintenance/state-archive.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ours-state-update-')));
  const live = join(root, 'live'), build = join(root, 'build');
  const components = ['daemon', 'telegram', 'cowork', 'messenger'];
  const records = ['package-lock.json', 'dependency-tree.json'];
  const old = Object.fromEntries(records.map(name => [name, Buffer.from('{"build":"old"}')]));
  try {
    for (const path of [live, build]) fs.mkdirSync(path, { mode: 0o700 });
    for (const name of records) fs.writeFileSync(join(build, name), '{"build":"new"}', { mode: 0o600 });
    for (const name of [...components, 'mcp', 'credentials']) {
      fs.mkdirSync(join(live, name), { mode: 0o700 });
      fs.writeFileSync(join(live, name, 'retained'), name, { mode: 0o600 });
      if (!components.includes(name)) continue;
      fs.mkdirSync(join(live, name, '.ours-provenance'), { mode: 0o700 });
      for (const record of records) fs.writeFileSync(join(live, name, '.ours-provenance', record), old[record], { mode: 0o600 });
    }
    const env = { ...process.env, OURS_STATE_ROOT: root, OURS_LIVE_ROOT: live, OURS_BUILD_ROOT: build,
      OURS_STATE_DOMAIN: 'server', OURS_COWORK_CLI_PATH: '/usr/bin/true', OURS_COWORK_CONFIG: join(live, 'cowork/config.json') };
    // No runtime sockets in this fixture; only the external Cowork preparation is stubbed.
    await assert.rejects(runStateOperation(['update', 'server'], env), /compatibility/);
    assert.equal(fs.existsSync(join(root, 'backups')), false);
    if (operation === 'rebuild') {
      await assert.rejects(runStateOperation(['rebuild', 'server'], env), /compatibility/);
      assert.equal(fs.existsSync(join(root, 'backups')), false);
      // A rebuild may retain equivalent records; changed records require update.
      for (const name of records) fs.writeFileSync(join(build, name), old[name]);
    }
    await runStateOperation([operation, 'server', ...(operation === 'update' ? ['--compatible'] : [])], env);
    for (const name of [...components, 'mcp', 'credentials']) assert.equal(fs.readFileSync(join(live, name, 'retained'), 'utf8'), name);
    for (const name of components) for (const record of records) assert.equal(fs.readFileSync(join(live, name, '.ours-provenance', record), 'utf8'), operation === 'rebuild' ? old[record].toString() : '{"build":"new"}');
    const backup = fs.readdirSync(join(root, 'backups')).find(name => name.startsWith('pre-update-'));
    await extractArchive(join(root, 'backups', backup), join(root, 'restored'), { domain: 'server', uid: process.getuid(), gid: process.getgid(), provenance: old });
    for (const name of components) assert.equal(fs.readFileSync(join(root, 'restored', name, '.ours-provenance/package-lock.json'), 'utf8'), '{"build":"old"}');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
