// ours-install v3 stage 2 — daemon creation and boot-service installation
// Pure: file reads are injected. NOTHING here installs, enables or
// starts a service, and no systemctl is invoked in any path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  unitNameForStateDir, unitPathForStateDir, classifyUnit, planServiceInstall,
  serviceInstallCommand, planDaemonConfig, planDaemonSteps, legacyReplacedNotice,
  launchdLabelForStateDir, CLI_UNIT_MARKER, DEFAULT_SYSTEMD_UNIT, DEFAULT_LAUNCHD_LABEL,
} from '../lib/plan.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const TG = resolve(HOME, '.ours-tg');
const unitPath = (name) => join(HOME, '.config', 'systemd', 'user', name);
const texts = (map) => (path) => (Object.prototype.hasOwnProperty.call(map, path) ? map[path] : null);

// The unit ours-mcp v0.16.0 actually writes: no marker, first line "[Unit]".
const LEGACY_UNIT = `[Unit]
Description=ours MCP daemon (secure agent-to-agent messaging over ADAPT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /usr/local/lib/node_modules/@ours.network/mcp/dist/cli.js serve
Environment=OURS_TRANSPORT=http
Environment=OURS_PORT=3050
Environment=OURS_BROKER_URL=wss://broker1.ours.network
Environment=OURS_STATE_DIR=${OURS}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;

const CLI_UNIT = `${CLI_UNIT_MARKER}
[Unit]
Description=ours shared daemon
`;

// --------------------------------------------------------- unit derivation --

test('unitNameForStateDir: the table must match ours-sdk service-instance.ts', () => {
  assert.deepEqual(unitNameForStateDir(OURS), { ok: true, unit: DEFAULT_SYSTEMD_UNIT, instance: '' });
  assert.equal(unitNameForStateDir(TG).unit, 'ours-tg.service');
  assert.equal(unitNameForStateDir('/srv/ours-tg').unit, 'ours-tg.service');
  assert.equal(unitNameForStateDir('/srv/mydaemon').unit, 'ours-mydaemon.service');
  assert.equal(unitNameForStateDir('/srv/./a/../ours-b').unit, 'ours-b.service', 'resolved before the segment is taken');
  const bad = unitNameForStateDir('/srv/a.b');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /does not yield a usable service name/);
  assert.equal(unitNameForStateDir(`/srv/ours-${'x'.repeat(33)}`).ok, false, 'the 32-character bound applies');
});

test('unitPathForStateDir puts it in the systemd user directory', () => {
  assert.equal(unitPathForStateDir(TG, HOME).path, unitPath('ours-tg.service'));
});

test('launchdLabelForStateDir matches the CLI 2.6.1 LaunchAgent label rule', () => {
  assert.deepEqual(launchdLabelForStateDir(OURS), { ok: true, label: DEFAULT_LAUNCHD_LABEL, instance: '' });
  assert.equal(launchdLabelForStateDir(TG).label, `${DEFAULT_LAUNCHD_LABEL}.tg`);
  assert.equal(launchdLabelForStateDir('/srv/a.b').ok, false);
});

// ------------------------------------------------------- unit classification --

test('classifyUnit: absent / cli-managed / legacy / foreign', () => {
  assert.equal(classifyUnit(null).kind, 'absent');
  assert.equal(classifyUnit(CLI_UNIT).kind, 'cli-managed');
  assert.equal(classifyUnit(LEGACY_UNIT).kind, 'legacy', "published ours-mcp's unit is recognisable");
  assert.equal(classifyUnit('[Unit]\nDescription=something a sysadmin wrote\n').kind, 'foreign');
});

test('classifyUnit: an unmarked unit that is not ours-mcp is never called legacy', () => {
  // The distinction that matters: we may name the one command for a file we can
  // identify, and must not offer to remove one we cannot.
  const other = '[Unit]\nDescription=my own thing\n[Service]\nExecStart=/usr/bin/ours-something-else\n';
  assert.equal(classifyUnit(other).kind, 'foreign');
});

// ------------------------------------------------------------ service plan --

test('planServiceInstall: nothing in the way → install, and the CLI names the unit', () => {
  const p = planServiceInstall({ stateDir: TG, home: HOME, readText: texts({}) });
  assert.equal(p.action, 'install');
  assert.equal(p.unit, 'ours-tg.service');
  assert.equal(p.instance, 'tg');
});

test('planServiceInstall: an existing CLI-managed unit is not special-cased', () => {
  const p = planServiceInstall({ stateDir: OURS, home: HOME, readText: texts({ [unitPath('ours.service')]: CLI_UNIT }) });
  assert.equal(p.action, 'install', 'the CLI owns idempotence and the baked-state-dir guard from here');
});

test('planServiceInstall: a legacy ours-mcp unit is adopted silently, with one line of output', () => {
  const p = planServiceInstall({ stateDir: OURS, home: HOME, readText: texts({ [unitPath('ours.service')]: LEGACY_UNIT }) });
  assert.equal(p.action, 'adopt', 'no prompt: an upgrading user has no manual step');
  assert.ok(!p.prompt, 'no question is asked');
  assert.equal(p.unitPath, unitPath('ours.service'));
  assert.ok(p.notice.includes(unitPath('ours.service')), 'the replacement is not literally invisible');
});

test('the replaced-unit line is ACCURATE and carries no data-loss wording', () => {
  // Verified by the 0.16.0 -> ours-sdk migration run: state, keys, contacts and
  // delegation all survive. A "your data may be lost" line here would be FALSE and
  // would push people into reinstalling — the one thing that really would cost
  // them their identities. This negative assertion exists to stop a later
  // "improvement" that adds a scary warning.
  const notice = legacyReplacedNotice(unitPath('ours.service'), OURS);
  assert.ok(notice.includes(unitPath('ours.service')), 'names the exact unit file');
  assert.ok(notice.includes(OURS), 'names the state directory it is NOT touching');
  assert.match(notice, /untouched/);
  assert.equal(notice.split('\n').length, 1, 'one line, informational — not a warning and not a question');
  assert.doesNotMatch(notice, /lost|delete|erase|wipe|destroy/i, 'no false data-loss warning');
});

test('planServiceInstall NEVER passes --force: no plan can reach it without an answer', () => {
  for (const text of [null, CLI_UNIT, LEGACY_UNIT, '[Unit]\nDescription=stranger\n']) {
    const p = planServiceInstall({ stateDir: OURS, home: HOME, readText: texts({ [unitPath('ours.service')]: text }) });
    assert.ok(!JSON.stringify(p).includes('--force'), '--force never leaks into a plan');
  }
  assert.ok(!serviceInstallCommand({ stateDir: OURS }).includes('--force'), '--force is never a default');
});

test('--force is reachable only through the explicit post-consent argument', () => {
  // Back with the SDK CLI's install-service, and so is the marker check behind it:
  // the CLI refuses to overwrite a unit it did not write, which restores the second
  // opinion behind classifyUnit that the ours-mcp daemon period had to give up.
  assert.ok(!serviceInstallCommand({ stateDir: '/home/me/.ours' }).includes('--force'));
  assert.ok(serviceInstallCommand({ stateDir: '/home/me/.ours', adoptLegacyUnit: true }).includes('--force'));
  assert.ok(serviceInstallCommand({ stateDir: '/home/me/.ours' }).includes('--json'),
    '--json is back too: the CLI answers whether the unit CHANGED instead of us assuming');
});

test('a FOREIGN unit gets no confirmation prompt at all', () => {
  // A confirmation dialogue over a file we cannot identify is just a way to talk
  // someone into overwriting it.
  const p = planServiceInstall({ stateDir: OURS, home: HOME, readText: texts({ [unitPath('ours.service')]: '[Unit]\nDescription=stranger\n' }) });
  assert.equal(p.action, 'refuse');
  assert.ok(!p.prompt, 'no prompt');
  assert.ok(!p.command, 'no command');
});

test('an unattended run behaves EXACTLY like an interactive one', () => {
  // With no consent to withhold there must be no difference between the two, so
  // planServiceInstall takes no assumeYes at all — a dead flag would be an
  // invitation to reintroduce one.
  const args = { stateDir: OURS, home: HOME, readText: texts({ [unitPath('ours.service')]: LEGACY_UNIT }) };
  assert.deepEqual(planServiceInstall(args), planServiceInstall({ ...args, assumeYes: true }));
  // The FOREIGN case is still a refusal, interactive or not.
  const foreign = { stateDir: OURS, home: HOME, readText: texts({ [unitPath('ours.service')]: '[Unit]\nDescription=stranger\n' }) };
  assert.equal(planServiceInstall(foreign).action, 'refuse');
  assert.equal(planServiceInstall({ ...foreign, assumeYes: true }).action, 'refuse');
});

test('planServiceInstall: an unidentifiable unit stops the run and is never removed', () => {
  const p = planServiceInstall({ stateDir: OURS, home: HOME, readText: texts({ [unitPath('ours.service')]: '[Unit]\nDescription=stranger\n' }) });
  assert.equal(p.action, 'refuse');
  assert.equal(p.exitCode, 2);
  assert.equal(p.reason, 'unknown-unit');
  assert.match(p.message, /Refusing to touch it/);
  assert.ok(!p.command, 'no command is offered for a file we cannot identify');
});

test('planServiceInstall: a state dir with no usable name refuses instead of guessing', () => {
  const p = planServiceInstall({ stateDir: '/srv/a.b', home: HOME, readText: texts({}) });
  assert.equal(p.action, 'refuse');
  assert.equal(p.reason, 'unusable-state-dir');
});

test('serviceInstallCommand selects the daemon and lets the CLI name the unit', () => {
  const cmd = serviceInstallCommand({ stateDir: '/home/me/.ours-work' });
  assert.ok(!cmd.some((a) => a.endsWith('.service')), 'the unit NAME is the CLI\'s derivation, not ours');
  assert.ok(cmd.includes('--state-dir') && cmd.includes('/home/me/.ours-work'), 'we select the daemon');
});

test('macOS gets a normal LaunchAgent install plan and delegates plist ownership to the CLI', () => {
  const p = planServiceInstall({
    stateDir: '/home/me/.ours', home: '/home/me',
    readText: () => { throw new Error('Darwin must not inspect a systemd unit or plist'); },
    platform: 'darwin',
  });
  assert.deepEqual(p, {
    action: 'install', platform: 'darwin', unit: DEFAULT_LAUNCHD_LABEL, instance: '',
  });
  assert.ok(!('unitPath' in p), 'plist path, ownership and conflicts stay with the CLI');
  assert.ok(!JSON.stringify(p).includes('force'), 'Darwin can never enter legacy systemd adoption');
});

test('an unknown platform remains UNSUPPORTED, with what to do instead', () => {
  const p = planServiceInstall({ stateDir: '/home/me/.ours', home: '/home/me', readText: () => null, platform: 'freebsd' });
  assert.equal(p.action, 'unsupported');
  assert.match(p.message, /not available on freebsd/);
  assert.deepEqual(p.manual, ['ours', 'daemon', 'serve', '--config'], 'a gap, not a dead end');
});

test('planDaemonConfig merges and preserves every unrelated key', () => {
  const existing = { port: 3050, apiVisibility: 'shared', stt: { provider: 'x' }, gcIntervalMs: 42 };
  const p = planDaemonConfig(existing, { port: 3051, stateDir: TG, brokerUrl: 'wss://b' });
  assert.equal(p.changed, true);
  assert.deepEqual(p.changes.sort(), ['brokerUrl', 'port', 'stateDir']);
  assert.equal(p.config.apiVisibility, 'shared');
  assert.deepEqual(p.config.stt, { provider: 'x' });
  assert.equal(p.config.gcIntervalMs, 42);
  assert.equal(p.config.stateDir, TG, 'absolute, and always written with the port');
  assert.match(p.text, /\n$/);
});

test('planDaemonConfig: a merge that changes nothing does not touch the file', () => {
  const same = { port: 3050, stateDir: OURS, brokerUrl: 'wss://b', apiToken: 'keep' };
  const p = planDaemonConfig(same, { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' });
  assert.equal(p.changed, false);
  assert.deepEqual(p.changes, []);
  assert.equal(p.config.apiToken, 'keep');
});

test('planDaemonConfig tolerates a missing or non-object config', () => {
  for (const junk of [null, undefined, [], 'nope']) {
    const p = planDaemonConfig(junk, { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' });
    assert.equal(p.config.port, 3050);
    assert.equal(p.config.stateDir, OURS);
  }
});

// -------------------------------------------------------------- step order --

test('planDaemonSteps: creating runs CLI → config → start → service, in that order', () => {
  const steps = planDaemonSteps({ action: 'create', stateDir: TG, port: 3051 });
  assert.deepEqual(steps.map((s) => s.id), ['cli', 'config', 'start', 'service']);
  assert.ok(steps.find((s) => s.id === 'start').command.includes(join(TG, 'config.json')));
});

test('planDaemonSteps: updating never starts a daemon and never moves a port', () => {
  const steps = planDaemonSteps({ action: 'update', stateDir: OURS, port: 3050 });
  assert.deepEqual(steps.map((s) => s.id), ['cli', 'config', 'service']);
  assert.ok(!steps.some((s) => s.id === 'start'), 'update never creates a second daemon');
});

test('planDaemonSteps: a version change restarts only a daemon the CLI started', () => {
  const mine = planDaemonSteps({ action: 'update', stateDir: OURS, port: 3050 }, { cliVersionChanged: true, cliStartedIt: true });
  assert.deepEqual(mine.map((s) => s.id), ['cli', 'config', 'restart', 'service']);
  const theirs = planDaemonSteps({ action: 'update', stateDir: OURS, port: 3050 }, { cliVersionChanged: true, cliStartedIt: false });
  const step = theirs.find((s) => s.id === 'restart-external');
  assert.ok(step, '`ours daemon stop` refuses to signal a daemon it did not start');
  assert.equal(step.command, null, 'the screen names the launcher; the installer runs nothing');
});
