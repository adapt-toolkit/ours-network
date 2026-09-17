import test from 'node:test';
import assert from 'node:assert/strict';
import * as target from '../lib/target.mjs';
import * as plan from '../lib/plan.mjs';
import { runInstall } from '../lib/orchestrate.mjs';
import { fx } from './fake-effects.mjs';

test('explicit server selection rejects ambiguous and cross-operation options', () => {
  assert.equal(typeof target.parseNetworkArgs, 'function');
  const parse = target.parseNetworkArgs;
  assert.deepEqual(parse(['server', 'install', '--mode', 'docker', '--sources', '/input/sources.json', '--state-dir', '/srv/ours']).mode, 'docker');
  assert.equal(parse(['server', 'update', '--state-dir', '/srv/ours', '--compatible']).sources, undefined);
  for (const args of [
    ['server', 'install', '--mode', 'other', '--state-dir', '/srv/ours'],
    ['server', 'restart', '--state-dir', '/srv/ours', '--sources', '/new'],
    ['server', 'access-replace', '--state-dir', '/srv/ours'],
    ['client', 'install', '--config', '/profile', '--state-dir', '/srv/ours'],
  ]) assert.throws(() => parse(args));
});

test('source selection retains complete authority but only selects server packages', () => {
  assert.equal(typeof plan.selectSourcePackages, 'function');
  const packages = Object.fromEntries(['sdk', 'cli', 'mcp', 'tg-connector', 'cowork', 'messenger-server', 'fleet', 'codex', 'claude-code', 'install'].map(n => [`@ours.network/${n}`, { type: 'npm', version: '2.6.2' }]));
  assert.deepEqual(Object.keys(plan.selectSourcePackages({ packages }, 'server')), ['@ours.network/sdk', '@ours.network/cli', '@ours.network/mcp', '@ours.network/tg-connector', '@ours.network/cowork', '@ours.network/messenger-server']);
  assert.equal(Object.keys(packages).length, 10);
  assert.throws(() => plan.selectSourcePackages({ packages: { ...packages, '@ours.network/sdk': { type: 'npm', version: 'latest' } } }, 'server'));
});

test('source policy resolves selected npm ranges to exact versions and preserves exact Git commits', async () => {
  const commit = 'd'.repeat(40);
  const policy = { sources: { mcp: { type: 'git', url: 'https://example.invalid/ours-mcp.git', commit } }, packages: {
    '@ours.network/sdk': { type: 'npm', version: '^2.0.1' },
    '@ours.network/cli': { type: 'npm', version: '~2.1.0' },
    '@ours.network/mcp': { source: 'mcp' },
    '@ours.network/tg-connector': { type: 'npm', version: '2.0.4' },
    '@ours.network/cowork': { type: 'npm', version: '2.0.5' },
    '@ours.network/messenger-server': { type: 'npm', version: '2.0.6' },
    '@ours.network/fleet': { type: 'npm', version: '^9.0.0' },
  } };
  const requested = [];
  const resolved = await plan.resolveSourcePolicy(policy, 'server', [], async (name, range) => {
    requested.push([name, range]);
    return name === '@ours.network/sdk' ? '2.3.4' : '2.1.7';
  });
  assert.deepEqual(requested, [['@ours.network/sdk', '^2.0.1'], ['@ours.network/cli', '~2.1.0']]);
  assert.deepEqual(resolved.sources, policy.sources);
  assert.deepEqual(resolved.packages['@ours.network/sdk'], { type: 'npm', version: '2.3.4' });
  assert.deepEqual(resolved.packages['@ours.network/cli'], { type: 'npm', version: '2.1.7' });
  assert.deepEqual(resolved.packages['@ours.network/mcp'], { source: 'mcp' });
  assert.equal(resolved.packages['@ours.network/fleet'], undefined);
});

test('source policy refuses an npm resolution outside its allowed range', async () => {
  const packages = Object.fromEntries(plan.SERVER_PACKAGES.map(name => [name, { type: 'npm', version: name.endsWith('/sdk') ? '^2.0.1' : '2.0.1' }]));
  for (const version of ['2.0.1-alpha', '3.0.0']) {
    await assert.rejects(plan.resolveSourcePolicy({ packages }, 'server', [], async () => version), /outside allowed range/);
  }
  packages['@ours.network/sdk'].version = '~2.0.1';
  await assert.rejects(plan.resolveSourcePolicy({ packages }, 'server', [], async () => '2.1.0'), /outside allowed range/);
  packages['@ours.network/sdk'].version = '^0.2.1';
  await assert.rejects(plan.resolveSourcePolicy({ packages }, 'server', [], async () => '0.3.0'), /outside allowed range/);
  packages['@ours.network/sdk'].version = '02.0.1';
  await assert.rejects(plan.resolveSourcePolicy({ packages }, 'server', [], async () => '2.0.1'), /Invalid npm source policy/);
});

test('source policy accepts exact build metadata under standard SemVer syntax', async () => {
  const packages = Object.fromEntries(plan.SERVER_PACKAGES.map(name => [name, { type: 'npm', version: '2.0.1+build.7' }]));
  const exact = await plan.resolveSourcePolicy({ packages }, 'server', [], async () => assert.fail('exact versions do not resolve'));
  assert.equal(exact.packages['@ours.network/sdk'].version, '2.0.1+build.7');
});

