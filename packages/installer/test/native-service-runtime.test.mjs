import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { realEffects } from '../lib/effects.mjs';
import { installationPaths, launchdLabelForStateDir, messengerServicePlan, unitNameForStateDir } from '../lib/plan.mjs';
import { definitionRecipe, dropInDirectoryNames, managerMainCommand, packageRecipe, renderedProblem, SERVICE_RECIPES, systemdOverrideProblem } from '../lib/service-runtime.mjs';
import { installServicePackages, managerShow, recipeDefinition } from './service-recipes.mjs';

const ADVISORY = 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases';
const NODE = '/opt/node-24.23.0/bin/node';

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ours-native-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('only the reviewed package versions are admitted as service recipes', t => {
  const root = scratch(t);
  for (const [service, { versions }] of Object.entries(SERVICE_RECIPES)) for (const version of versions) {
    const workDir = join(root, `${service}-${version}`);
    const cli = installServicePackages(workDir, { [service]: version });
    const command = { daemon: 'ours-daemon', telegram: 'ours-tg-connector', cowork: 'ours-cowork' }[service];
    assert.deepEqual(packageRecipe(service, join(workDir, 'node_modules/.bin', command), join(workDir, 'node_modules')), { cliPath: cli[service] });
  }
  const workDir = join(root, 'other');
  installServicePackages(workDir, { cowork: '2.0.1' });
  const modules = join(workDir, 'node_modules');
  assert.match(packageRecipe('cowork', join(modules, '.bin/ours-cowork'), modules).error, /@ours\.network\/cowork 2\.0\.1, whose service definition this installer has not reviewed/);
  assert.match(packageRecipe('cowork', join(modules, '.bin/missing'), modules).error, /has no installed @ours\.network\/cowork command/);
  // The bin link must run the named package, from inside this installation.
  assert.match(packageRecipe('telegram', join(modules, '.bin/ours-cowork'), modules).error, /not part of @ours\.network\/tg-connector/);
  writeFileSync(join(root, 'outside.js'), '');
  symlinkSync(join(root, 'outside.js'), join(modules, '.bin/outside'));
  assert.match(packageRecipe('cowork', join(modules, '.bin/outside'), modules).error, /from outside this installation/);
});

test('a path or unquoted value is admitted only when every recipe records it unchanged', () => {
  assert.equal(renderedProblem({ execPath: NODE, cliPath: '/srv/ours/node_modules/@ours.network/cowork/dist/cli.js', environment: { OURS_TG_CONTROL_PORT: '3051', OURS_TG_DAEMON_URL: 'http://127.0.0.1:3050', OURS_TG_POLL_TIMEOUT: 30, OURS_TG_DAEMON_STATE_DIR: '' } }), null);
  for (const unsafe of [' ', '%', '$', '\\', '"', "'", '\n', ';']) {
    assert.match(renderedProblem({ execPath: `/opt/node${unsafe}x/bin/node`, cliPath: '/srv/cli.js' }), /a Node\.js path/, JSON.stringify(unsafe));
    assert.match(renderedProblem({ execPath: NODE, cliPath: `/srv/a${unsafe}b/cli.js` }), /a command path/, JSON.stringify(unsafe));
    assert.match(renderedProblem({ execPath: NODE, cliPath: '/srv/cli.js', environment: { OURS_TG_DAEMON_STATE_DIR: `/srv/a${unsafe}b` } }), /OURS_TG_DAEMON_STATE_DIR value/, JSON.stringify(unsafe));
  }
  assert.match(renderedProblem({ execPath: 'node', cliPath: '/srv/cli.js' }), /a Node\.js path/);
});

