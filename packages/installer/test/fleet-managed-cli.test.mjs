// The installer asks the Fleet it just installed to prepare Fleet's own managed
// CLI policy. It owns none of that policy: these tests pin down what it passes,
// what it reports, and everything it must not do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runFleetPhase, runFleetManagedCliSetup, FLEET_MANAGED_CLI_CAPABILITY } from '../lib/orchestrate.mjs';
import { executeSetupPlan } from '../lib/setup.mjs';
import { parseSetupArgs, validateSetupOptions } from '../lib/setup-options.mjs';
import { fx, said, HOME } from './fake-effects.mjs';

const ARGS = { dryRun: false, assumeYes: false, channel: 'latest', brokerUrl: 'wss://b' };
const CONFIG = join(HOME, 'fleet.yaml');
const PROFILE = '/home/me/private/profile.json';
const TARGET = { mode: 'host-profile', configPath: PROFILE, profile: {}, endpoint: 'http://127.0.0.1:8787' };
const role = (over = {}) => ({
  role: 'FleetCoordinator', harness: 'codex', session: 'acp', workflows: ['task-workflow'],
  setup: { state: 'prepared', mechanism: 'codex-workspace-rules', artifact: '/work/.codex/rules/ours-fleet-abc.rules', action: 'created', detail: 'matches this installation' },
  session_policy: 'never-launched', observed: { current: [], historical: 0, summary: 'not observed' },
  commandPrefix: '/n /c --managed-configuration /f',
  scope: ['Runs outside the Codex command sandbox: task create; task start (the packaged Coordinator\'s task workflow).', 'task start and task finish provision and retire rooms and agents: this is real authority, not read access.'],
  warnings: [], ...over,
});
const report = (roles, extra = {}) => JSON.stringify({ version: 1, configuration: CONFIG, roles, removed: [], disclosure: [], enabled: [], ...extra });

/** A Fleet that supports setup; `stdout`/`fail` script the one managed-cli call. */
function fleet({ stdout = report([role()]), fail = false, capabilities = [FLEET_MANAGED_CLI_CAPABILITY], text = { [CONFIG]: 'api_version: ours.network/fleet/v2\n' } } = {}) {
  const e = fx({ text, fleetCapabilities: capabilities });
  const run = e.run;
  e.run = async (cmd, args, opts = {}) => {
    const result = await run(cmd, args, opts);
    if (args[0] !== 'managed-cli') return result;
    if (fail) throw new Error('ours-fleet exited 2');
    return { ok: true, code: 0, stdout };
  };
  return e;
}
const managed = e => e.recorder.ran.filter(call => call.includes('managed-cli'));
const prepared = { ...ARGS, fleetSettingsPath: '/home/me/private/fleet.json', acquiredFleet: '/exact/root/node_modules/.bin/ours-fleet' };

test('after Fleet configuration, the installed Fleet prepares its own policy and the scope is disclosed', async () => {
  const e = fleet();
  const row = await runFleetPhase(prepared, e, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'installed');
  // Version-matched: the exact acquired executable, never whatever `ours-fleet` is on PATH.
  assert.deepEqual(e.recorder.ran, [
    ['/exact/root/node_modules/.bin/ours-fleet', 'init', '--configuration', CONFIG, '--settings', '/home/me/private/fleet.json'],
    ['/exact/root/node_modules/.bin/ours-fleet', 'managed-cli', 'setup', '--configuration', CONFIG, '--json'],
  ]);
  assert.deepEqual(e.recorder.ranEnv.at(-1), { OURS_CONFIG: PROFILE });
  assert.deepEqual(e.recorder.runOptions.at(-1).allowCodes, [0, 1]);
  assert.deepEqual(e.recorder.interactive, [], 'setup never opens a terminal session');
  assert.deepEqual(e.recorder.wroteText, [], 'the installer writes no harness rule or Fleet configuration itself');
  const output = said(e);
  assert.match(output, /Fleet task commands, FleetCoordinator \(codex\/acp\): prepared — matches this installation/);
  assert.match(output, /task start and task finish provision and retire rooms and agents: this is real authority/);
  assert.match(output, /generated configuration only\. It was not executed: no agent session or model was started, and it is not evidence that a command reached a supervisor/);
});

