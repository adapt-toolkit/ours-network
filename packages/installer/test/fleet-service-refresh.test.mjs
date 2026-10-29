// Fleet service definitions pin the release tree that wrote them. On update the
// installer asks the installed Fleet to re-point its own existing definitions,
// then restarts only the services already running the replaced release and
// confirms they run the new one. It never starts a stopped service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runFleetPhase, runFleetServiceRefresh, FLEET_MANAGED_CLI_CAPABILITY, FLEET_SERVICE_REFRESH_CAPABILITY } from '../lib/orchestrate.mjs';
import { fx, said, HOME } from './fake-effects.mjs';

const ARGS = { dryRun: false, assumeYes: false, channel: 'latest', brokerUrl: 'wss://b', acquiredFleet: '/new/release/node_modules/.bin/ours-fleet' };
const CONFIG = join(HOME, 'fleet.yaml');
const TARGET = { mode: 'host-profile', configPath: '/home/me/private/profile.json', profile: {}, endpoint: 'http://127.0.0.1:8787' };
const managedReport = JSON.stringify({ version: 1, configuration: CONFIG, roles: [], removed: [], disclosure: [], enabled: [] });
const UNITS = { supervisor: 'ours-fleet.service', web: 'ours-fleet-web.service', watchdogs: 'ours-fleet-watchdogs.service' };
const service = (over = {}) => {
  const name = over.service ?? 'supervisor';
  return { service: name, path: `/home/me/.config/systemd/user/${UNITS[name]}`,
    state: 'refreshed', running: 'stale', from: '/old/release', to: '/new/release', ...over };
};
const TERMINAL = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-terminal.scope\n';

/**
 * A Fleet whose `service check` after the restarts reports `after` (default:
 * each unit restarted while active runs this release, a unit stopped since the
 * report is stopped), and a systemd with `try-restart` semantics: a unit in
 * `stoppedSinceReport` is inactive and stays so; one in `restartFails` fails.
 */
function fleet({ services = [service()], fail = false, capabilities = [FLEET_MANAGED_CLI_CAPABILITY, FLEET_SERVICE_REFRESH_CAPABILITY],
  text = { [CONFIG]: 'api_version: ours.network/fleet/v2\n' }, cgroup = TERMINAL, after = null, restartFails = [], checkFails = false,
  platform = 'linux', stoppedSinceReport = [] } = {}) {
  const e = fx({ text: { ...text, ...(cgroup === null ? {} : { '/proc/self/cgroup': cgroup }) }, fleetCapabilities: capabilities, platform });
  const run = e.run;
  const restarted = new Set();
  e.run = async (cmd, args, opts = {}) => {
    const result = await run(cmd, args, opts);
    if (cmd === 'systemctl') {
      if (args[1] === 'try-restart' && restartFails.includes(args[2])) throw new Error(`systemctl exited 1: Job for ${args[2]} failed`);
      if (args[1] === 'try-restart' && !stoppedSinceReport.includes(args[2])) restarted.add(args[2]);
      return result;
    }
    if (args[0] === 'managed-cli') return { ok: true, code: 0, stdout: managedReport };
    if (args[0] !== 'service') return result;
    if (fail) throw new Error('ours-fleet exited 1');
    if (args[1] === 'check') {
      if (checkFails) throw new Error('ours-fleet exited 2');
      const now = after ?? services.map(entry => ({ ...entry, state: 'current',
        running: restarted.has(UNITS[entry.service]) ? 'current' : stoppedSinceReport.includes(UNITS[entry.service]) ? 'stopped' : entry.running }));
      return { ok: true, code: 0, stdout: JSON.stringify({ binPath: '/new/release/cli.js', services: now }) };
    }
    return { ok: true, code: 0, stdout: JSON.stringify({ binPath: '/new/release/cli.js', services }) };
  };
  return e;
}
const refreshes = e => e.recorder.ran.filter(call => call[1] === 'service');
const systemctl = e => e.recorder.ran.filter(call => call[0] === 'systemctl');
const PLAN = { init: ['ours-fleet'], configPath: CONFIG };