const DOCTYPE = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
// Shapes of the reviewed recipes' generated definitions, and the installer's own Messenger plan.
const messengerRecord = { root: '/srv/ours', project: 'ours-fixture' };
const PUBLISHED = [
  ['telegram systemd (unquoted)', 'linux', 'ours-telegram.service', `[Unit]\nDescription=ours Telegram connector (bridge Telegram bots to ours proxy nodes)\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${NODE} /srv/tg/dist/cli.js serve\nEnvironment=OURS_TG_CONTROL_PORT=3051\nEnvironment=OURS_TG_STATE_DIR=/srv/ours/telegram\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`],
  ['cowork systemd', 'linux', 'ours-cowork.service', `[Unit]\nDescription=ours-cowork standalone mission-room daemon\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nExecStart="${NODE}" "/srv/cowork/dist/cli.js" serve\nEnvironment="OURS_COWORK_STATE_DIR=/srv/ours/cowork"\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`],
  ['daemon systemd', 'linux', 'ours-data.service', `# Managed by @ours.network/daemon\n[Unit]\nDescription=ours daemon (data)\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart="${NODE}" "/srv/daemon/dist/main.js" "serve" "--managed"\nEnvironment=OURS_STATE_DIR="/srv/ours/daemon"\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`],
  ['messenger systemd', 'linux', 'ours-messenger-ours-fixture.service', messengerServicePlan(messengerRecord, 'linux', '/home/me', '/srv/ours/bin/messenger', { OURS_MESSENGER_IDENTITY: 'Ada Lovelace' }, 1000, NODE).text],
  ['cowork launchd', 'darwin', 'network.ours.cowork', `<?xml version="1.0" encoding="UTF-8"?>\n${DOCTYPE}\n<plist version="1.0"><dict>\n  <key>Label</key><string>network.ours.cowork</string>\n  <key>ProgramArguments</key><array>\n    <string>${NODE}</string><string>/srv/cowork/dist/cli.js</string><string>serve</string>\n  </array>\n  <key>EnvironmentVariables</key><dict>\n    <key>OURS_COWORK_STATE_DIR</key><string>/srv/ours/cowork</string>\n  </dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>/srv/ours/cowork/daemon.log</string>\n  <key>StandardErrorPath</key><string>/srv/ours/cowork/daemon.log</string>\n</dict></plist>\n`],
  ['daemon launchd', 'darwin', 'solutions.adaptframework.ours', `<!-- Managed by @ours.network/daemon -->\n${DOCTYPE}\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>solutions.adaptframework.ours</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${NODE}</string>\n    <string>/srv/daemon/dist/main.js</string>\n    <string>serve</string>\n    <string>--managed</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>OURS_STATE_DIR</key><string>/srv/ours/daemon</string>\n  </dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict>\n</plist>\n`],
];
const messengerMac = messengerServicePlan(messengerRecord, 'darwin', '/Users/me', '/srv/ours/bin/messenger', { OURS_MESSENGER_IDENTITY: 'Ada & Co' }, 501, NODE);
PUBLISHED.push(['messenger launchd', 'darwin', messengerMac.name, messengerMac.text]);
for (const [label, platform, name, text] of PUBLISHED) test(`the ${label} recipe is read as starting its recorded Node.js`, () => {
  assert.deepEqual(definitionRecipe(text, platform, name), { interpreter: NODE });
});

const unit = (service, extra = '') => `[Unit]\nDescription=x\n[Service]\nType=simple\nExecStart="${NODE}" "/srv/cli.js" serve\n${service}[Install]\nWantedBy=default.target\n${extra}`;
for (const [label, text, expected] of [
  ['an EnvironmentFile', unit('EnvironmentFile=/srv/env\n'), /EnvironmentFile= in \[Service\]/],
  ['an UnsetEnvironment', unit('UnsetEnvironment=PATH\n'), /UnsetEnvironment=/],
  ['an ExecStartPre', unit('ExecStartPre=/bin/true\n'), /ExecStartPre=/],
  ['a RootDirectory', unit('RootDirectory=/var/old-root\n'), /RootDirectory=/],
  ['a User', unit('User=nobody\n'), /User=/],
  ['a second ExecStart', unit(`ExecStart=/usr/bin/node /srv/cli.js\n`), /exactly one ExecStart/],
  ['an ExecStart reset', unit('ExecStart=\n'), /exactly one ExecStart/],
  ['a prefixed ExecStart', unit('').replace('ExecStart="', 'ExecStart=-"'), /absolute program path/],
  ['an ExecStart specifier', unit('').replace('/srv/cli.js', '/srv/%h/cli.js'), /specifier, substitution or escape/],
  ['an ExecStart substitution', unit('').replace('/srv/cli.js', '/srv/${HOME}/cli.js'), /specifier, substitution or escape/],
  ['a relative program', unit('').replace(`"${NODE}"`, 'node'), /absolute program path/],
  ['a continued line', unit('Environment=A=b \\\n  C=d\n'), /continues a line/],
  ['another section', unit('', '[Socket]\nListenStream=1\n'), /section \[Socket\]/],
  ['a non-simple Type', unit('').replace('Type=simple', 'Type=forking'), /Type=simple/],
]) test(`a systemd definition with ${label} is not a supported recipe`, () => {
  assert.match(definitionRecipe(text, 'linux', 'ours-cowork.service').error, expected);
});

