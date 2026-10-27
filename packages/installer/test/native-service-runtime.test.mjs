import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realEffects } from '../lib/effects.mjs';
import { installationPaths } from '../lib/plan.mjs';
import {
  definitionConflict, guardNodeOptions, nodeFloorDropIn, NODE_FLOOR_DROP_IN, NODE_FLOOR_GUARD, NODE_FLOOR_GUARD_SOURCE,
  plistWithGuard, recordedInterpreter,
} from '../lib/service-runtime.mjs';

const ADVISORY = 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases';

// The guard runs inside the service's actual Node.js process, before its entrypoint.
function guardedRun(t, version, extraEnv = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ours-node-guard-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const guard = join(dir, NODE_FLOOR_GUARD), fake = join(dir, 'fake-version.cjs'), entry = join(dir, 'entry.cjs'), ran = join(dir, 'ran.json');
  writeFileSync(guard, NODE_FLOOR_GUARD_SOURCE);
  writeFileSync(fake, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n`);
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(ran)}, JSON.stringify({ args: process.argv.slice(2), marker: process.env.SERVICE_MARKER }));\n`);
  // The fake version loads first, as an unpatched interpreter would report it.
  const result = spawnSync(process.execPath, [entry, 'serve', '--managed'], {
    encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, SERVICE_MARKER: 'kept', NODE_OPTIONS: `--require "${fake}" ${guardNodeOptions(guard)}`, ...extraEnv },
  });
  return { ...result, ran: existsSync(ran) ? JSON.parse(readFileSync(ran, 'utf8')) : null };
}

for (const version of ['22.23.2', '24.22.0', '26.12.0', '20.20.2', '25.9.0', '27.0.0-pre'])
  test(`the service guard refuses Node.js ${version} before the entrypoint runs`, t => {
    const result = guardedRun(t, version);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`Node.js ${version} is not permitted`), result.stderr);
    assert.ok(result.stderr.includes(ADVISORY));
    assert.equal(result.ran, null);
  });

test('the service guard lets a patched Node.js run the entrypoint with its arguments and environment', t => {
  const result = guardedRun(t, '22.23.4');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ran, { args: ['serve', '--managed'], marker: 'kept' });
});

test('the guard source passes through systemd and NODE_OPTIONS unexpanded', () => {
  assert.doesNotMatch(NODE_FLOOR_GUARD_SOURCE, /[\\$%]/);
  assert.equal(guardNodeOptions('/home/me/.ours/server/node-floor-guard.cjs'), '--require "/home/me/.ours/server/node-floor-guard.cjs"');
  for (const unsafe of ['relative/guard.cjs', '/a"b/guard.cjs', '/a\\b.cjs', '/a%b.cjs', '/a$b.cjs', '/a\nb.cjs'])
    assert.throws(() => guardNodeOptions(unsafe), /not safe/);
});

test('systemd drop-in loads the guard through the unit environment', () => {
  assert.equal(nodeFloorDropIn('/srv/ours team/node-floor-guard.cjs'),
    '# Managed by @ours.network/install: refuse an unpatched Node.js before every start.\n[Service]\nEnvironment="NODE_OPTIONS=--require \\"/srv/ours team/node-floor-guard.cjs\\""\n');
});

test('launchd plists get the guard in their single environment dictionary', () => {
  const plist = '<plist><dict><key>ProgramArguments</key><array><string>/opt/node/bin/node</string><string>/x/cli.js</string></array><key>EnvironmentVariables</key>\n  <dict><key>A</key><string>b</string></dict></dict></plist>';
  const guarded = plistWithGuard(plist, '/srv/ours/node-floor-guard.cjs');
  assert.ok(guarded.includes('<key>EnvironmentVariables</key>\n  <dict><key>NODE_OPTIONS</key><string>--require &quot;/srv/ours/node-floor-guard.cjs&quot;</string><key>A</key>'), guarded);
  assert.equal(plistWithGuard(guarded, '/srv/ours/node-floor-guard.cjs'), null, 'an existing NODE_OPTIONS is never rewritten');
  assert.equal(plistWithGuard('<plist><dict></dict></plist>', '/srv/g.cjs'), null);
});