test('a retained-configuration update re-points existing Fleet services at the new release', async () => {
  const e = fleet();
  const row = await runFleetPhase({ ...ARGS, disableFleetAgentsSetup: true }, e, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'installed');
  assert.deepEqual(e.recorder.ran, [
    [ARGS.acquiredFleet, 'migrate-role-defaults', '--configuration', CONFIG],
    [ARGS.acquiredFleet, 'managed-cli', 'setup', '--configuration', CONFIG, '--json'],
    [ARGS.acquiredFleet, 'service', 'refresh', '--json'],
    ['systemctl', '--user', 'try-restart', 'ours-fleet.service'],
    [ARGS.acquiredFleet, 'service', 'check', '--json'],
  ]);
  assert.deepEqual(e.recorder.ranEnv.at(-1), { OURS_CONFIG: TARGET.configPath });
  const output = said(e);
  assert.match(output, /Fleet supervisor service now starts this release/);
  assert.match(output, /Restarted Fleet supervisor service; it now runs this release and resumes its agents/);
  assert.doesNotMatch(output, /still uses the previous release/);
});

test('a full Fleet initialization also refreshes, after init and policy setup', async () => {
  const e = fleet({ services: [service({ running: 'current' }), service({ service: 'web', state: 'current', running: 'current' })] });
  await runFleetPhase({ ...ARGS, fleetSettingsPath: '/home/me/private/fleet.json' }, e, { target: TARGET, isDefaultStateDir: false });
  assert.deepEqual(e.recorder.ran.map(call => call[1]), ['init', 'migrate-role-defaults', 'managed-cli', 'service']);
  assert.doesNotMatch(said(e), /Restarted|previous release/);
});

test('a Fleet version change restarts the active web service before the supervisor, and nothing else', async () => {
  const e = fleet({ services: [service(), service({ service: 'web' }), service({ service: 'watchdogs', state: 'absent', running: 'stopped' })] });
  const result = await runFleetServiceRefresh({ ...ARGS }, e, PLAN, TARGET);
  assert.equal(result.state, 'refreshed');
  assert.deepEqual(systemctl(e), [
    ['systemctl', '--user', 'try-restart', 'ours-fleet-web.service'],
    ['systemctl', '--user', 'try-restart', 'ours-fleet.service'],
  ]);
  for (const call of e.recorder.ran) for (const forbidden of ['up', 'start', 'stop', 'enable', 'disable', '_run', '_run-fleet'])
    assert.equal(call.includes(forbidden), false, call.join(' '));
  assert.deepEqual(e.recorder.interactive, []);
  assert.deepEqual(e.recorder.wroteText, [], 'the installer writes no service definition itself');
  assert.match(said(e), /Restarted Fleet web service; it now runs this release\./);
});

test('an unchanged Fleet version restarts nothing', async () => {
  const e = fleet({ services: [service({ state: 'current', running: 'current' }), service({ service: 'web', state: 'current', running: 'current' })] });
  const result = await runFleetServiceRefresh({ ...ARGS }, e, PLAN, TARGET);
  assert.equal(result.state, 'refreshed');
  assert.deepEqual(systemctl(e), []);
  assert.deepEqual(refreshes(e).map(call => call[2]), ['refresh'], 'nothing to confirm');
  assert.doesNotMatch(said(e), /Restarted|previous release/);
});

test('an inactive Fleet service is refreshed but never started', async () => {
  const e = fleet({ services: [service({ running: 'stopped' }), service({ service: 'web', running: 'stopped' })] });
  const result = await runFleetServiceRefresh({ ...ARGS }, e, PLAN, TARGET);
  assert.equal(result.state, 'refreshed');
  assert.deepEqual(systemctl(e), []);
  assert.match(said(e), /Fleet supervisor service now starts this release/);
  assert.doesNotMatch(said(e), /Restarted/);
});