const plist = inner => `<plist version="1.0"><dict><key>Label</key><string>network.ours.cowork</string><key>ProgramArguments</key><array><string>${NODE}</string><string>/srv/cli.js</string></array>${inner}</dict></plist>`;
for (const [label, text, expected] of [
  ['a Program key', plist('<key>Program</key><string>/usr/bin/node</string>'), /launchd key Program/],
  ['a RootDirectory', plist('<key>RootDirectory</key><string>/var/old-root</string>'), /launchd key RootDirectory/],
  ['a WorkingDirectory', plist('<key>WorkingDirectory</key><string>/tmp</string>'), /launchd key WorkingDirectory/],
  ['a different Label', plist('').replace('network.ours.cowork', 'network.ours.other'), /different launchd Label/],
  ['a repeated key', plist('<key>ProgramArguments</key><array><string>/usr/bin/node</string></array>'), /repeated key ProgramArguments/],
  ['an entity-spelled key', plist('').replace('<key>ProgramArguments</key>', '<key>Program&#65;rguments</key>'), /non-canonical/],
  ['an internal DTD subset', `<!DOCTYPE plist [<!ENTITY a "b">]>${plist('')}`, /non-canonical/],
  ['a spaced tag', plist('').replace('<key>ProgramArguments</key>', '<key >ProgramArguments</key>'), /non-canonical/],
  ['an unclosed comment', `${plist('')}<!--`, /non-canonical/],
  ['empty ProgramArguments', plist('').replace(/<array>.*<\/array>/, '<array></array>'), /non-empty list of strings/],
]) test(`a launchd definition with ${label} is not a supported recipe`, () => {
  assert.match(definitionRecipe(text, 'darwin', 'network.ours.cowork').error, expected);
});

const STOCK_TIMEOUT = '# Stock policy shipped by a distribution\n[Service]\nTimeoutStopFailureMode=abort\n';
test('drop-ins are refused only when they assign the main command or its root', t => {
  const root = scratch(t);
  const env = { XDG_RUNTIME_DIR: join(root, 'run'), XDG_CONFIG_HOME: join(root, 'config') };
  const fragment = join(root, 'config/systemd/user/ours-cowork.service');
  const qualify = (extra = {}, unit = 'ours-cowork.service') => systemdOverrideProblem({ env: { ...env, ...extra }, home: root, uid: 1000, unit, fragment });
  const dropIn = (dir, name, text) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, '10-test.conf'), text); };
  assert.deepEqual(dropInDirectoryNames('ours-cowork.service'), ['ours-cowork.service.d', 'ours-.service.d', 'service.d']);
  assert.equal(qualify(), null);
  const dirs = [join(root, 'config/systemd/user'), join(root, 'config/systemd/user.control'), join(root, 'run/systemd/transient'), join(root, 'run/systemd/generator.late')];
  for (const dir of dirs) for (const name of dropInDirectoryNames('ours-cowork.service')) {
    // Policy that does not choose the program is accepted, as are comments, other sections,
    // empty resets and text inside a continued value.
    for (const harmless of [STOCK_TIMEOUT, '[Service]\n# ExecStart=/usr/bin/node\nEnvironment=NOTE=a \\\n  ExecStart=/usr/bin/node\nRootDirectory=\n', '[Unit]\nExecStart=/usr/bin/node\n']) {
      dropIn(dir, name, harmless);
      assert.equal(qualify(), null, `${name}: ${harmless}`);
    }
    for (const [text, key] of [['[Service]\nExecStart=\n', 'ExecStart'], ['[Service]\nExecStart=\nExecStart=/usr/bin/node /x\n', 'ExecStart'], ['[Service]\nExec\\\nStart=/usr/bin/node\n', null], ['[Service]\nRootDirectory=/var/old-root\n', 'RootDirectory'], ['[Service]\nRootImage=/var/old.img\n', 'RootImage'], ['[Service]\nExecStart=/usr/bin/node \\\n  /x\n', 'ExecStart']]) {
      dropIn(dir, name, text);
      if (key) assert.match(qualify(), new RegExp(`has the drop-in ${join(dir, name, '10-test.conf').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, which sets ${key}= and so could change which program it runs`), text);
      else assert.equal(qualify(), null, 'a key split by a continuation is not an assignment');
    }
    rmSync(join(dir, name), { recursive: true });
  }
  mkdirSync(join(root, 'config/systemd/user.control'), { recursive: true });
  writeFileSync(join(root, 'config/systemd/user.control/ours-cowork.service'), '');
  assert.match(qualify(), /user\.control\/ours-cowork\.service takes precedence over it/);
  rmSync(join(root, 'config/systemd/user.control/ours-cowork.service'));
  // A same-named unit with lower precedence is not loaded.
  mkdirSync(join(root, 'run/systemd/generator.late'), { recursive: true });
  writeFileSync(join(root, 'run/systemd/generator.late/ours-cowork.service'), '');
  assert.equal(qualify(), null);
  assert.match(qualify({ SYSTEMD_UNIT_PATH: '/srv/units' }), /SYSTEMD_UNIT_PATH/);
  assert.match(qualify({ XDG_CONFIG_HOME: join(root, 'elsewhere') }), /is not in the systemd user unit search path/);
  assert.match(qualify({}, 'ours-cowork@a.service'), /template unit/);
  mkdirSync(dirname(fragment), { recursive: true });
  writeFileSync(join(root, 'real.service'), '');
  symlinkSync(join(root, 'real.service'), fragment);
  assert.match(qualify(), /is a link/);
});