test('update and rebuild prepare isolated runtimes without replacing the active selection', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = fs.mkdtempSync(join(tmpdir(), 'ours-build-candidate-'));
  const manifest = version => JSON.stringify({ packages: Object.fromEntries(plan.SERVER_PACKAGES.map(name => [name, { type: 'npm', version }])) });
  const original = manifest('1.2.3'), replacement = manifest('1.2.4');
  const sourcesPath = join(root, 'sources.json'), next = join(root, 'next.json');
  fs.writeFileSync(sourcesPath, original, { mode: 0o600 });
  fs.writeFileSync(next, replacement, { mode: 0o600 });
  const record = { schema: 2, root, mode: 'packages', sourcesPath, workDir: join(root, 'runtime'),
    configPath: join(root, 'storage/state/daemon/config.json'), instanceId: '12345678-1234-1234-1234-123456789abc',
    project: 'ours-fixture', services: ['daemon', 'telegram', 'cowork', 'messenger'] };
  fs.mkdirSync(record.workDir);
  fs.writeFileSync(join(record.workDir, 'active'), 'retained');
  try {
    for (const mode of ['packages', 'docker']) for (const operation of ['update', 'rebuild']) {
      const effects = realEffects({ env: {}, home: root });
      let candidate;
      effects.run = async (command, args, options) => {
        if (command === process.execPath) {
          candidate = options.cwd;
          fs.writeFileSync(join(candidate, 'package-lock.json'), '{"name":"candidate"}\n');
        } else if (command === 'npm') {
          assert.equal(options.cwd, candidate);
          return { code: 0, stdout: '{"dependencies":{}}\n' };
        } else if (command === 'docker') {
          if (args[0] === 'image') return { code: 1, stdout: '' };
          if (args[0] === 'compose') {
            assert.ok(args.includes('build'), 'candidate preparation must not start containers or touch volumes');
            candidate = args[args.indexOf('--project-directory') + 1];
            assert.notEqual(options.env.OURS_IMAGE, 'ours-fixture:runtime');
            assert.notEqual(options.env.OURS_MAINTENANCE_IMAGE, 'ours-fixture:maintenance');
          } else if (args[0] === 'cp') fs.writeFileSync(args.at(-1), '{"name":"candidate"}\n');
          else assert.ok(['create', 'rm'].includes(args[0]));
        } else assert.fail(`Unexpected command: ${command}`);
        return { code: 0, stdout: '' };
      };
      const prepared = await effects.prepareServerBuild({ ...record, mode }, { operation, ...(operation === 'update' ? { sources: next } : {}) });
      assert.equal(prepared.workDir, candidate);
      assert.notEqual(prepared.workDir, record.workDir);
      assert.equal(fs.readFileSync(prepared.sourcesPath, 'utf8'), operation === 'update' ? replacement : original);
      assert.equal(fs.readFileSync(join(prepared.workDir, 'sources.json'), 'utf8'), operation === 'update' ? replacement : original);
      assert.ok(fs.existsSync(join(prepared.workDir, 'dependency-tree.json')));
      assert.ok(fs.existsSync(join(prepared.workDir, 'package-lock.json')));
      assert.equal(fs.statSync(join(prepared.workDir, 'package-lock.json')).mode & 0o777, 0o600);
      assert.equal(fs.existsSync(join(prepared.root, 'storage')), false);
      assert.equal(fs.readFileSync(sourcesPath, 'utf8'), original);
      assert.equal(fs.readFileSync(join(record.workDir, 'active'), 'utf8'), 'retained');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('replacement stops writers before replacing and reports changed authority when delivery fails', async () => {
  const record = { schema: 1, mode: 'docker', root: '/srv/ours', configPath: '/srv/ours/config.json', sourcesPath: '/srv/ours/sources.json', workDir: '/srv/ours/runtime', project: 'ours-fixture', instanceId: '12345678-1234-1234-1234-123456789abc', services: ['daemon', 'telegram', 'cowork', 'messenger'] };
  const effects = fx({ json: { '/srv/ours/installation.json': record } });
  const events = [];
  effects.serverPreflight = async () => {};
  effects.serverLifecycle = async (_record, op) => { events.push(op); return record.services; };
  effects.serverAccess = async (_record, op) => { events.push(op); if (op === 'access-issue') throw new Error('delivery refused'); };
  const code = await runInstall(['server', 'access-replace', '--state-dir', '/srv/ours', '--confirm'], effects);
  assert.equal(code, 2);
  assert.deepEqual(events, ['status', 'stop', 'access-replace', 'access-issue']);
  assert.match(effects.recorder.out.join('\n'), /master has changed.*incomplete/i);
});

test('server build activation retains its candidate after readiness failure and resumes without rebuilding', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = fs.mkdtempSync(join(tmpdir(), 'ours-activate-build-'));
  const record = { schema: 2, mode: 'packages', root, workDir: join(root, 'runtime'), sourcesPath: join(root, 'sources.json'),
    configPath: join(root, 'storage/state/daemon/config.json'), project: 'ours-fixture',
    instanceId: '12345678-1234-1234-1234-123456789abc', services: ['daemon', 'telegram', 'cowork', 'messenger'] };
  const candidateRoot = fs.mkdtempSync(join(root, '.build-'));
  const candidate = { ...record, root: candidateRoot, workDir: join(candidateRoot, 'runtime'), sourcesPath: join(candidateRoot, 'sources.json'),
    configPath: join(candidateRoot, 'storage/state/daemon/config.json'), project: 'ours-build' + 'a'.repeat(32) };
  const oldSources = '{"selected":"old"}\n', newSources = '{"selected":"new"}\n';
  fs.mkdirSync(record.workDir, { mode: 0o700 });
  fs.mkdirSync(candidate.workDir, { mode: 0o700 });
  fs.writeFileSync(join(record.workDir, 'old'), 'old');
  fs.writeFileSync(join(candidate.workDir, 'new'), 'new');
  fs.writeFileSync(record.sourcesPath, oldSources, { mode: 0o600 });
  fs.writeFileSync(candidate.sourcesPath, newSources, { mode: 0o600 });
  const input = join(root, 'replacement.json');
  fs.writeFileSync(input, '{"packages":{"@ours.network/sdk":{"type":"npm","version":"^2.0.1"}}}\n', { mode: 0o600 });
  const effects = realEffects({ env: {}, home: root, out: () => {} });
  const events = [];
  effects.prepareServerBuild = async () => { events.push('build'); return candidate; };
  effects.checkServerBuild = async () => { events.push('compatibility'); };
  effects.retireServerBuildRuntime = async () => { events.push('retire'); };
  effects.updateServerBuildState = async () => { events.push('state-update'); };
  effects.validateServerBuildState = async () => { events.push('offline-validation'); };
  let ready = false;
  effects.serverLifecycle = async (_record, operation, selected) => {
    if (operation === 'status') return ['daemon'];
    assert.equal(operation, 'start');
    assert.deepEqual(selected, ['daemon']);
    events.push('start');
    if (!ready) throw new Error('readiness failed');
  };
  try {
    const args = { operation: 'update', sources: input, compatible: true };
    await assert.rejects(() => effects.serverBuildTransition(record, args), /readiness failed/);
    const pending = effects.readJson(join(root, 'installation.json'));
    assert.equal(pending.buildTransition.phase, 'runtime-activated');
    assert.equal(fs.readFileSync(record.sourcesPath, 'utf8'), newSources);
    assert.equal(fs.readFileSync(join(record.workDir, 'new'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(join(candidateRoot, 'previous-runtime/old'), 'utf8'), 'old');
    assert.deepEqual(events, ['build', 'compatibility', 'retire', 'state-update', 'offline-validation', 'start']);
    ready = true;
    await effects.serverBuildTransition(pending, args);
    assert.equal(effects.readJson(join(root, 'installation.json')).buildTransition, undefined);
    assert.deepEqual(events.slice(6), ['retire', 'offline-validation', 'start']);
    assert.equal(fs.existsSync(candidateRoot), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pending build selection blocks other mutations and rejects a candidate outside its installation', async () => {
  const root = '/srv/ours';
  const record = { schema: 2, mode: 'packages', root, workDir: `${root}/runtime`, sourcesPath: `${root}/sources.json`,
    configPath: `${root}/storage/state/daemon/config.json`, project: 'ours-fixture',
    instanceId: '12345678-1234-1234-1234-123456789abc', services: ['daemon'] };
  const candidateRoot = `${root}/.build-Ab1234`;
  const candidate = { ...record, root: candidateRoot, workDir: `${candidateRoot}/runtime`, sourcesPath: `${candidateRoot}/sources.json`,
    configPath: `${candidateRoot}/storage/state/daemon/config.json`, project: 'ours-build' + 'a'.repeat(32) };
  const pending = { ...record, buildTransition: { candidate, operation: 'update', phase: 'state-updated', compatible: true, runningServices: ['daemon'] } };
  for (const operation of ['start', 'restart', 'install']) {
    const effects = fx({ json: { [`${root}/installation.json`]: pending } });
    effects.serverPreflight = async () => assert.fail('Unrelated mutation reached preflight');
    assert.equal(await runInstall(['server', operation, '--state-dir', root], effects), 2);
    assert.match(effects.recorder.out.join('\n'), /activation is incomplete/);
  }
  assert.throws(() => plan.validateInstallation({ ...pending, buildTransition: { ...pending.buildTransition,
    candidate: { ...candidate, root: '/other/.build-Ab1234' } } }, root), /build transition/);
});

test('explicit update resolves the packaged policy while retry reuses its pending exact candidate', async () => {
  const root = '/srv/ours';
  const record = { schema: 2, mode: 'packages', root, configPath: `${root}/storage/state/daemon/config.json`, sourcesPath: `${root}/sources.json`, workDir: `${root}/runtime`, project: 'ours-fixture', instanceId: '12345678-1234-1234-1234-123456789abc', services: ['daemon'] };
  const exact = { packages: Object.fromEntries(plan.SERVER_PACKAGES.map(name => [name, { type: 'npm', version: '2.0.1' }])) };
  for (const pending of [false, true]) {
    const selected = pending ? { ...record, buildTransition: { operation: 'update', phase: 'prepared', candidate: { ...record, root: `${root}/.build-Ab1234`, workDir: `${root}/.build-Ab1234/runtime`, sourcesPath: `${root}/.build-Ab1234/sources.json`, configPath: `${root}/.build-Ab1234/storage/state/daemon/config.json`, project: `ours-build${'a'.repeat(32)}` }, compatible: true, runningServices: ['daemon'] } } : record;
    const effects = fx({ json: { [`${root}/installation.json`]: selected } });
    let resolutions = 0;
    effects.resolveSourcePolicy = async () => { resolutions += 1; return exact; };
    effects.serverPreflight = async () => {};
    effects.serverBuildTransition = async (_record, args) => assert.equal(args.resolvedSources, pending ? undefined : exact);
    assert.equal(await runInstall(['server', 'update', '--state-dir', root, '--compatible'], effects), 0);
    assert.equal(resolutions, pending ? 0 : 1);
  }
});

test('same-source rebuild requires equivalent dependency records and changed sources require explicit compatibility', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = fs.mkdtempSync(join(tmpdir(), 'ours-rebuild-admission-'));
  try {
    const record = { mode: 'packages', root, workDir: join(root, 'old'), sourcesPath: join(root, 'old-sources.json') };
    const candidate = { root, workDir: join(root, 'new'), sourcesPath: join(root, 'new-sources.json') };
    for (const item of [record, candidate]) {
      fs.mkdirSync(item.workDir, { mode: 0o700 });
      fs.writeFileSync(item.sourcesPath, '{"selection":"retained"}');
      for (const name of ['package-lock.json', 'dependency-tree.json']) fs.writeFileSync(join(item.workDir, name), JSON.stringify({ build: item.workDir }), { mode: 0o600 });
    }
    const effects = realEffects({ env: {}, home: root });
    for (const compatible of [false, true]) await assert.rejects(effects.checkServerBuild(record, candidate, compatible, 'rebuild'), /build|dependenc|compatibility/i);
    for (const name of ['package-lock.json', 'dependency-tree.json']) fs.copyFileSync(join(record.workDir, name), join(candidate.workDir, name));
    await effects.checkServerBuild(record, candidate, false, 'rebuild');
    fs.writeFileSync(candidate.sourcesPath, '{"selection":"changed"}');
    for (const name of ['package-lock.json', 'dependency-tree.json']) fs.copyFileSync(join(record.workDir, name), join(candidate.workDir, name));
    await assert.rejects(effects.checkServerBuild(record, candidate, false, 'rebuild'), /sources/);
    await assert.rejects(effects.checkServerBuild(record, candidate, false, 'update'), /compatibility/);
    await effects.checkServerBuild(record, candidate, true, 'update');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('repeated setup retains sources and authority and repairs managed delivery', async () => {
  const record = { schema: 2, mode: 'docker', root: '/srv/ours', configPath: '/srv/ours/storage/state/daemon/config.json', sourcesPath: '/srv/ours/sources.json', workDir: '/srv/ours/runtime', project: 'ours-fixture', instanceId: '12345678-1234-1234-1234-123456789abc', services: ['daemon', 'telegram', 'cowork', 'messenger'], sourcePolicyHash: 'a'.repeat(64) };
  const effects = fx({ json: { '/srv/ours/installation.json': record }, text: { '/override/policy.json': '{"range":"^2.0.1"}', '/srv/ours/sources.json': '{"exact":"2.4.0"}' } });
  const events = [];
  effects.serverPreflight = async () => {};
  effects.prepareInstallation = async () => { events.push('prepare'); };
  effects.recordInstallationBuild = async () => { events.push('provenance'); };
  effects.serverLifecycle = async (_record, op) => { events.push(op); };
  effects.serverAccess = async (_record, op) => { events.push(op); };
  assert.equal(await runInstall(['server', 'install', '--state-dir', '/srv/ours'], effects), 0);
  assert.deepEqual(events, ['prepare', 'stop', 'access-init', 'access-issue', 'provenance', 'start']);
  assert.equal(effects.recorder.wrote.length, 0);
  effects.sourcePolicyHash = () => 'a'.repeat(64);
  assert.equal(await runInstall(['server', 'install', '--sources', '/override/policy.json', '--state-dir', '/srv/ours'], effects), 0);
});

test('first server install resolves the packaged policy once before retaining it', async () => {
  const effects = fx();
  const events = [];
  const exact = { packages: Object.fromEntries(plan.SERVER_PACKAGES.map(name => [name, { type: 'npm', version: '2.0.1' }])) };
  effects.newInstallation = (root, mode) => ({ schema: 2, root, mode, configPath: `${root}/storage/state/daemon/config.json`, sourcesPath: `${root}/sources.json`, workDir: `${root}/runtime`, project: 'ours-fixture', instanceId: '12345678-1234-1234-1234-123456789abc', services: ['daemon'] });
  effects.resolveSourcePolicy = async (policy, role) => { events.push(['resolve', policy, role]); return exact; };
  effects.serverPreflight = async (_record, _operation, options) => events.push(['preflight', options.sourceManifest]);
  effects.initializeSelection = async (_record, manifest) => events.push(['retain', manifest]);
  effects.prepareInstallation = async () => {};
  effects.serverLifecycle = async () => {};
  effects.serverAccess = async () => {};
  effects.recordInstallationBuild = async () => {};
  assert.equal(await runInstall(['server', 'install', '--mode', 'packages', '--state-dir', '/srv/ours'], effects), 0);
  assert.equal(events[0][0], 'resolve');
  assert.equal(events[0][2], 'server');
  assert.deepEqual(events.slice(1), [['preflight', exact], ['retain', exact]]);
});

test('client verifies daemon and packaged MCP before any integration mutation', async () => {
  const profile = { endpoint: 'http://server:3050', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: '/home/me/token' };
  const effects = fx({ profile, json: { '/home/me/profile.json': profile } });
  effects.verifyPackagedMcp = async () => { throw new Error('Packaged MCP is absent'); };
  assert.equal(await runInstall(['client', 'install', '--config', '/home/me/profile.json'], effects), 2);
  assert.deepEqual(effects.recorder.ran, []);
  assert.match(effects.recorder.out.join('\n'), /Packaged MCP is absent/);
});

test('client-only setup uses the packaged policy without an external sources input', async () => {
  const profile = { endpoint: 'http://server:3050', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: '/home/me/token', installer: { integrations: ['codex'] } };
  const effects = fx({ profile, json: { '/home/me/profile.json': profile } });
  effects.verifyPackagedMcp = async () => {};
  assert.equal(await runInstall(['client', 'install', '--config', '/home/me/profile.json'], effects), 2);
  assert.deepEqual(effects.recorder.ran, []);
  assert.equal(effects.recorder.wrote.length, 1);
  assert.doesNotMatch(effects.recorder.out.join('\n'), /sourcesPath/);
});

test('client profile resolves relative Fleet settings and retains profile and output selection', async () => {
  const profilePath = '/home/me/private/client/profile.json';
  const sourcesPath = '/home/me/private/client/sources.json';
  const settingsPath = '/home/me/private/client/setup/fleet.json';
  const profile = { endpoint: 'http://server:3050', expectedInstanceId: '12345678-1234-1234-1234-123456789abc',
    credentialPath: '/home/me/token', installer: { sourcesPath: 'sources.json', integrations: ['fleet'],
      fleetSettingsPath: 'setup/fleet.json' } };
  const fleetConfig = '/home/me/fleet.yaml';
  const text = {};
  const effects = fx({ profile, json: {
    [profilePath]: profile,
    [sourcesPath]: { packages: {
      '@ours.network/sdk': { type: 'npm', version: '3.7.2' },
      '@ours.network/cli': { type: 'npm', version: '1.0.1' },
      '@ours.network/fleet': { type: 'npm', version: '1.1.5' },
    } },
  }, text });
  effects.verifyPackagedMcp = async () => {};
  effects.acquireClientPackages = async () => ({ localPackages: {}, packages: {}, fleetBin: '/exact/ours-fleet' });
  const run = effects.run;
  effects.run = async (...call) => {
    const result = await run(...call);
    text[fleetConfig] = 'api_version: ours.network/fleet/v2\n';
    return result;
  };

  assert.equal(await runInstall(['client', 'install', '--config', profilePath], effects), 0);
  assert.deepEqual(effects.recorder.interactive, []);
  assert.deepEqual(effects.recorder.ran.at(-1), [
    '/exact/ours-fleet', 'init', '--configuration', fleetConfig, '--settings', '/home/me/.ours-client/fleet-settings.json',
  ]);
  assert.deepEqual(effects.recorder.ranEnv.at(-1), { OURS_CONFIG: '/home/me/.ours-client/profile.json' });
});

test('native Messenger definitions preserve selection, escape values and reject control injection', () => {
  const record = { root: '/srv/ours & team', project: 'ours-abc' };
  assert.equal(typeof plan.messengerServicePlan, 'function');
  const environment = { OURS_MESSENGER_STATE_DIR: '/srv/ours & team/messenger', OURS_DAEMON_CREDENTIAL_PATH: '/srv/token' };
  const linux = plan.messengerServicePlan(record, 'linux', '/home/me', '/srv/ours/bin/messenger', environment, 1000);
  assert.match(linux.text, /ExecStart="\/srv\/ours\/bin\/messenger" serve/);
  assert.match(linux.text, /OURS_DAEMON_CREDENTIAL_PATH=\/srv\/token/);
  const mac = plan.messengerServicePlan(record, 'darwin', '/home/me', '/srv/bin/messenger', environment, 501);
  assert.match(mac.text, /ours &amp; team/);
  assert.throws(() => plan.messengerServicePlan(record, 'linux', '/home/me', '/bin/run\nInjected=true', environment, 1000));
});

test('real new server selection never invents a Messenger identity', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'ours-selection-'));
  try {
    const effects = realEffects({ env: {}, home: root });
    assert.equal(effects.newInstallation(root, 'docker').messengerIdentity, null);
    assert.equal(effects.newInstallation(root, 'packages').messengerIdentity, null);
    const record = effects.newInstallation(root, 'docker');
    assert.equal(record.schema, 2);
    assert.equal(record.configPath, `${root}/storage/state/daemon/config.json`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual packaged Docker prepare keeps daemon fresh for owning HMAC init', { skip: process.getuid?.() !== 0 || !process.env.OURS_TEST_ACCESS_CLI }, async () => {
  const { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, rmSync, chownSync, symlinkSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const paths = ['/storage', '/credentials', '/owner-locks', '/opt/ours', '/var/lib/ours', '/var/lib/ours-mcp'];
  for (const path of paths) assert.equal(existsSync(path), false, `disposable fixture path must be absent: ${path}`);
  const helper = fileURLToPath(new URL('../assets/scripts/runtime/client-setup.mjs', import.meta.url));
  const cli = process.env.OURS_TEST_ACCESS_CLI;
  assert.ok(cli, 'explicit disposable built CLI package is required');
  const env = { ...process.env, OURS_UID: '1000', OURS_GID: '1000', OURS_DAEMON_ID: '12345678-1234-1234-1234-123456789abc', OURS_COWORK_REST_PORT: '3052', OURS_ACCESS_MIGRATE: '0' };
  const invoke = (operation, uid = 0) => {
    const result = spawnSync(process.execPath, [helper, operation], { env, uid, gid: uid, encoding: 'utf8' });
    assert.equal(result.status, 0, `${operation}: ${result.stderr}`);
  };
  try {
    mkdirSync('/storage');
    for (const domain of ['telegram', 'cowork', 'messenger']) mkdirSync(`/credentials/${domain}`, { recursive: true });
    mkdirSync('/owner-locks');
    for (const path of ['/var/lib/ours', '/var/lib/ours-mcp']) { mkdirSync(path, { mode: 0o700 }); chownSync(path, 1000, 1000); }
    mkdirSync('/opt/ours/node_modules/@ours.network', { recursive: true });
    symlinkSync(cli, '/opt/ours/node_modules/@ours.network/cli');
    for (const name of ['package-lock.json', 'dependency-tree.json']) writeFileSync(`/opt/ours/${name}`, '{}\n');
    invoke('prepare');
    assert.deepEqual(readdirSync('/storage/state/daemon'), ['config.json']);
    assert.ok(existsSync('/storage/state/mcp'));
    assert.ok(existsSync('/storage/state/credentials/telegram'));
    assert.equal(JSON.parse(readFileSync('/storage/state/daemon/config.json')).networkMcp.applicationConfigPath, '/var/lib/ours-mcp/config.json');
    invoke('prepare');
    cpSync('/storage/state/daemon/config.json', '/var/lib/ours/config.json'); chownSync('/var/lib/ours/config.json', 1000, 1000);
    writeFileSync('/var/lib/ours/state_data.bin', 'existing-state', { mode: 0o600 }); chownSync('/var/lib/ours/state_data.bin', 1000, 1000);
    const refused = spawnSync(process.execPath, [helper, 'access-init'], { env, uid: 1000, gid: 1000, encoding: 'utf8' });
    assert.equal(refused.status, 1, 'existing state must not trigger implicit migration');
    assert.equal(existsSync('/var/lib/ours/api-master.key'), false, 'refused migration does not initialize authority');
    rmSync('/var/lib/ours/state_data.bin');
    invoke('access-init', 1000);
    const authority = readFileSync('/var/lib/ours/api-master.key');
    assert.ok(existsSync('/var/lib/ours/.ours-provenance/package-lock.json'));
    assert.ok(existsSync('/var/lib/ours-mcp/profile.json'));
    invoke('access-init', 1000);
    assert.equal(readFileSync('/var/lib/ours/api-master.key').equals(authority), true, 'repeat setup retains current master');
  } finally { for (const path of paths) rmSync(path, { recursive: true, force: true }); }
});

test('real native stop unloads the owning daemon service and refuses a still-loaded launchd job', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'ours-stop-review-'));
  const record = { root, workDir: join(root, 'runtime'), configPath: join(root, 'config.json'), mode: 'packages', project: 'ours-fixture', services: ['daemon'] };
  try {
    const effects = realEffects({ env: {}, home: root }); effects.platform = { platform: 'darwin' };
    const calls = [];
    effects.run = async (command, args) => { calls.push([command, ...args]); return { code: args.includes('status') ? 3 : 0, stdout: '' }; };
    await assert.rejects(() => effects.serverLifecycle(record, 'stop'), /service.*loaded|job.*loaded/i);
    assert.ok(calls.some(call => call.includes('uninstall-service') && call.includes('--yes')));
    const unload = calls.findIndex(call => call.includes('uninstall-service'));
    const stop = calls.findIndex(call => call.includes('daemon') && call.includes('stop'));
    assert.ok(unload >= 0 && unload < stop, 'owning unload precedes PID/endpoint stop');
    assert.ok(calls.some(call => call[0] === 'launchctl' && call[1] === 'print'));
    effects.run = async (command, args) => ({ code: command === 'launchctl' ? 113 : args.includes('status') ? 3 : 0, stdout: '' });
    await effects.serverLifecycle(record, 'stop');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real native start reactivates a retained daemon definition through its owning manager', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  for (const fixture of [
    {
      platform: 'linux',
      definition: root => join(root, '.config/systemd/user/ours-data.service'),
      managerStart: ['systemctl', '--user', 'start', 'ours-data.service'],
    },
    {
      platform: 'darwin',
      definition: root => join(root, 'Library/LaunchAgents/solutions.adaptframework.ours.data.plist'),
      managerStart: ['launchctl', 'kickstart', `gui/${process.getuid()}/solutions.adaptframework.ours.data`],
    },
  ]) {
    const root = mkdtempSync(join(tmpdir(), `ours-native-${fixture.platform}-`));
    const record = { root, workDir: join(root, 'runtime'), configPath: join(root, 'config.json'), mode: 'packages', project: 'ours-fixture', services: ['daemon'] };
    try {
      const definition = fixture.definition(root);
      mkdirSync(join(definition, '..'), { recursive: true });
      writeFileSync(definition, 'retained definition bytes\n');
      const effects = realEffects({ env: {}, home: root }); effects.platform = { platform: fixture.platform };
      const calls = [];
      effects.run = async (command, args) => {
        calls.push([command, ...args]);
        if (command === 'launchctl' && args[0] === 'print') return { code: 113, stdout: '' };
        return { code: 0, stdout: args.includes('install-service') ? JSON.stringify({ changed: false }) : '' };
      };
      effects.verifyHostProfile = async () => {};
      effects.verifyPackagedMcp = async () => {};
      await effects.serverLifecycle(record, 'start');
      const install = calls.findIndex(call => call.includes('install-service'));
      const managerStart = calls.findIndex(call => JSON.stringify(call) === JSON.stringify(fixture.managerStart));
      assert.ok(install >= 0 && managerStart > install, `${fixture.platform}: owning install precedes native manager start; calls=${JSON.stringify(calls)}`);
      assert.equal(calls.some(call => call.includes('daemon') && call.includes('start')), false, `${fixture.platform}: no detached daemon competes with the service`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('native start waits for a slow daemon before starting consumers and still bounds failure', async t => {
  const { realEffects } = await import('../lib/effects.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const readyAfter of [58, Infinity]) {
    const root = mkdtempSync(join(tmpdir(), 'ours-slow-start-'));
    try {
      const effects = realEffects({ env: {}, home: root });
      effects.platform = { platform: 'linux' };
      let elapsed = 0;
      let consumerStartedAt;
      effects.run = async (command, args) => {
        if (command.endsWith('/ours-cowork') && args.includes('install-service')) consumerStartedAt = elapsed;
        return { code: 0, stdout: '' };
      };
      effects.verifyHostProfile = async () => {};
      effects.verifyPackagedMcp = async () => {
        if (elapsed < readyAfter) throw new Error('MCP is still starting');
      };
      const record = { root, workDir: join(root, 'runtime'), mode: 'packages', project: 'ours-fixture', services: ['daemon', 'cowork'] };
      let settled = false;
      let failure;
      const started = effects.serverLifecycle(record, 'start').catch(error => { failure = error; }).finally(() => { settled = true; });
      for (; elapsed < 180 && !settled; elapsed++) {
        await new Promise(resolve => setImmediate(resolve));
        t.mock.timers.tick(1000);
      }
      assert.ok(settled, 'startup must have a bounded failure outcome');
      await started;
      if (Number.isFinite(readyAfter)) {
        assert.ifError(failure);
        assert.ok(consumerStartedAt >= 58, 'consumers start only after MCP becomes ready');
      } else {
        assert.match(failure?.message ?? '', /Daemon and packaged MCP are not ready/);
        assert.equal(consumerStartedAt, undefined, 'failed readiness must not start consumers');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('real native effects reject a consumer state prefix collision before manager operations', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'ours-owner-review-'));
  try {
    const effects = realEffects({ env: {}, home: root }); effects.platform = { platform: 'linux' };
    const directory = join(root, '.config/systemd/user'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'ours-cowork.service'), `[Service]\nEnvironment="OURS_COWORK_STATE_DIR=${root}/cowork-old"\n# ${root}/cowork\n`);
    const calls = []; effects.run = async (...args) => { calls.push(args); return { code: 0, stdout: '' }; };
    await assert.rejects(() => effects.serverLifecycle({ root, workDir: join(root, 'runtime'), project: 'ours-fixture', services: ['daemon', 'cowork'] }, 'stop'), /unrelated existing cowork service/);
    assert.deepEqual(calls, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native owner decoding accepts exact emitted escaped paths, not comments or duplicate fields', () => {
  assert.equal(typeof plan.consumerServiceState, 'function');
  assert.equal(plan.consumerServiceState('<dict><key>EnvironmentVariables</key><dict><key>OURS_COWORK_STATE_DIR</key><string>/srv/ours &amp; team/cowork</string></dict></dict>', 'cowork', 'darwin'), '/srv/ours & team/cowork');
  assert.equal(plan.consumerServiceState('[Service]\nEnvironment="OURS_COWORK_STATE_DIR=/srv/ours %% team/cowork"\n', 'cowork', 'linux'), '/srv/ours % team/cowork');
  assert.equal(plan.consumerServiceState('# Environment=OURS_TG_STATE_DIR=/srv/tg\n[Service]\n', 'telegram', 'linux'), undefined);
  assert.equal(plan.consumerServiceState('[Service]\nEnvironment=OURS_TG_STATE_DIR=/srv/tg\nEnvironment=OURS_TG_STATE_DIR=/srv/other\n', 'telegram', 'linux'), undefined);
});

test('guided client selection discovers instance, validates before import, and reports unavailable selected integrations', async () => {
  const profile = { endpoint: 'http://server:3050', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: '/private/token' };
  const sources = { packages: {
    '@ours.network/sdk': { type: 'npm', version: '3.7.2' },
    '@ours.network/codex': { type: 'npm', version: '1.1.1' },
  } };
  const effects = fx({ lines: ['http://server:3050', '/private/token', '/input/sources.json'], answers: [true, false, false], json: { '/input/sources.json': sources } });
  effects.interactive = true;
  const calls = [];
  effects.discoverClientProfile = async (endpoint, credential) => { calls.push(['discover', endpoint, credential]); return profile; };
  effects.verifyHostProfile = async () => { calls.push('daemon'); };
  effects.verifyPackagedMcp = async () => { calls.push('mcp'); };
  const publish = effects.importClientProfile;
  effects.importClientProfile = options => { calls.push('import'); return publish(options); };
  effects.acquireClientPackages = async (path, sourcesPath) => { calls.push(['acquire', path, sourcesPath]); return { localPackages: {}, packages: {} }; };
  assert.equal(await runInstall(['client', 'install'], effects), 2);
  assert.deepEqual(calls.slice(0, 4), [['discover', profile.endpoint, profile.credentialPath], 'daemon', 'mcp', 'import']);
  assert.deepEqual(calls.at(-1), ['acquire', '/home/me/.ours-client/profile.json', '/home/me/.ours-client/sources.json']);
  assert.match(effects.recorder.out.join('\n'), /Client setup incomplete \(codex\)/);
  assert.doesNotMatch(effects.recorder.askedLines.join('\n'), /UUID|instance/i);
});

test('saved client retry preserves settings, refuses a different server and diagnoses an explicit environment override', async () => {
  const configPath = '/home/me/.ours-client/profile.json';
  const sourcesPath = '/home/me/.ours-client/sources.json';
  const profile = { endpoint: 'http://server:3050', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: '/home/me/.ours-client/credential', installer: { sourcesPath, integrations: ['fleet'] } };
  const effects = fx({ json: { [configPath]: profile, [sourcesPath]: { packages: {
    '@ours.network/sdk': { type: 'npm', version: '3.7.2' }, '@ours.network/cli': { type: 'npm', version: '2.7.2' }, '@ours.network/fleet': { type: 'npm', version: '1.1.5' },
  } } }, text: { '/home/me/fleet.yaml': 'retained' }, env: { OURS_CONFIG: '/input/removed.json' } });
  effects.verifyPackagedMcp = async () => {};
  effects.acquireClientPackages = async () => ({ localPackages: {}, packages: {}, fleetBin: '/exact/ours-fleet' });
  assert.equal(await runInstall(['client', 'install'], effects), 0);
  assert.match(effects.recorder.out.join('\n'), /explicit OURS_CONFIG override/);
  assert.match(effects.recorder.out.join('\n'), /no OURS_CONFIG export is required/);
  effects.readProfile = () => ({ ...profile, endpoint: 'http://other:3050' });
  const writes = effects.recorder.wrote.length;
  assert.equal(await runInstall(['client', 'install', '--config', '/input/another.json'], effects), 2);
  assert.equal(effects.recorder.wrote.length, writes);
  assert.match(effects.recorder.out.join('\n'), /another server/);
});

test('missing client dependency selection refuses before activating the managed profile', async () => {
  const path = '/home/me/profile.json';
  const profile = { endpoint: 'http://server:3050', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: '/home/me/token', installer: { sourcesPath: '/input/sources.json', integrations: ['codex'] } };
  const effects = fx({ profile, json: { [path]: profile, '/input/sources.json': { packages: { '@ours.network/codex': { type: 'npm', version: '1.1.1' } } } } });
  effects.verifyPackagedMcp = async () => {};
  assert.equal(await runInstall(['client', 'install', '--config', path], effects), 2);
  assert.equal(effects.recorder.wrote.length, 0);
  assert.match(effects.recorder.out.join('\n'), /sdk/);
});


test('acquired native commands are published before setup and retried without reacquisition', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const home = mkdtempSync(join(tmpdir(), 'ours-command-publication-'));
  try {
    const sourcesPath = join(home, 'sources.json');
    writeFileSync(sourcesPath, JSON.stringify({ packages: Object.fromEntries(
      ['sdk', 'cli', 'fleet', 'codex', 'claude-code'].map(name => [`@ours.network/${name}`, { type: 'npm', version: '1.2.3' }]),
    ) }));
    const effects = realEffects({ env: {}, home });
    const calls = [];
    let refuse = true;
    effects.run = async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      if (args.includes('--global') && refuse) throw new Error('configured npm prefix is not writable');
      return { ok: true, code: 0, stdout: '' };
    };
    const acquire = () => effects.acquireClientPackages(join(home, 'profile.json'), sourcesPath, ['fleet', 'codex', 'claude-code']);
    await assert.rejects(acquire(), /configured npm prefix is not writable/);
    refuse = false;
    const suite = await acquire();
    const packageRoot = dirname(suite.localPackages.codex);
    const publication = calls.filter(call => call.args.includes('--global'));
    const install = path => ({ cmd: 'npm', args: ['install', '--global', '--install-links=false', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path], options: undefined });
    assert.deepEqual(publication, [install(join(packageRoot, 'fleet')), install(join(packageRoot, 'fleet')), install(join(packageRoot, 'codex'))]);
    assert.equal(calls.filter(call => call.args[0] === 'install' && !call.args.includes('--global')).length, 1);
    assert.equal(suite.fleetBin, join(dirname(packageRoot), '.bin', 'ours-fleet'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('prepared plugin dependencies survive native cache relocation and setup retry', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { createRequire } = await import('node:module');
  const root = fs.mkdtempSync(join(tmpdir(), 'ours-marketplace-relocation-'));
  const packages = join(root, 'runtime/node_modules/@ours.network');
  try {
    for (const name of ['sdk', 'codex']) {
      const directory = join(packages, name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(join(directory, 'package.json'), JSON.stringify({
        name: `@ours.network/${name}`, version: '1.0.0', main: 'index.cjs',
        ...(name === 'codex' ? { dependencies: { '@ours.network/sdk': '1.0.0' } } : {}),
      }));
      fs.writeFileSync(join(directory, 'index.cjs'), name === 'sdk'
        ? 'module.exports = "selected SDK";' : 'module.exports = require("@ours.network/sdk");');
    }
    const effects = realEffects({ home: root, env: { ...process.env, npm_config_cache: join(root, 'npm-cache') } });
    const marketplace = await effects.prepareClientMarketplace('codex', join(packages, 'codex'));
    const plugin = join(marketplace, 'plugins/ours');
    fs.rmSync(join(plugin, 'node_modules'), { recursive: true, force: true });
    await effects.prepareClientMarketplace('codex', join(packages, 'codex'));
    const cached = join(root, 'native-cache/ours');
    fs.cpSync(plugin, cached, { recursive: true });
    fs.rmSync(packages, { recursive: true });
    assert.equal(createRequire(join(cached, 'package.json'))('./index.cjs'), 'selected SDK');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native command publication failure reports incomplete setup and retains its retry route', async () => {
  const configPath = '/home/me/.ours-client/profile.json';
  const sourcesPath = '/home/me/.ours-client/sources.json';
  const profile = { endpoint: 'http://server:3050', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: '/home/me/.ours-client/credential', installer: { sourcesPath, integrations: ['fleet'] } };
  const effects = fx({ json: { [configPath]: profile, [sourcesPath]: { packages: Object.fromEntries(
    ['sdk', 'cli', 'fleet'].map(name => [`@ours.network/${name}`, { type: 'npm', version: '1.2.3' }]),
  ) } }, text: { '/home/me/fleet.yaml': 'retained' } });
  effects.verifyPackagedMcp = async () => {};
  effects.acquireClientPackages = async () => { throw new Error('configured npm prefix is not writable'); };
  assert.equal(await runInstall(['client', 'install'], effects), 2);
  const output = effects.recorder.out.join('\n');
  assert.match(output, /Client setup incomplete.*configured npm prefix is not writable/);
  assert.match(output, /Saved profile and settings retained; re-run ours-install client install/);
  assert.doesNotMatch(output, /Client setup complete|ours-fleet installed and initialized/);
  assert.deepEqual(effects.recorder.ran, []);
  effects.acquireClientPackages = async () => ({ localPackages: {}, packages: {}, fleetBin: '/exact/ours-fleet' });
  assert.equal(await runInstall(['client', 'install'], effects), 0);
});

test('domain maintenance stops only its selected writers in either installation mode', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  for (const mode of ['docker', 'packages']) {
    const root = mkdtempSync(join(tmpdir(), 'ours-selected-stop-'));
    try {
      const effects = realEffects({ env: {}, home: root });
      effects.platform = { platform: 'linux' };
      const record = effects.newInstallation(join(root, 'server'), mode);
      const calls = [];
      effects.run = async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { ok: true, code: args.includes('status') ? 6 : 0, stdout: '[]' };
      };
      await effects.serverLifecycle(record, 'stop', ['cowork']);
      if (mode === 'docker') {
        const stops = calls.filter(call => call.includes('stop'));
        assert.equal(stops.length, 1);
        assert.deepEqual(stops[0].slice(stops[0].indexOf('stop')), ['stop', 'cowork']);
      } else {
        assert.ok(calls.length > 0);
        assert.ok(calls.every(call => call[0].endsWith('/ours-cowork')), JSON.stringify(calls));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('maintenance commands require explicit domain labels, destructive confirmation and compatible update selection', () => {
  const parse = target.parseNetworkArgs;
  for (const domain of ['daemon', 'telegram', 'cowork', 'messenger']) {
    assert.equal(parse(['server', 'backup', domain, 'before-change', '--state-dir', '/srv/ours']).domain, domain);
    assert.equal(parse(['server', 'restore', domain, 'before-change', '--state-dir', '/srv/ours', '--compatible']).compatible, true);
    assert.equal(parse(['server', 'reset', domain, '--state-dir', '/srv/ours', '--confirm']).confirm, true);
  }
  assert.equal(parse(['server', 'rebuild', '--state-dir', '/srv/ours']).operation, 'rebuild');
  assert.equal(parse(['server', 'update', '--state-dir', '/srv/ours', '--sources', '/input/next.json', '--compatible']).sources, '/input/next.json');
  for (const args of [
    ['backup', 'daemon', '../outside'], ['backup', 'daemon', 'ok', '--compatible'],
    ['restore', 'other', 'ok'], ['reset', 'daemon'], ['reset', 'daemon', '--confirm', '--compatible'],
    ['rebuild', '--compatible'], ['rebuild', '--sources', '/input/next.json'],
  ]) assert.throws(() => parse(['server', ...args, '--state-dir', '/srv/ours']));
});

test('shared layout is accepted only with its own config selection', () => {
  const record = { schema: 2, mode: 'packages', root: '/srv/ours', configPath: '/srv/ours/storage/state/daemon/config.json', sourcesPath: '/srv/ours/sources.json', workDir: '/srv/ours/runtime', project: 'ours-fixture', instanceId: '12345678-1234-1234-1234-123456789abc', services: ['daemon', 'telegram', 'cowork', 'messenger'] };
  assert.equal(plan.validateInstallation(record, record.root), record);
  assert.throws(() => plan.validateInstallation({ ...record, configPath: '/srv/ours/config.json' }, record.root));
  assert.throws(() => plan.validateInstallation({ ...record, schema: 3 }, record.root));
});

test('shared layout sends owner commands to component paths and retains legacy selection', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  for (const schema of [1, 2]) {
    const calls = [];
    const effects = realEffects({ env: {}, home: '/tmp' });
    effects.platform = { platform: 'linux' };
    effects.run = async (command, args, options) => { calls.push({ command, args, env: options?.env }); return { code: 3, stdout: '' }; };
    const root = '/tmp/ours-layout-fixture';
    const record = { schema, root, mode: 'packages', workDir: `${root}/runtime`, project: 'ours-fixture', services: ['daemon'], configPath: schema === 2 ? `${root}/storage/state/daemon/config.json` : `${root}/config.json` };
    await effects.serverLifecycle(record, 'status');
    assert.equal(calls[0].args[calls[0].args.indexOf('--state-dir') + 1], schema === 2 ? `${root}/storage/state/daemon` : `${root}/data`);
    calls.length = 0;
    await effects.serverAccess(record, 'access-issue');
    assert.deepEqual(calls.map(c => c.args[c.args.indexOf('--output') + 1]), schema === 2 ? [
      `${root}/storage/state/daemon/daemon-token`,
      `${root}/storage/state/credentials/telegram/daemon-token`,
      `${root}/storage/state/credentials/cowork/daemon-token`,
      `${root}/storage/state/credentials/messenger/daemon-token`,
    ] : [`${root}/data/daemon-token`, `${root}/credentials/telegram-token`, `${root}/credentials/cowork-token`, `${root}/credentials/messenger-token`]);
  }
});

test('conversion retry validates its original selection and cleanup boundary', () => {
  const sourceRecord = { schema: 1, mode: 'packages', root: '/srv/ours', configPath: '/srv/ours/config.json', sourcesPath: '/srv/ours/sources.json', workDir: '/srv/ours/runtime', project: 'ours-fixture', instanceId: '12345678-1234-1234-1234-123456789abc', services: ['daemon', 'cowork'] };
  const marker = { version: 1, sourceRecord, backupPath: '/srv/ours/storage/backups/before-layout-2.tar', runningServices: ['daemon'] };
  const converted = { ...sourceRecord, schema: 2, configPath: '/srv/ours/storage/state/daemon/config.json', layoutConversion: marker };
  assert.equal(plan.validateInstallation(converted, sourceRecord.root), converted);
  assert.equal(plan.validateInstallation({ ...sourceRecord, layoutConversion: marker }, sourceRecord.root).schema, 1);
  for (const change of [
    { version: 2 }, { backupPath: '/srv/other/state.tar' }, { runningServices: ['messenger'] },
    { sourceRecord: { ...sourceRecord, project: 'ours-other' } },
    { sourceRecord: { ...sourceRecord, instanceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } },
    { sourceRecord: { ...sourceRecord, layoutConversion: marker } },
  ]) assert.throws(() => plan.validateInstallation({ ...converted, layoutConversion: { ...marker, ...change } }, sourceRecord.root));
});

test('package preparation keeps MCP and consumer state outside daemon scanning', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'ours-shared-prepare-'));
  try {
    const root = join(home, 'server');
    const source = join(home, 'sources.json');
    writeFileSync(source, JSON.stringify({ packages: Object.fromEntries(['sdk', 'cli', 'mcp', 'tg-connector', 'cowork', 'messenger-server'].map(name => [`@ours.network/${name}`, { type: 'npm', version: '1.2.3' }])) }));
    const effects = realEffects({ env: {}, home });
    const record = { schema: 2, root, mode: 'packages', workDir: join(root, 'runtime'), sourcesPath: join(root, 'sources.json'), configPath: join(root, 'storage/state/daemon/config.json'), instanceId: '12345678-1234-1234-1234-123456789abc', port: 3050, coworkPort: 3052 };
    await effects.initializeSelection(record, source);
    mkdirSync(record.workDir, { mode: 0o700 });
    writeFileSync(join(record.workDir, '.packages-ready'), 'ready\n');
    effects.run = async (command, args, options) => {
      assert.equal(command, 'npm');
      assert.deepEqual(args, ['ls', '--omit=dev', '--all', '--json']);
      assert.equal(options.cwd, record.workDir);
      return { code: 0, stdout: '{"name":"prepared-runtime","dependencies":{}}\n' };
    };
    await effects.prepareInstallation(record, { runtimeOnly: true });
    assert.equal(JSON.parse(readFileSync(join(record.workDir, 'dependency-tree.json'))).name, 'prepared-runtime');
    assert.equal(existsSync(`${root}/storage/state/daemon/.ours-provenance`), false);
    assert.equal(existsSync(`${root}/storage/state/mcp`), false, 'runtime preparation must not rewrite live state before backup');
    await effects.prepareInstallation(record);
    const config = JSON.parse(readFileSync(record.configPath));
    assert.equal(config.stateDir, `${root}/storage/state/daemon`);
    assert.equal(config.networkMcp.applicationConfigPath, `${root}/storage/state/mcp/config.json`);
    assert.equal(config.networkMcp.profile.credentialPath, `${root}/storage/state/daemon/daemon-token`);
    assert.equal(existsSync(`${root}/storage/state/credentials/cowork`), true);
    assert.equal(existsSync(`${root}/storage/state/mcp/profile.json`), true);
    assert.equal(existsSync(`${root}/data`), false);
    assert.equal(existsSync(`${root}/storage/state/daemon/.mcp`), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('full-server and paired daemon maintenance select all writers and pass the common tree', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  assert.equal(target.parseNetworkArgs(['server', 'backup', 'server', 'snapshot', '--state-dir', '/srv/ours']).domain, 'server');
  assert.throws(() => target.parseNetworkArgs(['server', 'reset', 'server', '--confirm', '--state-dir', '/srv/ours']));
  for (const [domain, operation] of [['server', 'restore'], ['daemon', 'restore'], ['daemon', 'reset']]) for (const mode of ['packages', 'docker']) {
    const record = { schema: 2, root: '/srv/ours', mode, workDir: '/srv/ours/runtime', configPath: '/srv/ours/storage/state/daemon/config.json', project: 'ours-fixture', services: ['daemon', 'telegram', 'cowork', 'messenger'] };
    const effects = realEffects({ env: {}, home: '/tmp' });
    const events = [];
    effects.serverLifecycle = async (_record, operation, selected) => { events.push([operation, selected]); return ['daemon', 'cowork']; };
    effects.run = async (command, args, options) => { events.push(['run', command, args, options]); return { code: 0, stdout: '' }; };
    await effects.serverMaintenance(record, { operation, domain, label: 'snapshot', confirm: true });
    assert.deepEqual(events[0], ['status', record.services]);
    assert.deepEqual(events[1], ['stop', record.services]);
    assert.equal(events[2][0], 'run');
    const call = events.find(event => event[0] === 'run' && (event[1] === process.execPath || event[2].includes('state-operation')));
    assert.ok(call, 'maintenance uses the installer Node runtime or its Docker service');
    if (mode === 'packages') {
      const { INSTALLER_ASSETS } = await import('../lib/effects.mjs');
      assert.equal(call[2][0], `${INSTALLER_ASSETS}scripts/maintenance/state-operation.mjs`);
    }
    if (mode === 'docker') {
      const removal = events.find(event => event[0] === 'run' && event[2].includes('rm'));
      assert.ok(removal, 'discard stopped mounts before swapping their parent');
      assert.ok(events.indexOf(call) > events.indexOf(removal));
    }
    const env = call[3].env;
    assert.equal(env.OURS_LIVE_ROOT, mode === 'docker' ? '/storage/state' : '/srv/ours/storage/state');
    assert.equal(env.OURS_STATE_DOMAIN, domain);
    if (operation === 'reset') { assert.ok(call[2].includes('--confirm')); assert.equal(call[2].includes('snapshot'), false); }
    assert.deepEqual(events.at(-1), ['start', ['daemon', 'cowork']]);
    events.length = 0;
    effects.run = async () => { throw new Error('restore refused'); };
    await assert.rejects(() => effects.serverMaintenance(record, { operation, domain, label: 'snapshot', confirm: true }), /restore refused/);
    assert.equal(events.some(e => e[0] === 'start'), false);
  }
});

test('package setup records the installed build before allowing state maintenance', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'ours-build-state-'));
  try {
    const record = { schema: 2, root, mode: 'packages', workDir: join(root, 'runtime') };
    mkdirSync(record.workDir, { mode: 0o700 });
    writeFileSync(join(record.workDir, 'package-lock.json'), '{"name":"selected-build"}\n', { mode: 0o600 });
    for (const name of ['daemon', 'telegram', 'cowork', 'messenger']) mkdirSync(join(root, 'storage/state', name), { recursive: true, mode: 0o700 });
    const effects = realEffects({ env: {}, home: root });
    effects.run = async (cmd, args, options) => {
      assert.equal(cmd, 'npm'); assert.deepEqual(args, ['ls', '--omit=dev', '--all', '--json']);
      assert.equal(options.cwd, record.workDir); return { code: 0, stdout: '{"dependencies":{}}\n' };
    };
    await effects.recordInstallationBuild(record);
    await effects.recordInstallationBuild(record);
    for (const name of ['daemon', 'telegram', 'cowork', 'messenger']) {
      assert.equal(readFileSync(join(root, 'storage/state', name, '.ours-provenance/package-lock.json'), 'utf8'), '{"name":"selected-build"}\n');
    }
    writeFileSync(join(record.workDir, 'package-lock.json'), '{"name":"different-build"}\n');
    await assert.rejects(() => effects.recordInstallationBuild(record), /provenance|build/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Docker maintenance refuses unclean source containers before archive or removal', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const effects = realEffects({ env: {}, home: '/tmp' });
  const calls = [];
  effects.serverLifecycle = async () => ['daemon'];
  effects.run = async (command, args) => {
    calls.push(args);
    if (args.includes('ps')) return { code: 0, stdout: 'fixture-container\n' };
    if (args.includes('inspect')) return { code: 0, stdout: JSON.stringify({ Status: 'exited', ExitCode: 137, OOMKilled: true, Dead: false }) };
    return { code: 0, stdout: '' };
  };
  const record = { schema: 2, root: '/srv/ours', mode: 'docker', workDir: '/srv/ours/runtime', project: 'ours-fixture', services: ['daemon'] };
  await assert.rejects(() => effects.serverMaintenance(record, { operation: 'restore', domain: 'server', label: 'snapshot' }), /cleanly/);
  assert.equal(calls.some(args => args.includes('rm') || args.includes('state-operation')), false);
});

test('addressed consumer restore excludes unrelated writers and uses its own subtree', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const record = { schema: 2, root: '/srv/ours', mode: 'packages', workDir: '/srv/ours/runtime', services: ['daemon', 'telegram', 'cowork', 'messenger'] };
  const effects = realEffects({ env: {}, home: '/tmp' });
  const events = [];
  effects.serverLifecycle = async (_record, operation, selected) => { events.push([operation, selected]); return ['cowork']; };
  effects.run = async (command, args, options) => { events.push(['run', options.env]); return { code: 0, stdout: '' }; };
  await effects.serverMaintenance(record, { operation: 'restore', domain: 'cowork', label: 'snapshot' });
  assert.deepEqual(events[0], ['status', ['cowork']]);
  assert.deepEqual(events[1], ['stop', ['cowork']]);
  assert.equal(events[2][1].OURS_LIVE_ROOT, '/srv/ours/storage/state/cowork');
  assert.equal(events[2][1].OURS_STATE_DOMAIN, 'cowork');
  assert.deepEqual(events[3], ['start', ['cowork']]);
});

test('Docker mutations refuse a surviving one-off operation while status remains available', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const effects = realEffects();
  const record = { mode: 'docker', project: 'ours-fixture' };
  effects.run = async (_cmd, args) => ({ code: 0, stdout: args[0] === 'ps' ? 'active-operation\n' : args.includes('version') ? '2.35.0\n' : '28.0\n' });
  await assert.rejects(effects.serverPreflight(record, 'restore'), /another.*operation/i);
  await effects.serverPreflight(record, 'status');
});

test('published server packages need no source-build toolchain during preflight', async () => {
  const { realEffects } = await import('../lib/effects.mjs');
  const effects = realEffects();
  const packages = Object.fromEntries(['sdk', 'cli', 'mcp', 'tg-connector', 'cowork', 'messenger-server'].map(name => [`@ours.network/${name}`, { type: 'npm', version: '1.2.3' }]));
  effects.readJson = path => { assert.equal(path, '/supplied/sources.json'); return { packages }; };
  const checked = [];
  effects.run = async (command) => {
    checked.push(command);
    if (['python3', 'git', 'make', 'cc'].includes(command)) throw new Error('source-build tools are absent');
    return { code: 0, stdout: '' };
  };
  await effects.serverPreflight({ mode: 'packages' }, 'install', { sourcePath: '/supplied/sources.json' });
  assert.ok(checked.includes('node') && checked.includes('npm'));
});
