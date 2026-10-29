// Fleet `init` keeps installed role copies byte-identical, so an update adopts
// newer packaged role defaults through Fleet's own `migrate-role-defaults`. The
// installer applies only a plan that replaces or adds unmodified defaults, and
// never fails the installation over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runFleetPhase, runFleetRoleDefaultMigration, FLEET_MANAGED_CLI_CAPABILITY, FLEET_SERVICE_REFRESH_CAPABILITY } from '../lib/orchestrate.mjs';
import { fx, said, HOME } from './fake-effects.mjs';

const FLEET = '/new/release/node_modules/.bin/ours-fleet';
const ARGS = { dryRun: false, assumeYes: false, channel: 'latest', brokerUrl: 'wss://b', acquiredFleet: FLEET };
const CONFIG = join(HOME, 'fleet.yaml');
const ROOT = join(HOME, 'fleet');
const TARGET = { mode: 'host-profile', configPath: '/home/me/private/profile.json', profile: {}, endpoint: 'http://127.0.0.1:8787' };
const PLAN = { init: ['ours-fleet'], configPath: CONFIG };
const managedReport = JSON.stringify({ version: 1, configuration: CONFIG, roles: [], removed: [], disclosure: [], enabled: [] });

/** Fleet's own text report for a plan (dry) or an applied migration (write). */
const report = ({ write = false, removals = [], replacements = [], additions = [], preserved = [] } = {}) => [
  write ? 'Applied packaged role-default migration.' : 'Dry run only; no files were changed.',
  ...removals.map(path => `Remove ${path}`), ...replacements.map(path => `Replace ${path}`),
  ...additions.map(path => `Add ${path}`), ...preserved.map(path => `Preserve customized ${path}`),
  `Staging path: ${HOME}/.fleet.role-defaults-stage-1`, `Recovery backup: ${HOME}/.fleet.role-defaults-backup-1`,
  ...(write ? [] : ['Re-run with --write to adopt only these exact recognized defaults.']), ''].join('\n');

function fleet({ plan = {}, failDry = false, failWrite = false } = {}) {
  const e = fx({ text: { [CONFIG]: 'api_version: ours.network/fleet/v2\n' }, fleetCapabilities: [FLEET_MANAGED_CLI_CAPABILITY, FLEET_SERVICE_REFRESH_CAPABILITY] });
  const run = e.run;
  e.run = async (cmd, args, opts = {}) => {
    const result = await run(cmd, args, opts);
    if (args[0] === 'managed-cli') return { ok: true, code: 0, stdout: managedReport };
    if (args[0] === 'service') return { ok: true, code: 0, stdout: JSON.stringify({ services: [] }) };
    if (args[0] !== 'migrate-role-defaults') return result;
    const write = args.includes('--write');
    if (write ? failWrite : failDry) throw new Error('ours-fleet exited 1: packaged role-default migration requires an owner-private regular config');
    return { ok: true, code: 0, stdout: report({ ...plan, write }) };
  };
  return e;
}
const migrations = e => e.recorder.ran.filter(call => call[1] === 'migrate-role-defaults');

test('an update adopts unmodified defaults after reviewing the plan, before policy setup and service refresh', async () => {
  const e = fleet({ plan: { replacements: [join(ROOT, 'roles/Developer.yaml')], additions: [join(ROOT, 'roles/Engineer.yaml')], preserved: [join(ROOT, 'roles/Critic.yaml')] } });
  const row = await runFleetPhase({ ...ARGS, disableFleetAgentsSetup: true }, e, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'installed');
  assert.deepEqual(e.recorder.ran.map(call => call.slice(0, 2)), [
    [FLEET, 'migrate-role-defaults'], [FLEET, 'migrate-role-defaults'], [FLEET, 'managed-cli'], [FLEET, 'service'],
  ]);
  assert.deepEqual(migrations(e), [
    [FLEET, 'migrate-role-defaults', '--configuration', CONFIG],
    [FLEET, 'migrate-role-defaults', '--configuration', CONFIG, '--write'],
  ]);
  assert.deepEqual(e.recorder.ranEnv[1], { OURS_CONFIG: TARGET.configPath });
  const output = said(e);
  assert.match(output, /Updated unmodified Fleet default .*roles\/Developer\.yaml/);
  assert.match(output, /Added Fleet default .*roles\/Engineer\.yaml/);
  assert.match(output, /Kept customized .*roles\/Critic\.yaml unchanged/);
  assert.match(output, /Previous Fleet configuration kept at .*role-defaults-backup-1/);
  assert.match(output, /existing task members keep the role they were launched with/);
});

test('current defaults are reported and nothing is written', async () => {
  const e = fleet({ plan: { preserved: [join(ROOT, 'roles/Developer.yaml')] } });
  const result = await runFleetRoleDefaultMigration(ARGS, e, PLAN, TARGET);
  assert.equal(result.state, 'current');
  assert.equal(migrations(e).length, 1, 'no write');
  assert.match(said(e), /Fleet role defaults are current; 1 customized file\(s\) left unchanged/);
});

test('a plan that removes files is shown with the manual command and never applied', async () => {
  const e = fleet({ plan: { removals: [join(ROOT, 'agent_templates/Old.yaml')], replacements: [join(ROOT, 'roles/Developer.yaml')] } });
  const result = await runFleetRoleDefaultMigration(ARGS, e, PLAN, TARGET);
  assert.equal(result.state, 'attention');
  assert.deepEqual(migrations(e), [[FLEET, 'migrate-role-defaults', '--configuration', CONFIG]]);
  const output = said(e);
  assert.match(output, /adopting them removes files, so nothing was changed/);
  assert.match(output, /remove .*agent_templates\/Old\.yaml/);
  assert.match(output, /Review the plan with: .*migrate-role-defaults --configuration .*fleet\.yaml.*then apply it with --write/);
});

test('a refused plan or a failed write warns once and does not fail the installation', async () => {
  const refused = fleet({ failDry: true });
  const row = await runFleetPhase({ ...ARGS, disableFleetAgentsSetup: true }, refused, { target: TARGET, isDefaultStateDir: false });
  assert.equal(row.state, 'installed');
  assert.equal(migrations(refused).length, 1);
  assert.match(said(refused), /Fleet role defaults were not checked \(.*owner-private.*\); existing role files are unchanged\. Review with: /);
  assert.ok(refused.recorder.ran.some(call => call[1] === 'managed-cli'), 'later Fleet steps still run');
  const failed = fleet({ plan: { replacements: [join(ROOT, 'roles/Developer.yaml')] }, failWrite: true });
  const result = await runFleetRoleDefaultMigration(ARGS, failed, PLAN, TARGET);
  assert.equal(result.state, 'failed');
  assert.equal(migrations(failed).length, 2, 'no retry');
  assert.match(said(failed), /Fleet role defaults were not updated .*Fleet restores the previous files on failure/);
});

test('a dry run or a missing configuration migrates nothing', async () => {
  const dry = fleet({ plan: { replacements: [join(ROOT, 'roles/Developer.yaml')] } });
  await runFleetPhase({ ...ARGS, dryRun: true, disableFleetAgentsSetup: true }, dry, { target: TARGET, isDefaultStateDir: false });
  assert.deepEqual(migrations(dry), []);
  const fresh = fx({ text: {} });
  await runFleetPhase({ ...ARGS, disableFleetAgentsSetup: true }, fresh, { target: TARGET, isDefaultStateDir: false });
  assert.deepEqual(fresh.recorder.ran, []);
});