test('starts nothing: only init and the static setup command run', async () => {
  const e = fleet();
  await runFleetPhase(prepared, e, { target: TARGET, isDefaultStateDir: false });
  for (const call of e.recorder.ran) {
    assert.ok(['init', 'managed-cli'].includes(call[1]), call.join(' '));
    for (const forbidden of ['up', 'spawn', 'restart', 'send', 'attach', '_run', 'task', 'room']) assert.equal(call.includes(forbidden), false, call.join(' '));
  }
});

test('the operator names agents in product terms; Fleet adds the key', async () => {
  const e = fleet({ stdout: report([role(), role({ role: 'Second' })], { enabled: [
    { agent: 'FleetCoordinator', file: '/home/me/fleet/agents/FleetCoordinator.yaml', changed: true },
    { agent: 'Second', file: '/home/me/fleet/agents/Second.yaml', changed: false }] }) });
  await runFleetPhase({ ...prepared, fleetTaskWorkflowAgents: ['FleetCoordinator', 'Second'] }, e, { target: TARGET, isDefaultStateDir: false });
  assert.deepEqual(managed(e), [['/exact/root/node_modules/.bin/ours-fleet', 'managed-cli', 'setup', '--configuration', CONFIG, '--json',
    '--enable', 'FleetCoordinator', '--enable', 'Second']]);
  assert.match(said(e), /Enabled Fleet task commands for FleetCoordinator \(.*FleetCoordinator\.yaml\)\. Its permissions were not changed\./);
  assert.match(said(e), /Already enabled: Fleet task commands for Second/);
});

test('with nothing declared it changes nothing and says how to opt in', async () => {
  const e = fleet({ stdout: report([role({ workflows: [], setup: { state: 'not-declared', detail: 'the agent does not declare managed_cli' }, scope: [] })]) });
  const row = await runFleetPhase(prepared, e, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'installed');
  assert.match(said(e), /No Fleet agent is set up to run Fleet task commands from a command sandbox; nothing was generated and no permission changed/);
  assert.match(said(e), /--fleet-task-workflow <Agent>/);
  assert.doesNotMatch(said(e), /Fleet task commands, /);
});