test('a running service whose definition still starts another release is not restarted', async () => {
  for (const state of ['stale', 'reload-failed', 'unrecognized']) {
    const e = fleet({ services: [service({ state })] });
    const result = await runFleetServiceRefresh({ ...ARGS }, e, PLAN, TARGET);
    assert.equal(result.state, 'attention', state);
    assert.deepEqual(systemctl(e), [], state);
    assert.match(said(e), /Running Fleet supervisor service still uses the previous release: its definition does not start this release yet.*systemctl --user try-restart ours-fleet\.service \(agents resume through their supervisor\)/, state);
  }
});

test('an installer running inside the Fleet supervisor does not restart it, but restarts the web service', async () => {
  const e = fleet({ services: [service(), service({ service: 'web' })],
    cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/ours-fleet.service\n' });
  const result = await runFleetServiceRefresh({ ...ARGS }, e, PLAN, TARGET);
  assert.equal(result.state, 'attention');
  assert.deepEqual(systemctl(e), [['systemctl', '--user', 'try-restart', 'ours-fleet-web.service']]);
  assert.match(said(e), /Running Fleet supervisor service still uses the previous release: this installer runs inside it, so restarting it would stop this run; when convenient: systemctl --user try-restart ours-fleet\.service/);
  const unknown = fleet({ cgroup: null });
  await runFleetServiceRefresh({ ...ARGS }, unknown, PLAN, TARGET);
  assert.deepEqual(systemctl(unknown), [], 'an unreadable cgroup fails closed');
});

test('a failed restart, a service still on the old release, or an unconfirmed check needs attention without failing the installation', async () => {
  const failed = fleet({ restartFails: ['ours-fleet.service'] });
  const row = await runFleetPhase({ ...ARGS, disableFleetAgentsSetup: true }, failed, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'installed');
  assert.match(said(failed), /still uses the previous release: restarting it failed \(.*Job for ours-fleet\.service failed.*\); when convenient: systemctl --user try-restart ours-fleet\.service/);
  assert.equal(systemctl(failed).length, 1, 'no second attempt');

  const old = fleet({ after: [service({ state: 'current', running: 'stale' })] });
  assert.equal((await runFleetServiceRefresh({ ...ARGS }, old, PLAN, TARGET)).state, 'attention');
  assert.match(said(old), /Restarted Fleet supervisor service, but it is not confirmed on this release \(stale\); check: systemctl --user status ours-fleet\.service/);

  const stopped = fleet({ after: [service({ state: 'current', running: 'stopped' })] });
  assert.equal((await runFleetServiceRefresh({ ...ARGS }, stopped, PLAN, TARGET)).state, 'attention');
  assert.match(said(stopped), /Fleet supervisor service is not running after the restart .*this installer did not start it/);

  const unconfirmed = fleet({ checkFails: true });
  assert.equal((await runFleetServiceRefresh({ ...ARGS }, unconfirmed, PLAN, TARGET)).state, 'attention');
  assert.match(said(unconfirmed), /Restarted Fleet supervisor service, but could not confirm which release it runs .*; check: .*service check/);
});

test('outside systemd a stale running service is reported with the launchd command, not restarted', async () => {
  const e = fleet({ platform: 'darwin', services: [service({ path: '/home/me/Library/LaunchAgents/network.ours.fleet.plist' })] });
  const result = await runFleetServiceRefresh({ ...ARGS }, e, PLAN, TARGET);
  assert.equal(result.state, 'attention');
  assert.deepEqual(systemctl(e), []);
  assert.match(said(e), /still uses the previous release: this installer restarts Fleet services only under systemd; when convenient: launchctl kickstart -k gui\/\$\(id -u\)\/network\.ours\.fleet \(agents resume/);
});

// Critic reproduction: refresh saw the unit running, then it was stopped before
// the restart. A plain `restart` would start it; `try-restart` leaves it stopped.
test('a service stopped after the report is not started by the restart', async () => {
  const e = fleet({ stoppedSinceReport: ['ours-fleet.service'] });
  const result = await runFleetServiceRefresh({ ...ARGS }, e, PLAN, TARGET);
  assert.equal(result.state, 'attention');
  assert.deepEqual(systemctl(e), [['systemctl', '--user', 'try-restart', 'ours-fleet.service']]);
  assert(!systemctl(e).some(call => call.includes('restart') || call.includes('start')), 'never a plain restart or start');
  assert.match(said(e), /Fleet supervisor service is not running after the restart \(it was stopped, or exited\); this installer did not start it/);
  assert.doesNotMatch(said(e), /now runs this release/);
});

// Critic reproduction: a running state Fleet cannot determine must not pass as current.
test('an undeterminable running state is reported as unconfirmed, never restarted', async () => {
  for (const [platform, path, command] of [
    ['linux', '/home/me/.config/systemd/user/ours-fleet-web.service', /systemctl --user try-restart ours-fleet-web\.service/],
    ['darwin', '/home/me/Library/LaunchAgents/network.ours.fleet.web.plist', /launchctl kickstart -k gui\/\$\(id -u\)\/network\.ours\.fleet\.web/],
  ]) {
    const e = fleet({ platform, services: [service({ service: 'web', path, state: 'current', running: 'unknown' })] });
    const result = await runFleetServiceRefresh({ ...ARGS }, e, PLAN, TARGET);
    assert.equal(result.state, 'attention', platform);
    assert.deepEqual(systemctl(e), [], platform);
    assert.deepEqual(refreshes(e).map(call => call[2]), ['refresh'], platform);
    assert.match(said(e), /Could not confirm which release the Fleet web service is running; if it is running and was started before this update, restart it: /, platform);
    assert.match(said(e), command, platform);
  }
});

test('unchanged and unrecognized definitions are reported, not replaced', async () => {
  const e = fleet({ services: [service({ state: 'unrecognized', running: 'unknown', detail: 'a drop-in in /x.d sets ExecStart; left untouched' })] });
  const row = await runFleetPhase({ ...ARGS, disableFleetAgentsSetup: true }, e, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'installed');
  assert.match(said(e), /Fleet supervisor service definition was left unchanged: a drop-in in \/x\.d sets ExecStart/);
});

test('a definition whose reload failed is reported as not yet active, never as refreshed', async () => {
  const e = fleet({ services: [service({ state: 'reload-failed', detail: 'systemctl --user daemon-reload failed: Failed to connect to bus' })] });
  const result = await runFleetServiceRefresh({ ...ARGS }, e, PLAN, TARGET);
  assert.equal(result.state, 'attention');
  const output = said(e);
  assert.doesNotMatch(output, /now starts this release/);
  assert.match(output, /Fleet supervisor service definition was updated, but the service manager did not reload it, so it still starts the previous release \(systemctl --user daemon-reload failed: Failed to connect to bus\); retry: systemctl --user daemon-reload/);
});

test('a failed refresh is reported with a retry line and does not fail the installation', async () => {
  const e = fleet({ fail: true });
  const row = await runFleetPhase({ ...ARGS, disableFleetAgentsSetup: true }, e, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'installed');
  assert.match(said(e), /Fleet service definitions were not refreshed .*After a reboot the previous Fleet release may start; retry: .*service refresh/);
  assert.equal(refreshes(e).length, 1, 'no second attempt');
});

test('a Fleet without the capability, a dry run, or no retained configuration refresh nothing', async () => {
  const fresh = fleet({ text: {} });
  await runFleetPhase({ ...ARGS, disableFleetAgentsSetup: true }, fresh, { target: TARGET, isDefaultStateDir: false });
  assert.deepEqual(fresh.recorder.ran, []);
  const old = fleet({ capabilities: [FLEET_MANAGED_CLI_CAPABILITY] });
  await runFleetPhase({ ...ARGS, disableFleetAgentsSetup: true }, old, { target: TARGET, isDefaultStateDir: false });
  assert.deepEqual(refreshes(old), []);
  const dry = fleet();
  await runFleetPhase({ ...ARGS, dryRun: true, disableFleetAgentsSetup: true }, dry, { target: TARGET, isDefaultStateDir: false });
  assert.deepEqual(refreshes(dry), []);
});
