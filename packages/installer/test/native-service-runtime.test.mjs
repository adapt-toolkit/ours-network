import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { realEffects } from '../lib/effects.mjs';
import { installationPaths } from '../lib/plan.mjs';
import {
  definitionConflict, dropInDirectoryNames, guardNodeOptions, nodeFloorDropIn, NODE_FLOOR_DROP_IN, NODE_FLOOR_GUARD, NODE_FLOOR_GUARD_SOURCE,
  plistEnvironment, plistGuardState, plistWithGuard, recordedInterpreter, systemdUserSearchPath,
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

test('launchd plists get the guard in their single active environment dictionary', () => {
  const guard = '/srv/ours/node-floor-guard.cjs';
  const plist = '<plist><dict><key>ProgramArguments</key><array><string>/opt/node/bin/node</string><string>/x/cli.js</string></array><key>EnvironmentVariables</key>\n  <dict><key>A</key><string>b</string></dict></dict></plist>';
  const guarded = plistWithGuard(plist, guard);
  assert.ok(guarded.includes('<key>EnvironmentVariables</key>\n  <dict><key>NODE_OPTIONS</key><string>--require &quot;/srv/ours/node-floor-guard.cjs&quot;</string><key>A</key>'), guarded);
  assert.deepEqual(plistEnvironment(guarded), [['NODE_OPTIONS', guardNodeOptions(guard)], ['A', 'b']]);
  assert.equal(plistGuardState(plist, guard), 'absent');
  assert.equal(plistGuardState(guarded, guard), 'present');
  assert.equal(plistWithGuard(guarded, guard), guarded, 'its own active guard is recognized');
  assert.equal(plistGuardState(guarded, '/srv/other/node-floor-guard.cjs'), 'conflict', 'another installation\'s guard is not this one');
  assert.equal(plistWithGuard(plistWithGuard(plist, '/srv/other/node-floor-guard.cjs'), guard), null);
  // Comments are not active configuration: neither an entry nor a dictionary inside one counts.
  const entry = guarded.slice(guarded.indexOf('<key>NODE_OPTIONS</key>'), guarded.indexOf('<key>A</key>'));
  const commented = plist.replace('<dict><key>A</key>', `<dict><!-- ${entry} --><key>A</key>`);
  assert.equal(plistGuardState(commented, guard), 'conflict');
  assert.equal(plistWithGuard(commented, guard), null);
  assert.equal(plistEnvironment(plist.replace('<plist>', '<plist><!-- <key>EnvironmentVariables</key><dict> -->')), null);
  assert.equal(plistWithGuard(plist.replace('<plist>', '<plist><!-- <key>EnvironmentVariables</key><dict> -->'), guard), null);
  assert.equal(plistWithGuard(plist.replace('<string>b</string>', '<true/>'), guard), null, 'only string values are understood');
  assert.equal(plistWithGuard('<plist><dict></dict></plist>', '/srv/g.cjs'), null);
});

test('systemd drop-ins are collected from every user search path and name form', () => {
  assert.deepEqual(dropInDirectoryNames('ours-data-abc.service'), ['ours-data-abc.service.d', 'ours-data-.service.d', 'ours-.service.d', 'service.d']);
  const path = systemdUserSearchPath({}, '/home/me', 1000);
  assert.equal(path[0], '/home/me/.config/systemd/user.control');
  for (const dir of ['/run/user/1000/systemd/transient', '/home/me/.config/systemd/user', '/etc/xdg/systemd/user', '/etc/systemd/user', '/run/systemd/user', '/home/me/.local/share/systemd/user', '/usr/share/systemd/user', '/usr/lib/systemd/user', '/run/user/1000/systemd/generator.late'])
    assert.ok(path.includes(dir), dir);
  assert.ok(path.indexOf('/home/me/.config/systemd/user.control') < path.indexOf('/home/me/.config/systemd/user'));
  assert.ok(systemdUserSearchPath({ XDG_CONFIG_HOME: '/cfg', XDG_RUNTIME_DIR: '/rt' }, '/home/me', 1000).includes('/rt/systemd/transient'));
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
    [unit + 'UnsetEnvironment=NODE_OPTIONS\n', [], /uses UnsetEnvironment/],
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
  // The runtime directory is the fixture's own, so host units never take part.
  const effects = realEffects({ env: { XDG_RUNTIME_DIR: join(root, 'run') }, home: root });
  effects.platform = { platform };
  const record = effects.newInstallation(join(root, 'server'), 'packages');
  mkdirSync(record.root, { recursive: true, mode: 0o700 });
  const calls = [];
  const unitDir = join(root, '.config/systemd/user'), agentDir = join(root, 'Library/LaunchAgents');
  const cowork = platform === 'linux' ? join(unitDir, 'ours-cowork.service') : join(agentDir, 'network.ours.cowork.plist');
  const coworkState = installationPaths(record).cowork;
  const coworkDefinition = interpreter => platform === 'linux'
    ? `[Unit]\nDescription=ours-cowork\n[Service]\nType=simple\nExecStart="${interpreter}" "/opt/cowork/cli.js" serve\nEnvironment="OURS_COWORK_STATE_DIR=${coworkState}"\nRestart=on-failure\n`
    : `<plist version="1.0"><dict><key>Label</key><string>network.ours.cowork</string><key>ProgramArguments</key><array><string>${interpreter}</string><string>/opt/cowork/cli.js</string><string>serve</string></array><key>EnvironmentVariables</key><dict><key>OURS_COWORK_STATE_DIR</key><string>${coworkState}</string></dict></dict></plist>\n`;
  let reinstall = true, recorded = process.execPath, running = true;
  effects.run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === '-p' && args[1] === 'process.versions.node') {
      if (!(command in versions)) throw new Error('not executable');
      return { ok: true, code: 0, stdout: `${versions[command]}\n` };
    }
    // Published cowork install-service records the Node.js that runs it.
    if (command === process.execPath && args[0]?.endsWith('/ours-cowork') && args[1] === 'install-service' && reinstall) { mkdirSync(join(cowork, '..'), { recursive: true }); writeFileSync(cowork, coworkDefinition(recorded)); }
    if (command === process.execPath && args[0]?.endsWith('/ours-cowork') && args[1] === 'status') return { ok: true, code: running ? 0 : 6, stdout: '' };
    if (command === 'launchctl' && args[0] === 'print') return { ok: true, code: 0, stdout: '' };
    return { ok: true, code: 0, stdout: '' };
  };
  return {
    root, effects, record, calls, cowork, coworkDefinition, unitDir,
    guard: join(record.root, NODE_FLOOR_GUARD), dropIn: `${cowork}.d/${NODE_FLOOR_DROP_IN}`,
    write: text => { mkdirSync(join(cowork, '..'), { recursive: true }); writeFileSync(cowork, text); },
    noReinstall: () => { reinstall = false; },
    registerWith: interpreter => { recorded = interpreter; },
    stopped: () => { running = false; },
    stops: () => calls.filter(call => (call[0] === 'systemctl' && call[2] === 'stop') || (call[0] === 'launchctl' && call[1] === 'bootout')),
    starts: () => calls.filter(call => (call[0] === 'systemctl' && call[2] === 'start') || (call[0] === 'launchctl' && call[1] === 'kickstart')),
    installs: () => calls.filter(call => call[0] === process.execPath && call[2] === 'install-service'),
  };
}

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: a retained Cowork definition on an unpatched Node.js is refused before any change, naming it`, async t => {
    const host = nativeHost(t, platform, { '/usr/bin/node': '22.23.2' });
    const text = host.coworkDefinition('/usr/bin/node');
    host.write(text);
    await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), error => {
      assert.match(error.message, /Refusing to start cowork: .* records \/usr\/bin\/node \(Node\.js 22\.23\.2\), which is not a patched Node\.js\. Nothing was started or changed\./);
      assert.ok(error.message.includes(ADVISORY));
      return true;
    });
    assert.equal(readFileSync(host.cowork, 'utf8'), text);
    assert.equal(existsSync(host.guard), false);
    assert.equal(existsSync(`${host.cowork}.d`), false);
    // Only the read-only version query ran: no registration, manager or start.
    assert.deepEqual(host.calls, [['/usr/bin/node', '-p', 'process.versions.node']]);
  });

  test(`${platform}: a retained interpreter whose version cannot be verified is refused before any change`, async t => {
    const host = nativeHost(t, platform);
    const text = host.coworkDefinition('/opt/missing/node');
    host.write(text);
    await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), /records \/opt\/missing\/node \(its version could not be verified\), which is not a patched Node\.js\. Nothing was started or changed\./);
    assert.equal(readFileSync(host.cowork, 'utf8'), text);
    assert.equal(existsSync(host.guard), false);
    assert.equal(host.starts().length + host.installs().length, 0);
  });

  test(`${platform}: a fresh registration that records an unpatched Node.js is stopped again and reported truthfully`, async t => {
    const host = nativeHost(t, platform, { '/usr/bin/node': '22.23.2' });
    host.registerWith('/usr/bin/node');
    await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), error => {
      assert.match(error.message, /records \/usr\/bin\/node \(Node\.js 22\.23\.2\), which is not a patched Node\.js\. Its install-service command registered and started it; the installer stopped it again and did not start it\./);
      assert.doesNotMatch(error.message, /Nothing was started or changed/);
      return true;
    });
    assert.equal(host.installs().length, 1);
    assert.ok(host.calls.indexOf(host.stops().at(-1)) > host.calls.indexOf(host.installs()[0]));
    assert.equal(host.starts().length, 0);
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

test('linux: the guard drop-in is in place before install-service performs its own first start', async t => {
  const host = nativeHost(t, 'linux');
  let dropInAtRegistration = null;
  const run = host.effects.run;
  host.effects.run = async (command, args, options) => {
    if (args[1] === 'install-service') dropInAtRegistration = existsSync(host.dropIn) ? readFileSync(host.dropIn, 'utf8') : null;
    return run(command, args, options);
  };
  await host.effects.serverLifecycle(host.record, 'start', ['cowork']);
  assert.equal(host.installs().length, 1);
  // Published install-service runs daemon-reload and enable --now itself, so the drop-in must already apply.
  assert.equal(dropInAtRegistration, nodeFloorDropIn(host.guard));
  assert.equal(readFileSync(host.guard, 'utf8'), NODE_FLOOR_GUARD_SOURCE);
  const reload = host.calls.findLastIndex(call => call[0] === 'systemctl' && call[2] === 'daemon-reload');
  assert.ok(reload > host.calls.indexOf(host.installs()[0]) && reload < host.calls.indexOf(host.starts().at(-1)));
});

test('darwin: a fresh registration gets the guard and is reloaded before the installer starts it', async t => {
  const host = nativeHost(t, 'darwin');
  await host.effects.serverLifecycle(host.record, 'start', ['cowork']);
  assert.equal(plistGuardState(readFileSync(host.cowork, 'utf8'), host.guard), 'present');
  const install = host.calls.indexOf(host.installs()[0]), stop = host.calls.indexOf(host.stops().at(-1)), start = host.calls.indexOf(host.starts().at(-1));
  assert.ok(install < stop && stop < start, JSON.stringify(host.calls));
});

test('darwin: a guard entry inside an XML comment is not active and is refused before any change', async t => {
  const host = nativeHost(t, 'darwin');
  const base = host.coworkDefinition(process.execPath);
  const entry = plistWithGuard(base, host.guard).match(/<key>NODE_OPTIONS<\/key><string>[^<]*<\/string>/)[0];
  const commented = base.replace('<key>EnvironmentVariables</key><dict>', `<key>EnvironmentVariables</key><dict><!-- ${entry} -->`);
  host.write(commented);
  await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), /mentions NODE_OPTIONS, or a character reference that could spell it, outside the installer's single active Node\.js floor guard entry\. Nothing was started or changed\./);
  assert.equal(readFileSync(host.cowork, 'utf8'), commented);
  assert.equal(existsSync(host.guard), false);
  assert.equal(host.calls.length, 0, JSON.stringify(host.calls));
});

// systemd merges drop-ins from every search path, by unit name, dash prefix and type.
for (const [label, place] of [
  ['type-wide service.d', root => join(root, '.config/systemd/user/service.d')],
  ['dash-prefix ours-.service.d', root => join(root, '.config/systemd/user/ours-.service.d')],
  ['runtime transient drop-in', root => join(root, 'run/systemd/transient/ours-cowork.service.d')],
  ['user.control drop-in', root => join(root, '.config/systemd/user.control/ours-cowork.service.d')],
]) test(`linux: UnsetEnvironment in a ${label} is refused before any write or start`, async t => {
  const host = nativeHost(t, 'linux');
  const text = host.coworkDefinition(process.execPath);
  host.write(text);
  const dir = place(host.root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '99-no-node-options.conf'), '[Service]\nUnsetEnvironment=NODE_OPTIONS\n');
  await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), error => {
    assert.ok(error.message.includes(`has drop-in ${join(dir, '99-no-node-options.conf')}, which uses UnsetEnvironment.`), error.message);
    assert.match(error.message, /Nothing was started or changed\./);
    return true;
  });
  assert.equal(readFileSync(host.cowork, 'utf8'), text);
  assert.equal(existsSync(host.dropIn), false);
  assert.equal(existsSync(host.guard), false);
  assert.equal(host.calls.length, 0, JSON.stringify(host.calls));
});

// systemd joins continued lines and C-unquotes and %-expands Environment= values.
for (const [label, drop, expected] of [
  ['a continued empty Environment= reset', '[Service]\nEnvironment=\\\n\n', /empty Environment= reset/],
  ['a C-escaped NODE_OPTIONS assignment', '[Service]\nEnvironment="\\x4eODE_OPTIONS="\n', /escaped Environment= value/],
  ['a specifier in an Environment= value', '[Service]\nEnvironment=X=%u\n', /specifier in an Environment= value/],
  ['a continued UnsetEnvironment', '[Service]\nUnsetEnvironment=PATH \\\n NODE_OPTIONS\n', /UnsetEnvironment/],
  ['a continued ExecStart override', '[Service]\nExecStart=\\\n# comment inside the continuation\n\nExecStart=/old/node /x serve\n', /overrides ExecStart|empty|ExecStart/],
  ['an empty quoted Environment=', '[Service]\nEnvironment=""\n', /empty Environment= reset/],
]) test(`linux: a later drop-in with ${label} is refused before any change`, async t => {
  const host = nativeHost(t, 'linux');
  const text = host.coworkDefinition(process.execPath);
  host.write(text);
  mkdirSync(`${host.cowork}.d`);
  writeFileSync(`${host.cowork}.d/zz-probe.conf`, drop);
  await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), error => {
    assert.match(error.message, /zz-probe\.conf/);
    assert.match(error.message, expected);
    assert.match(error.message, /Nothing was started or changed\./);
    return true;
  });
  assert.equal(readFileSync(host.cowork, 'utf8'), text);
  assert.equal(existsSync(host.guard), false);
  assert.equal(host.calls.length, 0, JSON.stringify(host.calls));
});

test('launchd plists with duplicate or entity-spelled keys are not a supported form', () => {
  const guard = '/srv/ours/node-floor-guard.cjs';
  const plist = '<plist><dict><key>ProgramArguments</key><array><string>/opt/node/bin/node</string></array><key>EnvironmentVariables</key><dict><key>A</key><string>b</string></dict></dict></plist>';
  const duplicate = plistWithGuard(plist, guard).replace('<key>A</key>', '<key>NODE_OPTIONS</key><string></string><key>A</key>');
  for (const text of [
    duplicate,
    plist.replace('<key>A</key><string>b</string>', '<key>A</key><string>b</string><key>A</key><string>c</string>'),
    plist.replace('<key>A</key>', '<key>A&amp;B</key>'),
    plist.replace('<key>A</key>', '<key>NODE_&#x4F;PTIONS</key>'),
  ]) {
    assert.equal(plistEnvironment(text), null, text);
    assert.equal(plistGuardState(text, guard), 'conflict', text);
    assert.equal(plistWithGuard(text, guard), null, text);
  }
});

test('linux: an unrelated harmless drop-in elsewhere is accepted and left unchanged', async t => {
  const host = nativeHost(t, 'linux');
  host.write(host.coworkDefinition(process.execPath));
  const dir = join(host.root, '.config/systemd/user/service.d'), file = join(dir, '10-timeout.conf');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, '[Service]\nTimeoutStopSec=20\n');
  await host.effects.serverLifecycle(host.record, 'start', ['cowork']);
  assert.equal(readFileSync(file, 'utf8'), '[Service]\nTimeoutStopSec=20\n');
  assert.equal(readFileSync(host.dropIn, 'utf8'), nodeFloorDropIn(host.guard));
});

for (const [label, prepare, expected] of [
  ['a same-named unit ahead in user.control', host => { mkdirSync(join(host.root, '.config/systemd/user.control'), { recursive: true }); writeFileSync(join(host.root, '.config/systemd/user.control/ours-cowork.service'), '[Service]\nExecStart=/usr/bin/node /x serve\n'); }, /cannot be qualified: .*user\.control\/ours-cowork\.service takes precedence over/],
  ['SYSTEMD_UNIT_PATH', host => { host.effects.env.SYSTEMD_UNIT_PATH = join(host.root, 'units'); }, /cannot be qualified: SYSTEMD_UNIT_PATH replaces the systemd user unit search path/],
  ['an XDG_CONFIG_HOME that excludes the unit directory', host => { host.effects.env.XDG_CONFIG_HOME = join(host.root, 'cfg'); }, /cannot be qualified: .* is not in the systemd user unit search path/],
]) test(`linux: ${label} makes the effective unit ambiguous and is refused before any change`, async t => {
  const host = nativeHost(t, 'linux');
  const text = host.coworkDefinition(process.execPath);
  host.write(text);
  prepare(host);
  await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), expected);
  assert.equal(readFileSync(host.cowork, 'utf8'), text);
  assert.equal(existsSync(host.guard), false);
  assert.equal(host.calls.length, 0, JSON.stringify(host.calls));
});

test('linux: a Node.js floor drop-in this installation did not write is never replaced', async t => {
  for (const content of [nodeFloorDropIn('/srv/retired-root/node-floor-guard.cjs'), '# Managed by @ours.network/install: refuse an unpatched Node.js before every start.\n[Service]\nRestartSec=1\n']) {
    const host = nativeHost(t, 'linux');
    host.write(host.coworkDefinition(process.execPath));
    mkdirSync(`${host.cowork}.d`);
    writeFileSync(host.dropIn, content);
    await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), /has .*ours-node-floor\.conf, which this installation did not write\. Nothing was started or changed\./);
    assert.equal(readFileSync(host.dropIn, 'utf8'), content, 'a marker alone does not authorize replacement');
    assert.equal(existsSync(host.guard), false);
    assert.equal(host.calls.length, 0);
  }
});

test('linux: retire removes only this installation\'s byte-exact drop-in; a new root registers cleanly', async t => {
  const host = nativeHost(t, 'linux');
  await host.effects.serverLifecycle(host.record, 'start', ['cowork']);
  const unrelated = join(`${host.cowork}.d`, '10-timeout.conf');
  writeFileSync(unrelated, '[Service]\nTimeoutStopSec=20\n');
  host.stopped();
  await host.effects.serverLifecycle(host.record, 'retire', ['cowork']);
  assert.equal(existsSync(host.cowork), false);
  assert.equal(existsSync(host.dropIn), false);
  assert.equal(readFileSync(unrelated, 'utf8'), '[Service]\nTimeoutStopSec=20\n');
  assert.equal(existsSync(host.guard), true, 'the guard stays with its root');
  rmSync(unrelated);
  // A replacement installation under the same service name gets its own guard, not the retired root's.
  const next = host.effects.newInstallation(join(host.root, 'server-2'), 'packages');
  mkdirSync(next.root, { recursive: true, mode: 0o700 });
  const nextGuard = join(next.root, NODE_FLOOR_GUARD);
  const nextState = installationPaths(next).cowork;
  const run = host.effects.run;
  host.effects.run = async (command, args, options) => {
    if (args[1] === 'install-service') { writeFileSync(host.cowork, host.coworkDefinition(process.execPath).replace(installationPaths(host.record).cowork, nextState)); return { ok: true, code: 0, stdout: '' }; }
    if (args[1] === 'status') return { ok: true, code: 0, stdout: '' };
    return run(command, args, options);
  };
  await host.effects.serverLifecycle(next, 'start', ['cowork']);
  assert.equal(readFileSync(host.dropIn, 'utf8'), nodeFloorDropIn(nextGuard));
  assert.ok(!readFileSync(host.dropIn, 'utf8').includes(host.guard));
});

test('linux: retire leaves a drop-in that is not byte-exact for this installation', async t => {
  const host = nativeHost(t, 'linux');
  await host.effects.serverLifecycle(host.record, 'start', ['cowork']);
  writeFileSync(host.dropIn, `${nodeFloorDropIn(host.guard)}# edited\n`);
  host.stopped();
  await host.effects.serverLifecycle(host.record, 'retire', ['cowork']);
  assert.equal(readFileSync(host.dropIn, 'utf8'), `${nodeFloorDropIn(host.guard)}# edited\n`);
});