test('the main command is taken only from a complete manager readback', () => {
  assert.deepEqual(managerMainCommand(managerShow(NODE)), { program: NODE });
  for (const [label, output] of [
    ['an alternate root', managerShow(NODE, undefined, '/var/old-root')],
    ['an empty result', ''],
    ['a missing property', managerShow(NODE).replace('RootImage=\n', '')],
    ['a repeated property', `${managerShow(NODE)}RootImage=\n`],
    ['an extra property', `${managerShow(NODE)}ExecStartPre=\n`],
    ['two commands', managerShow(NODE).replace(' }', ' } { path=/usr/bin/node ; argv[]=/usr/bin/node ; ignore_errors=no }')],
    ['argv[0] other than the path', managerShow(NODE).replace(`argv[]=${NODE}`, 'argv[]=/usr/bin/node')],
    ['an unknown representation', `ExecStart=${NODE} /x serve\nRootDirectory=\nRootImage=\n`],
  ]) assert.ok(managerMainCommand(output).error, label);
  assert.notEqual(managerMainCommand(managerShow(`${NODE}-old`)).program, NODE);
});

// A host with the reviewed service packages installed; install-service writes its recipe.
function nativeHost(t, platform, { versions, workDir = 'server', env = {} } = {}) {
  const root = scratch(t);
  const effects = realEffects({ env: { XDG_RUNTIME_DIR: join(root, 'run'), ...env }, home: root });
  effects.platform = { platform };
  const record = effects.newInstallation(join(root, workDir), 'packages');
  mkdirSync(record.root, { recursive: true, mode: 0o700 });
  const cli = installServicePackages(record.workDir, versions);
  const linux = platform === 'linux';
  const unitDir = join(root, '.config/systemd/user'), agentDir = join(root, 'Library/LaunchAgents');
  const daemonState = installationPaths(record).daemon;
  const names = {
    daemon: linux ? unitNameForStateDir(daemonState).unit : launchdLabelForStateDir(daemonState).label,
    cowork: linux ? 'ours-cowork.service' : 'network.ours.cowork',
    telegram: linux ? 'ours-telegram.service' : 'solutions.adaptframework.ours-telegram',
  };
  const path = service => linux ? join(unitDir, names[service]) : join(agentDir, `${names[service]}.plist`);
  const environment = { cowork: { OURS_COWORK_STATE_DIR: installationPaths(record).cowork }, daemon: { OURS_STATE_DIR: daemonState }, telegram: { OURS_TG_STATE_DIR: installationPaths(record).telegram } };
  const definition = (service, program = process.execPath) => recipeDefinition(platform, names[service], program, cli[service], environment[service]);
  let recorded = process.execPath, writes = true, manager = null;
  const calls = [];
  effects.run = async (command, args) => {
    calls.push([command, ...args]);
    const service = command === process.execPath ? { 'ours-cowork': 'cowork', 'ours-daemon': 'daemon', ours: 'daemon', 'ours-tg-connector': 'telegram' }[args[0]?.split('/').at(-1)] : null;
    // A published install-service records the Node.js that runs it, unless nothing changed.
    if (service && args.includes('install-service') && writes) { mkdirSync(dirname(path(service)), { recursive: true }); writeFileSync(path(service), definition(service, recorded)); }
    if (command === 'launchctl' && args[0] === 'print') return { ok: true, code: 0, stdout: '' };
    // The user manager reports the main command of the definition it loaded.
    if (command === 'systemctl' && args[1] === 'show') {
      const unitPath = join(unitDir, args[2]);
      const program = existsSync(unitPath) ? definitionRecipe(readFileSync(unitPath, 'utf8'), platform, args[2]).interpreter : null;
      return { ok: true, code: 0, stdout: program ? managerShow(manager ?? program) : '' };
    }
    return { ok: true, code: 0, stdout: '' };
  };
  effects.verifyHostProfile = async () => {};
  return {
    managerRuns: program => { manager = program; },
    root, effects, record, calls, unitDir, cli, path, definition,
    start: services => effects.serverLifecycle(record, 'start', services),
    write: (service, text) => { mkdirSync(dirname(path(service)), { recursive: true }); writeFileSync(path(service), text); },
    registerWith: program => { recorded = program; },
    unchangedRegistration: () => { writes = false; },
    index: call => calls.findIndex(entry => JSON.stringify(entry) === JSON.stringify(call)),
  };
}