test('recorded interpreters are read as text from both definition formats', () => {
  assert.equal(recordedInterpreter('[Service]\nExecStart="/opt/node 24/bin/node" "/x/cli.js" serve\n', 'linux'), '/opt/node 24/bin/node');
  assert.equal(recordedInterpreter('[Service]\nExecStart=/usr/bin/node /x/cli.js serve\n', 'linux'), '/usr/bin/node');
  for (const unit of ['[Service]\nExecStart=-/usr/bin/node x\n', '[Service]\nExecStart=node x\n', '[Service]\nExecStart=/a x\nExecStart=/b y\n',
    '[Service]\nExecStart=$NODE x\n', '[Unit]\nExecStart=/usr/bin/node\n', 'not a unit'])
    assert.equal(recordedInterpreter(unit, 'linux'), null, unit);
  assert.equal(recordedInterpreter('<key>ProgramArguments</key><array><string>/opt/node/bin/node</string></array>', 'darwin'), '/opt/node/bin/node');
  assert.equal(recordedInterpreter('<key>ProgramArguments</key><array><string>node</string></array>', 'darwin'), null);
});

test('environment and command overrides make the effective runtime ambiguous', () => {
  const unit = '[Service]\nExecStart=/usr/bin/node /x\nEnvironment="A=b"\n';
  assert.equal(definitionConflict(unit), null);
  for (const [text, drop, expected] of [
    [unit + 'Environment=NODE_OPTIONS=--inspect\n', [], /already sets NODE_OPTIONS/],
    [unit + 'EnvironmentFile=/home/me/secret.env\n', [], /uses EnvironmentFile/],
    [unit + 'UnsetEnvironment=NODE_OPTIONS\n', [], /NODE_OPTIONS/],
    [unit + 'UnsetEnvironment=PATH\n', [], /uses UnsetEnvironment/],
    [unit, [{ name: 'zz.conf', text: '[Service]\nEnvironment=\n' }], /zz\.conf.*empty Environment= reset/],
    [unit, [{ name: 'override.conf', text: '[Service]\nExecStart=\nExecStart=/old/node /x\n' }], /override\.conf.*overrides ExecStart/],
    [unit, [{ name: 'env.conf', text: '[Service]\nEnvironmentFile=/home/me/token.env\n' }], /env\.conf.*EnvironmentFile/],
  ]) {
    const conflict = definitionConflict(text, drop);
    assert.match(conflict ?? '', expected);
    assert.doesNotMatch(conflict, /secret|token\.env|--inspect/, 'diagnostics name the directive, not its value');
  }
});