for (const [label, dir] of [['unit directory', host => host.unitDir], ['parent of the unit directory', host => join(host.root, '.config')], ['parent of the installation', host => dirname(host.record.root)]])
  for (const mode of [0o775, 0o777]) test(`linux: a ${mode.toString(8)} ${label} is refused before any change, with remediation`, async t => {
    const host = nativeHost(t, 'linux');
    host.write(host.coworkDefinition(process.execPath));
    const path = dir(host);
    chmodSync(path, mode);
    // Membership of the user's own primary group is not proof that nobody else can replace entries.
    await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), error => {
      assert.match(error.message, /can be changed by another user/);
      assert.ok(error.message.includes(`${path}`) && error.message.includes(`(make it private with chmod go-w ${path}, then run the installer again)`), error.message);
      assert.match(error.message, /Nothing was started or changed\./);
      return true;
    });
    assert.equal(existsSync(host.guard), false);
    assert.equal(existsSync(host.dropIn), false);
    assert.equal(host.calls.length, 0, JSON.stringify(host.calls));
  });

test('darwin: a numeric character reference that spells NODE_OPTIONS is refused before any change', async t => {
  const host = nativeHost(t, 'darwin');
  const base = host.coworkDefinition(process.execPath);
  const spelled = base.replace('<key>EnvironmentVariables</key><dict>', '<key>EnvironmentVariables</key><dict><key>NODE_&#79;PTIONS</key><string></string>');
  host.write(spelled);
  assert.equal(plistEnvironment(spelled), null);
  assert.equal(plistGuardState(spelled, host.guard), 'conflict');
  await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), /character reference that could spell it.*Nothing was started or changed\./);
  assert.equal(readFileSync(host.cowork, 'utf8'), spelled);
  assert.equal(existsSync(host.guard), false);
  assert.equal(host.calls.length, 0, JSON.stringify(host.calls));
});

