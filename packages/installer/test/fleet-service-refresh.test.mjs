// Fleet service definitions pin the release tree that wrote them. On update the
// installer asks the installed Fleet to re-point its own existing definitions,
// and must never start, stop or restart anything itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runFleetPhase, FLEET_MANAGED_CLI_CAPABILITY, FLEET_SERVICE_REFRESH_CAPABILITY } from '../lib/orchestrate.mjs';
import { fx, said, HOME } from './fake-effects.mjs';

const ARGS = { dryRun: false, assumeYes: false, channel: 'latest', brokerUrl: 'wss://b', acquiredFleet: '/new/release/node_modules/.bin/ours-fleet' };
const CONFIG = join(HOME, 'fleet.yaml');
const TARGET = { mode: 'host-profile', configPath: '/home/me/private/profile.json', profile: {}, endpoint: 'http://127.0.0.1:8787' };
const managedReport = JSON.stringify({ version: 1, configuration: CONFIG, roles: [], removed: [], disclosure: [], enabled: [] });
const service = (over = {}) => ({ service: 'supervisor', path: '/home/me/.config/systemd/user/ours-fleet.service',
  state: 'refreshed', running: 'stale', from: '/old/release', to: '/new/release', ...over });

function fleet({ services = [service()], fail = false, capabilities = [FLEET_MANAGED_CLI_CAPABILITY, FLEET_SERVICE_REFRESH_CAPABILITY],
  text = { [CONFIG]: 'api_version: ours.network/fleet/v2\n' } } = {}) {
  const e = fx({ text, fleetCapabilities: capabilities });
  const run = e.run;
  e.run = async (cmd, args, opts = {}) => {
    const result = await run(cmd, args, opts);
    if (args[0] === 'managed-cli') return { ok: true, code: 0, stdout: managedReport };
    if (args[0] !== 'service') return result;
    if (fail) throw new Error('ours-fleet exited 1');
    return { ok: true, code: 0, stdout: JSON.stringify({ binPath: '/new/release/cli.js', services }) };
  };
  return e;
}
const refreshes = e => e.recorder.ran.filter(call => call[1] === 'service');

test('a retained-configuration update re-points existing Fleet services at the new release', async () => {
  const e = fleet();
  const row = await runFleetPhase({ ...ARGS, disableFleetAgentsSetup: true }, e, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'installed');
  assert.deepEqual(e.recorder.ran, [
    [ARGS.acquiredFleet, 'managed-cli', 'setup', '--configuration', CONFIG, '--json'],
    [ARGS.acquiredFleet, 'service', 'refresh', '--json'],
  ]);
  assert.deepEqual(e.recorder.ranEnv.at(-1), { OURS_CONFIG: TARGET.configPath });
  const output = said(e);
  assert.match(output, /Fleet supervisor service now starts this release/);
  assert.match(output, /still uses the previous release until restarted; this installer did not restart it/);
});

test('a full Fleet initialization also refreshes, after init and policy setup', async () => {
  const e = fleet({ services: [service({ running: 'current' }), service({ service: 'web', state: 'current', running: 'unknown' })] });
  await runFleetPhase({ ...ARGS, fleetSettingsPath: '/home/me/private/fleet.json' }, e, { target: TARGET, isDefaultStateDir: false });
  assert.deepEqual(e.recorder.ran.map(call => call[1]), ['init', 'managed-cli', 'service']);
  assert.doesNotMatch(said(e), /until restarted/);
});

test('refresh starts, stops and restarts nothing', async () => {
  const e = fleet();
  await runFleetPhase({ ...ARGS, disableFleetAgentsSetup: true }, e, { target: TARGET, isDefaultStateDir: false });
  for (const call of e.recorder.ran) for (const forbidden of ['up', 'start', 'stop', 'restart', 'enable', 'disable', '_run', '_run-fleet'])
    assert.equal(call.includes(forbidden), false, call.join(' '));
  assert.deepEqual(e.recorder.interactive, []);
  assert.deepEqual(e.recorder.wroteText, [], 'the installer writes no service definition itself');
});

test('unchanged and unrecognized definitions are reported, not replaced', async () => {
  const e = fleet({ services: [service({ state: 'unrecognized', running: 'unknown', detail: 'a drop-in in /x.d sets ExecStart; left untouched' })] });
  const row = await runFleetPhase({ ...ARGS, disableFleetAgentsSetup: true }, e, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'installed');
  assert.match(said(e), /Fleet supervisor service definition was left unchanged: a drop-in in \/x\.d sets ExecStart/);
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