// Native lifecycle with recorded commands; interpreter checks answer from a version table.
function nativeHost(t, platform, versions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ours-native-guard-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const effects = realEffects({ env: {}, home: root });
  effects.platform = { platform };
  const record = effects.newInstallation(join(root, 'server'), 'packages');
  mkdirSync(record.root, { recursive: true });
  const calls = [];
  const unitDir = join(root, '.config/systemd/user'), agentDir = join(root, 'Library/LaunchAgents');
  const cowork = platform === 'linux' ? join(unitDir, 'ours-cowork.service') : join(agentDir, 'network.ours.cowork.plist');
  const coworkState = installationPaths(record).cowork;
  const coworkDefinition = interpreter => platform === 'linux'
    ? `[Unit]\nDescription=ours-cowork\n[Service]\nType=simple\nExecStart="${interpreter}" "/opt/cowork/cli.js" serve\nEnvironment="OURS_COWORK_STATE_DIR=${coworkState}"\nRestart=on-failure\n`
    : `<plist version="1.0"><dict><key>Label</key><string>network.ours.cowork</string><key>ProgramArguments</key><array><string>${interpreter}</string><string>/opt/cowork/cli.js</string><string>serve</string></array><key>EnvironmentVariables</key><dict><key>OURS_COWORK_STATE_DIR</key><string>${coworkState}</string></dict></dict></plist>\n`;
  let reinstall = true;
  effects.run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === '-p' && args[1] === 'process.versions.node') {
      if (!(command in versions)) throw new Error('not executable');
      return { ok: true, code: 0, stdout: `${versions[command]}\n` };
    }
    // Published cowork install-service records the Node.js that runs it.
    if (command === process.execPath && args[0]?.endsWith('/ours-cowork') && args[1] === 'install-service' && reinstall) { mkdirSync(join(cowork, '..'), { recursive: true }); writeFileSync(cowork, coworkDefinition(process.execPath)); }
    if (command === process.execPath && args[0]?.endsWith('/ours-cowork') && args[1] === 'status') return { ok: true, code: 0, stdout: '' };
    if (command === 'launchctl' && args[0] === 'print') return { ok: true, code: 0, stdout: '' };
    return { ok: true, code: 0, stdout: '' };
  };
  return {
    root, effects, record, calls, cowork, coworkDefinition, unitDir,
    guard: join(record.root, NODE_FLOOR_GUARD), dropIn: `${cowork}.d/${NODE_FLOOR_DROP_IN}`,
    write: text => { mkdirSync(join(cowork, '..'), { recursive: true }); writeFileSync(cowork, text); },
    noReinstall: () => { reinstall = false; },
    starts: () => calls.filter(call => (call[0] === 'systemctl' && call[2] === 'start') || (call[0] === 'launchctl' && call[1] === 'kickstart')),
    installs: () => calls.filter(call => call[0] === process.execPath && call[2] === 'install-service'),
  };
}

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: a retained Cowork definition on an unpatched Node.js is rebound to the verified runtime and guarded`, async t => {
    const host = nativeHost(t, platform, { '/usr/bin/node': '22.23.2' });
    host.write(host.coworkDefinition('/usr/bin/node'));
    await host.effects.serverLifecycle(host.record, 'start', ['cowork']);
    assert.equal(host.installs().length, 1);
    assert.equal(recordedInterpreter(readFileSync(host.cowork, 'utf8'), platform), process.execPath);
    assert.equal(readFileSync(host.guard, 'utf8'), NODE_FLOOR_GUARD_SOURCE);
    if (platform === 'linux') assert.equal(readFileSync(host.dropIn, 'utf8'), nodeFloorDropIn(host.guard));
    else assert.ok(readFileSync(host.cowork, 'utf8').includes(`<key>NODE_OPTIONS</key><string>--require &quot;${host.guard}&quot;</string>`));
    const install = host.calls.indexOf(host.installs()[0]);
    assert.ok(host.starts().length >= 1 && host.calls.indexOf(host.starts().at(-1)) > install);
  });

  test(`${platform}: an already patched retained definition is kept and only guarded; repeated starts are stable`, async t => {
    const host = nativeHost(t, platform, { '/opt/node-24.23.0/bin/node': '24.23.0' });
    host.write(host.coworkDefinition('/opt/node-24.23.0/bin/node'));
    await host.effects.serverLifecycle(host.record, 'start', ['cowork']);
    assert.equal(host.installs().length, 0);
    assert.equal(recordedInterpreter(readFileSync(host.cowork, 'utf8'), platform), '/opt/node-24.23.0/bin/node');
    const guarded = readFileSync(host.cowork, 'utf8');
    host.calls.length = 0;
    // The installer recognizes its own guard on the next start instead of treating it as a foreign conflict.
    await host.effects.serverLifecycle(host.record, 'start', ['cowork']);
    assert.equal(readFileSync(host.cowork, 'utf8'), guarded);
    assert.equal(host.installs().length, 0);
    assert.equal(host.calls.some(call => call[0] === 'systemctl' && call[2] === 'daemon-reload'), false);
  });

  test(`${platform}: a definition still unpatched after migration is refused before it starts`, async t => {
    const host = nativeHost(t, platform, { '/usr/bin/node': '22.23.2' });
    host.noReinstall();
    host.write(host.coworkDefinition('/usr/bin/node'));
    await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), /Refusing to start cowork: .*runs \/usr\/bin\/node, which is not a verified patched Node\.js/);
    assert.equal(host.starts().length, 0);
  });

  test(`${platform}: an unverifiable interpreter is refused and an unparseable definition is left unchanged`, async t => {
    const host = nativeHost(t, platform);
    const text = platform === 'linux'
      ? host.coworkDefinition('/usr/bin/node').replace(/ExecStart=.*\n/, 'ExecStart=-/usr/bin/node /opt/cowork/cli.js serve\n')
      : host.coworkDefinition('/usr/bin/node').replace('<string>/usr/bin/node</string>', '<string>node</string>');
    host.write(text);
    await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), /Refusing to start cowork/);
    assert.equal(readFileSync(host.cowork, 'utf8'), text);
    assert.equal(existsSync(host.guard), false);
    assert.equal(host.calls.length, 0, JSON.stringify(host.calls));
  });
}

for (const [label, drop] of [
  ['ExecStart override', '[Service]\nExecStart=\nExecStart=/old/node /opt/cowork/cli.js serve\n'],
  ['EnvironmentFile', '[Service]\nEnvironmentFile=/home/me/token.env\n'],
  ['UnsetEnvironment', '[Service]\nUnsetEnvironment=NODE_OPTIONS\n'],
  ['environment reset', '[Service]\nEnvironment=\n'],
]) test(`linux: an unowned drop-in with an ${label} is refused before any change`, async t => {
  const host = nativeHost(t, 'linux', { '/usr/bin/node': '22.23.2' });
  const text = host.coworkDefinition('/usr/bin/node');
  host.write(text);
  mkdirSync(`${host.cowork}.d`);
  writeFileSync(`${host.cowork}.d/override.conf`, drop);
  await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), /Refusing to start cowork: .*override\.conf/);
  assert.equal(readFileSync(host.cowork, 'utf8'), text);
  assert.equal(existsSync(host.dropIn), false);
  assert.equal(existsSync(host.guard), false);
  assert.equal(host.calls.length, 0, JSON.stringify(host.calls));
});

test('linux: a fresh Cowork registration on the verified runtime is guarded before it is started', async t => {
  const host = nativeHost(t, 'linux');
  await host.effects.serverLifecycle(host.record, 'start', ['cowork']);
  assert.equal(host.installs().length, 1);
  assert.equal(readFileSync(host.dropIn, 'utf8'), nodeFloorDropIn(host.guard));
  const reload = host.calls.findIndex(call => call[0] === 'systemctl' && call[2] === 'daemon-reload');
  assert.ok(reload > host.calls.indexOf(host.installs()[0]) && reload < host.calls.indexOf(host.starts().at(-1)));
});

// The host's own unpatched /usr/bin/node, when present, is refused by the guard in an isolated process.
const hostNode = '/usr/bin/node';
const hostVersion = existsSync(hostNode) ? spawnSync(hostNode, ['-p', 'process.versions.node'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout.trim() : '';
test('an actual unpatched Node.js executable is refused by the guard before the entrypoint', { skip: !/^22\.23\.[0-3]$|^24\.22\.0$|^2[0135]\./.test(hostVersion) && `host ${hostNode} is ${hostVersion || 'absent'}` }, t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ours-real-old-node-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const guard = join(dir, NODE_FLOOR_GUARD), entry = join(dir, 'entry.cjs'), ran = join(dir, 'ran');
  writeFileSync(guard, NODE_FLOOR_GUARD_SOURCE);
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(ran)}, 'ran');\n`);
  const result = spawnSync(hostNode, [entry], { encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: guardNodeOptions(guard) } });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`Node.js ${hostVersion} is not permitted`), result.stderr);
  assert.equal(existsSync(ran), false);
});

test('linux: a symlinked drop-in directory or guard is refused before any change', async t => {
  const { symlinkSync } = await import('node:fs');
  for (const target of ['dropins', 'guard']) {
    const host = nativeHost(t, 'linux', { '/usr/bin/node': '22.23.2' });
    const text = host.coworkDefinition('/usr/bin/node');
    host.write(text);
    const elsewhere = join(host.root, 'elsewhere');
    mkdirSync(elsewhere);
    if (target === 'dropins') symlinkSync(elsewhere, `${host.cowork}.d`);
    else symlinkSync(join(elsewhere, 'guard.cjs'), host.guard);
    await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), /not a private file or directory owned by this user/);
    assert.equal(readFileSync(host.cowork, 'utf8'), text);
    assert.deepEqual((await import('node:fs')).readdirSync(elsewhere), []);
    assert.equal(host.calls.length, 0);
  }
});