test('darwin: an already guarded plist is loaded again from disk before every installer start', async t => {
  const host = nativeHost(t, 'darwin');
  const guarded = plistWithGuard(host.coworkDefinition(process.execPath), host.guard);
  host.write(guarded);
  // launchd reports the service as loaded, possibly from an older, unguarded view.
  await host.effects.serverLifecycle(host.record, 'start', ['cowork']);
  assert.equal(readFileSync(host.cowork, 'utf8'), guarded);
  const launchd = host.calls.filter(call => call[0] === 'launchctl' && call[1] !== 'print').map(call => call[1]);
  // The loaded view is replaced by the guarded plist on disk before the service is kicked.
  assert.deepEqual(launchd, ['bootout', 'bootstrap', 'kickstart']);
  assert.deepEqual(host.calls.find(call => call[1] === 'bootstrap'), ['launchctl', 'bootstrap', `gui/${process.getuid()}`, host.cowork]);
});

for (const shape of ['linked drop-in directory', 'linked parent of the drop-in directory', 'group-writable drop-in directory'])
  test(`linux: retire never removes through a ${shape} and refuses before anything stops`, async t => {
    const host = nativeHost(t, 'linux');
    await host.effects.serverLifecycle(host.record, 'start', ['cowork']);
    const guardDropIn = readFileSync(host.dropIn, 'utf8');
    const elsewhere = join(host.root, 'unrelated');
    mkdirSync(elsewhere, { mode: 0o700 });
    let target = host.dropIn;
    if (shape === 'linked drop-in directory') {
      writeFileSync(join(elsewhere, NODE_FLOOR_DROP_IN), guardDropIn);
      rmSync(`${host.cowork}.d`, { recursive: true });
      symlinkSync(elsewhere, `${host.cowork}.d`);
      target = join(elsewhere, NODE_FLOOR_DROP_IN);
    } else if (shape === 'linked parent of the drop-in directory') {
      // The unit directory itself resolves elsewhere; the lexical path is redirected.
      const real = join(elsewhere, 'user');
      mkdirSync(real, { mode: 0o755 });
      for (const name of readdirSync(host.unitDir)) (await import('node:fs')).renameSync(join(host.unitDir, name), join(real, name));
      rmSync(host.unitDir, { recursive: true });
      symlinkSync(real, host.unitDir);
      target = join(real, 'ours-cowork.service.d', NODE_FLOOR_DROP_IN);
    } else chmodSync(`${host.cowork}.d`, 0o775);
    host.stopped();
    host.calls.length = 0;
    await assert.rejects(host.effects.serverLifecycle(host.record, 'retire', ['cowork']), /Refusing to retire cowork: its Node\.js floor drop-in .* cannot be removed safely\. Nothing was stopped or removed\./);
    assert.equal(readFileSync(target, 'utf8'), guardDropIn);
    assert.equal(existsSync(host.cowork), true, 'the base definition is not removed while its guard would be stranded');
    assert.equal(host.calls.length, 0, JSON.stringify(host.calls));
  });