test('an unsupported combination is explained, not widened, and does not fail the installation', async () => {
  const e = fleet({ stdout: report([
    role({ role: 'Hermes', harness: 'hermes', setup: { state: 'unsupported', detail: "harness 'hermes' has no qualified native execution policy" }, scope: [] }),
    role({ role: 'Claude', harness: 'claude-code', setup: { state: 'generated-at-launch', detail: 'written at session start' },
      warnings: ["Claude's OS sandbox is not enabled by any readable settings file: Fleet's sandbox exclusions are inert"] }),
    role({ role: 'Running', session_policy: 'restart-required', setup: { state: 'prepared', action: 'updated', detail: 'matches this installation' } }),
  ], { removed: [{ path: '/old/.codex/rules/ours-fleet-old.rules', action: 'removed', detail: 'configuration /old.yaml no longer exists' }] }) });
  const result = await runFleetManagedCliSetup(prepared, e, { init: ['ours-fleet'], configPath: CONFIG }, TARGET);
  assert.equal(result.state, 'attention');
  const output = said(e);
  assert.match(output, /Hermes \(hermes\/acp\): unsupported — harness 'hermes' has no qualified native execution policy/);
  assert.match(output, /note: Claude's OS sandbox is not enabled/);
  assert.match(output, /Running is still running the previous policy; restart it \(ours-fleet restart Running\)/);
  assert.match(output, /Removed obsolete Fleet-generated policy \/old\/\.codex\/rules\/ours-fleet-old\.rules/);
  assert.equal(managed(e).length, 1, 'no second attempt with broader options');
  const row = await runFleetPhase(prepared, fleet({ stdout: report([role({ setup: { state: 'conflict', detail: 'a non-Fleet file occupies the Fleet rules file name' } })]) }), { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'installed');
});

test('a Fleet that predates the capability is left alone', async () => {
  const e = fleet({ capabilities: ['cowork.http-management-v1'] });
  const row = await runFleetPhase(prepared, e, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'installed');
  assert.deepEqual(managed(e), []);
  assert.doesNotMatch(said(e), /managed CLI/);
  const asked = fleet({ capabilities: [] });
  await runFleetPhase({ ...prepared, fleetTaskWorkflowAgents: ['FleetCoordinator'] }, asked, { target: TARGET, isDefaultStateDir: false });
  assert.deepEqual(managed(asked), []);
  assert.match(said(asked), /does not provide managed CLI setup \(managed-cli\.setup-v1\); --fleet-task-workflow was not applied to FleetCoordinator and nothing was changed/);
});

test('a failed or unreadable setup is reported with a retry line and installs nothing extra', async () => {
  for (const e of [fleet({ fail: true }), fleet({ stdout: 'not json' }), fleet({ stdout: JSON.stringify({ version: 2 }) })]) {
    const row = await runFleetPhase(prepared, e, { target: TARGET, isDefaultStateDir: false });
    assert.equal(row.state, 'installed');
    assert.match(said(e), /Fleet managed CLI setup did not complete .*Nothing else was changed; retry: \/exact\/root\/node_modules\/\.bin\/ours-fleet managed-cli setup --configuration \/home\/me\/fleet\.yaml/);
    assert.equal(managed(e).length, 1);
  }
});

test('a retained configuration is re-prepared on update even when agent setup is deferred', async () => {
  const e = fleet();
  const row = await runFleetPhase({ ...ARGS, acquiredFleet: '/exact/ours-fleet', disableFleetAgentsSetup: true }, e, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.note, 'agents setup deferred');
  assert.deepEqual(e.recorder.ran, [['/exact/ours-fleet', 'managed-cli', 'setup', '--configuration', CONFIG, '--json']]);
  const fresh = fleet({ text: {} });
  await runFleetPhase({ ...ARGS, acquiredFleet: '/exact/ours-fleet', disableFleetAgentsSetup: true }, fresh, { target: TARGET, isDefaultStateDir: false });
  assert.deepEqual(fresh.recorder.ran, [], 'no configuration yet: nothing to prepare, nothing run');
});

test('dry run and a failed initialization prepare nothing', async () => {
  const dry = fleet();
  await runFleetPhase({ ...prepared, dryRun: true }, dry, { target: TARGET, isDefaultStateDir: false });
  assert.deepEqual(managed(dry), []);
  const failed = fx({ runFails: ['--settings'], fleetCapabilities: [FLEET_MANAGED_CLI_CAPABILITY] });
  const row = await runFleetPhase(prepared, failed, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'failed');
  assert.deepEqual(managed(failed), []);
});

test('--fleet-task-workflow is parsed, validated and carried to the client phase', async () => {
  const base = ['client', '--config=/private/profile.json', '--integrations=codex,fleet', '--fleet-settings=/private/fleet.json'];
  const options = parseSetupArgs([...base, '--fleet-task-workflow', 'FleetCoordinator, Second'], { home: '/home/fixture' });
  assert.deepEqual(options.fleetTaskWorkflowAgents, ['FleetCoordinator', 'Second']);
  assert.equal(parseSetupArgs(base, { home: '/home/fixture' }).fleetTaskWorkflowAgents, undefined);
  for (const [args, message] of [
    [[...base, '--fleet-task-workflow', 'a b'], /unique Fleet agent names/],
    [[...base, '--fleet-task-workflow', 'A,A'], /unique Fleet agent names/],
    [[...base, '--fleet-task-workflow', '../x'], /unique Fleet agent names/],
    [[...base, '--fleet-task-workflow'], /requires a value/],
    [['client', '--config=/private/profile.json', '--integrations=codex', '--fleet-task-workflow=A'], /requires the fleet integration/],
    [['client', '--config=/private/profile.json', '--integrations=fleet', '--disable-fleet-agents-setup', '--fleet-task-workflow=A'], /conflicts with --disable-fleet-agents-setup/],
  ]) assert.throws(() => parseSetupArgs(args, { home: '/home/fixture' }), message);
  assert.throws(() => validateSetupOptions({ scope: 'client', config: '/p', integrations: ['fleet'], fleetSettingsPath: '/f', fleetTaskWorkflowAgents: 'A' }), /unique Fleet agent names/);
  let seen;
  const e = fx();
  const code = await executeSetupPlan({ ...options, sourcePolicy: e.packagedSourcePolicy() }, e, { client: async command => { seen = command; return 0; } });
  assert.equal(code, 0);
  assert.deepEqual(seen.fleetTaskWorkflowAgents, ['FleetCoordinator', 'Second']);
});