const refresh = (platform, name, path) => platform === 'linux'
  ? [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'restart', name]]
  : [['launchctl', 'bootout', `gui/${process.getuid()}`, path], ['launchctl', 'kickstart', `gui/${process.getuid()}/${name}`]];

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: a retained definition is registered again on the verified Node.js and its loaded job refreshed before start`, async t => {
    const host = nativeHost(t, platform);
    // A retained recipe on an older Node.js: it is replaced, never executed or interpreted.
    host.write('cowork', host.definition('cowork', '/usr/bin/node'));
    await host.start(['cowork']);
    assert.equal(readFileSync(host.path('cowork'), 'utf8'), host.definition('cowork'));
    const install = host.index([process.execPath, join(host.record.workDir, 'node_modules/.bin/ours-cowork'), 'install-service']);
    assert.ok(install >= 0, JSON.stringify(host.calls));
    const [reload, start] = refresh(platform, platform === 'linux' ? 'ours-cowork.service' : 'network.ours.cowork', host.path('cowork')).map(host.index);
    assert.ok(install < reload && reload < start, JSON.stringify(host.calls));
    assert.equal(host.calls.some(call => call[0] === '/usr/bin/node'), false);
  });

  test(`${platform}: a daemon registration that changes nothing still has its loaded definition refreshed before start`, async t => {
    const host = nativeHost(t, platform);
    host.write('daemon', host.definition('daemon'));
    host.unchangedRegistration();
    await host.start(['daemon']);
    const install = host.calls.findIndex(call => call[0] === process.execPath && call.includes('install-service'));
    const name = platform === 'linux' ? unitNameForStateDir(installationPaths(host.record).daemon).unit : launchdLabelForStateDir(installationPaths(host.record).daemon).label;
    const [reload, start] = refresh(platform, name, host.path('daemon')).map(host.index);
    assert.ok(install >= 0 && install < reload && reload < start, JSON.stringify(host.calls));
  });

  for (const [label, prepare, expected, options] of [
    ['an unreviewed package version', () => {}, /@ours\.network\/cowork 2\.1\.0, whose service definition this installer has not reviewed/, { versions: { cowork: '2.1.0' } }],
    ['a command path a definition cannot hold unchanged', () => {}, /would record a command path that a service definition cannot hold unchanged/, { workDir: 'server $HOME' }],
    ['a custom retained definition', host => host.write('cowork', platform === 'linux' ? host.definition('cowork').replace('Restart=', 'ExecStartPre=/usr/bin/node /srv/pre.js\nRestart=') : host.definition('cowork').replace('<key>RunAtLoad</key>', '<key>Program</key><string>/usr/bin/node</string><key>RunAtLoad</key>')), /which this installer does not support/],
  ]) test(`${platform}: ${label} is refused before anything is registered, started or changed`, async t => {
    const host = nativeHost(t, platform, options);
    prepare(host);
    const before = existsSync(host.path('cowork')) ? readFileSync(host.path('cowork'), 'utf8') : null;
    await assert.rejects(host.start(['daemon', 'cowork']), error => {
      // The first selected service that cannot be admitted is named.
      assert.match(error.message, label.startsWith('a command path') ? /^Refusing to start daemon: / : /^Refusing to start cowork: /);
      assert.match(error.message, expected);
      assert.match(error.message, /Nothing was registered, started or changed\./);
      assert.ok(error.message.includes(ADVISORY));
      return true;
    });
    // The whole selection is admitted first: not even the daemon was registered.
    assert.deepEqual(host.calls, []);
    assert.equal(existsSync(host.path('cowork')) ? readFileSync(host.path('cowork'), 'utf8') : null, before);
  });

  test(`${platform}: a registration that records another Node.js is stopped again and refused`, async t => {
    const host = nativeHost(t, platform);
    host.registerWith('/usr/bin/node');
    await assert.rejects(host.start(['cowork']), /does not start the Node\.js the installer verified\. Its registration ran; the installer stopped it again and did not start it\./);
    const install = host.calls.findIndex(call => call.includes('install-service'));
    const stop = host.calls.findIndex(call => (call[0] === 'systemctl' && call[2] === 'stop') || (call[0] === 'launchctl' && call[1] === 'bootout'));
    assert.ok(install >= 0 && stop > install, JSON.stringify(host.calls));
    assert.equal(host.calls.some(call => (call[0] === 'systemctl' && call[2] === 'restart') || (call[0] === 'launchctl' && call[1] === 'kickstart')), false);
  });
}

test('linux: a stock type-wide drop-in is accepted and left unchanged', async t => {
  const host = nativeHost(t, 'linux');
  mkdirSync(join(host.unitDir, 'service.d'), { recursive: true });
  writeFileSync(join(host.unitDir, 'service.d/10-timeout-abort.conf'), STOCK_TIMEOUT);
  await host.start(['daemon', 'cowork']);
  assert.ok(host.index(['systemctl', '--user', 'restart', 'ours-cowork.service']) >= 0, JSON.stringify(host.calls));
  assert.equal(readFileSync(join(host.unitDir, 'service.d/10-timeout-abort.conf'), 'utf8'), STOCK_TIMEOUT);
});

for (const [label, text] of [['replaces', '[Service]\nExecStart=\nExecStart=/usr/bin/node /srv/cli.js serve\n'], ['clears', '[Service]\nExecStart=\n']]) test(`linux: a drop-in that ${label} the main command refuses the whole selection before any change`, async t => {
  const host = nativeHost(t, 'linux');
  mkdirSync(join(host.unitDir, 'ours-.service.d'), { recursive: true });
  writeFileSync(join(host.unitDir, 'ours-.service.d/override.conf'), text);
  await assert.rejects(host.start(['daemon', 'cowork']), /Refusing to start daemon: .*ours-\.service\.d\/override\.conf, which sets ExecStart= and so could change which program it runs\. Nothing was registered, started or changed\./);
  assert.deepEqual(host.calls, []);
});

test('linux: a main command the user manager reports differently is stopped and refused before the installer starts it', async t => {
  const host = nativeHost(t, 'linux');
  host.managerRuns('/usr/bin/node');
  await assert.rejects(host.start(['cowork']), /is started by systemd with a program other than the Node\.js the installer verified\. Its registration ran; the installer stopped it again/);
  assert.ok(host.index(['systemctl', '--user', 'stop', 'ours-cowork.service']) > host.calls.findIndex(call => call[1] === 'show'), JSON.stringify(host.calls));
  assert.equal(host.index(['systemctl', '--user', 'restart', 'ours-cowork.service']), -1);
});

for (const [label, env, config] of [
  ['an inherited poll timeout', { OURS_TG_POLL_TIMEOUT: '30 Environment=NODE_OPTIONS=x' }, null],
  ['a configured daemon state directory', {}, { daemonStateDir: '/srv/ours data' }],
]) test(`linux: ${label} the Telegram connector would write unquoted is refused before any change`, async t => {
  const host = nativeHost(t, 'linux', { env });
  const configPath = join(installationPaths(host.record).telegram, 'config.json');
  if (config) { mkdirSync(dirname(configPath), { recursive: true }); writeFileSync(configPath, JSON.stringify(config)); }
  await assert.rejects(host.start(['telegram']), /Refusing to start telegram: .*value that its unquoted definition cannot hold unchanged/);
  assert.deepEqual(host.calls, []);
});

for (const legacy of [false, true]) test(`linux: the daemon's lexical ${legacy ? 'ours' : 'ours-daemon'} CLI is admitted before registration`, async t => {
  const host = nativeHost(t, 'linux');
  if (legacy) renameSync(join(host.record.workDir, 'node_modules/.bin/ours-daemon'), join(host.record.workDir, 'node_modules/.bin/ours'));
  const alias = join(host.root, 'server-$NAME');
  symlinkSync(host.record.workDir, alias);
  host.record.workDir = alias;
  // Package ownership resolves to safe storage; the adapter records the lexical alias.
  assert.ok(packageRecipe('daemon', join(alias, 'node_modules/.bin', legacy ? 'ours' : 'ours-daemon'), join(alias, 'node_modules')).cliPath);
  await assert.rejects(host.start(['daemon']), /Refusing to start daemon: .*command path that a service definition cannot hold unchanged/);
  assert.deepEqual(host.calls, []);
  assert.equal(existsSync(host.path('daemon')), false);
});