for (const target of ['root', 'drop-in directory', 'drop-in', 'guard']) test(`linux: a group-writable ${target} is refused before any change`, async t => {
  const host = nativeHost(t, 'linux');
  await host.effects.serverLifecycle(host.record, 'start', ['cowork']);
  const path = { root: host.record.root, 'drop-in directory': `${host.cowork}.d`, 'drop-in': host.dropIn, guard: host.guard }[target];
  chmodSync(path, target.includes('directory') || target === 'root' ? 0o775 : 0o664);
  const before = readFileSync(host.dropIn, 'utf8');
  host.calls.length = 0;
  // The installation root is also an ancestor of the guard, so its refusal names the remediation.
  const expected = target === 'root' ? /it can be changed by another user \(make it private with chmod go-w .*\)\. Nothing was started or changed\./ : /is a link, not owned by this user or writable by others\. Nothing was started or changed\./;
  await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), expected);
  assert.equal(readFileSync(host.dropIn, 'utf8'), before);
  assert.equal(host.calls.length, 0, JSON.stringify(host.calls));
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
  for (const target of ['dropins', 'guard']) {
    const host = nativeHost(t, 'linux', { '/usr/bin/node': '22.23.2' });
    const text = host.coworkDefinition('/usr/bin/node');
    host.write(text);
    const elsewhere = join(host.root, 'elsewhere');
    mkdirSync(elsewhere);
    if (target === 'dropins') symlinkSync(elsewhere, `${host.cowork}.d`);
    else symlinkSync(join(elsewhere, 'guard.cjs'), host.guard);
    await assert.rejects(host.effects.serverLifecycle(host.record, 'start', ['cowork']), /is a link, not owned by this user or writable by others\. Nothing was started or changed\./);
    assert.equal(readFileSync(host.cowork, 'utf8'), text);
    assert.deepEqual(readdirSync(elsewhere), []);
    assert.equal(host.calls.length, 0);
  }
});