test('linux: the daemon config operand is admitted before registration', async t => {
  const host = nativeHost(t, 'linux');
  host.record.configPath = join(host.record.workDir, 'config-$NAME.json');
  await assert.rejects(host.start(['daemon']), /Refusing to start daemon: .*config path that a service definition cannot hold unchanged/);
  assert.deepEqual(host.calls, []);
  assert.equal(existsSync(host.path('daemon')), false);
});

for (const [label, config, env, unsafeCwd, refused] of [
  ['relative path under a spaced cwd', 'relative', {}, true, true],
  ['empty string resolved to a spaced cwd', '', {}, true, true],
  ['relative path under a safe cwd', 'relative', {}, false, false],
  ['environment takes precedence over the resolved config', 'relative', { OURS_TG_DAEMON_STATE_DIR: '/srv/daemon' }, true, false],
  ['empty environment overrides the config', 'relative', { OURS_TG_DAEMON_STATE_DIR: '' }, true, false],
  ['non-string config uses the empty default', 123, {}, true, false],
]) test(`linux: Telegram daemonStateDir ${label}`, async t => {
  const host = nativeHost(t, 'linux', { env });
  const configPath = join(installationPaths(host.record).telegram, 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ daemonStateDir: config }));
  const cwd = join(host.root, unsafeCwd ? 'working dir' : 'working-dir');
  mkdirSync(cwd);
  const previous = process.cwd();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true }));
  try {
    process.chdir(cwd);
    if (refused) {
      await assert.rejects(host.start(['daemon', 'telegram']), /Refusing to start telegram: .*OURS_TG_DAEMON_STATE_DIR value that its unquoted definition cannot hold unchanged/);
      assert.deepEqual(host.calls, []);
      assert.equal(existsSync(host.path('daemon')), false);
      assert.equal(existsSync(host.path('telegram')), false);
    } else {
      await host.start(['telegram']);
      assert.ok(host.calls.some(call => call[0] === process.execPath && call[1].endsWith('/ours-tg-connector') && call.includes('install-service')));
    }
    assert.equal(readFileSync(configPath, 'utf8'), JSON.stringify({ daemonStateDir: config }));
  } finally { process.chdir(previous); }
});

for (const platform of ['linux', 'darwin']) test(`${platform}: the installer's Messenger definition is rewritten onto the verified Node.js and reloaded`, async t => {
  const host = nativeHost(t, platform);
  host.record.messengerPort = 3060;
  const plan = messengerServicePlan(host.record, platform, host.root, join(host.record.workDir, 'node_modules/.bin/ours-messenger-server'), {}, process.getuid());
  const stale = messengerServicePlan(host.record, platform, host.root, join(host.record.workDir, 'node_modules/.bin/ours-messenger-server'), {}, process.getuid(), '/usr/bin/node');
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(plan.path, stale.text);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true }));
  await host.start(['messenger']);
  assert.deepEqual(definitionRecipe(readFileSync(plan.path, 'utf8'), platform, plan.name), { interpreter: process.execPath });
  const [reload, start] = refresh(platform, plan.name, plan.path).map(host.index);
  assert.ok(reload >= 0 && reload < start, JSON.stringify(host.calls));
});
