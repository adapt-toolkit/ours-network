import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServerOnboarding } from '../lib/server-onboarding.mjs';

const rootRow = { name: 'Existing Human', cid: 'existing-cid', kind: 'root', temp: null, session: 'other-live' };
function fixture(t, rows = [[]]) {
  const root = mkdtempSync(join(tmpdir(), 'ours-server-onboarding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = { root, workDir: join(root, 'runtime'), configPath: join(root, 'config.json'), schema: 2, mode: 'packages', port: 3050, instanceId: '12345678-1234-1234-1234-123456789abc' };
  const calls = [], messages = [];
  const effects = {
    out: message => messages.push(message), readManagedClientProfile: () => null,
    async run(command, args, options) { calls.push({ command, args, options }); return { stdout: JSON.stringify(rows.shift()) }; },
    async serverAccess(selected, operation, options) { calls.push({ selected, operation, options }); assert.equal(existsSync(options.output), false); writeFileSync(options.output, 'issued-client-secret\n', { mode: 0o600 }); },
  };
  const deps = {
    compose: async (selected, args) => { calls.push({ selected, args }); return { stdout: JSON.stringify(rows.shift()) }; },
    localEnv: selected => ({ OURS_CONFIG: selected.configPath, OURS_DAEMON_ID: selected.instanceId }),
    bin: (selected, name) => join(selected.workDir, 'node_modules/.bin', name),
  };
  return { root, record, calls, messages, effects, deps, helper: () => createServerOnboarding(effects, deps) };
}
test('existing root is retained without binding, renaming or creation', async t => {
  const f = fixture(t, [[rootRow, { name: 'Role', cid: 'role-cid', kind: 'role' }]]);
  assert.deepEqual(await f.helper().serverEnsureIdentity(f.record, 'Requested Human'), { name: rootRow.name, cid: rootRow.cid, created: false });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].args.slice(0, 2), ['identity', 'list']);
  assert.match(f.messages.join('\n'), /2/);
});
test('fresh native server uses supported create-root arguments and rereads root', async t => {
  const created = { ...rootRow, name: 'New Human', cid: 'new-cid', session: null };
  const f = fixture(t, [[], { info: { name: created.name, cid: created.cid }, hierarchy: 'root' }, [created]]);
  assert.deepEqual(await f.helper().serverEnsureIdentity(f.record, created.name), { name: created.name, cid: created.cid, created: true });
  const call = f.calls[1];
  assert.deepEqual(call.args.slice(0, 6), ['identity', 'create-root', '--name', 'New Human', '--skip-if-root-exists', 'true']);
  assert.equal(call.args.includes('--force'), false); assert.ok(call.args.includes('--config')); assert.ok(call.args.includes('--state-dir')); assert.ok(call.args.includes('--json'));
  assert.equal(call.options.env.OURS_DAEMON_ID, f.record.instanceId);
});
test('Docker identity operations execute inside the running daemon container', async t => {
  const f = fixture(t, [[rootRow]]); f.record.mode = 'docker';
  await f.helper().serverEnsureIdentity(f.record, 'Human');
  assert.deepEqual(f.calls[0].args.slice(0, 5), ['exec', '-T', 'daemon', 'node', '/opt/ours/node_modules/@ours.network/cli/dist/cli.js']);
  assert.ok(f.calls[0].args.includes('/var/lib/ours/config.json')); assert.ok(f.calls[0].args.includes('/var/lib/ours'));
});
for (const name of ['', '../Human', 'contact-book', 'root.json', 'e\u0301', 'a'.repeat(65)]) test('invalid identity fails before owner effects: ' + JSON.stringify(name), async t => {
  const f = fixture(t); await assert.rejects(f.helper().serverEnsureIdentity(f.record, name), /identity name/i); assert.equal(f.calls.length, 0);
});
test('root creation failure is retained only if another root is now visible', async t => {
  const f = fixture(t); let n = 0;
  f.effects.run = async () => { n++; if (n === 2) throw Error('root already created'); return { stdout: JSON.stringify(n === 1 ? [] : [rootRow]) }; };
  assert.deepEqual(await f.helper().serverEnsureIdentity(f.record, 'Human'), { name: rootRow.name, cid: rootRow.cid, created: false });
});
test('malformed list never triggers identity creation', async t => {
  const f = fixture(t, [{ identities: [] }]); await assert.rejects(f.helper().serverEnsureIdentity(f.record, 'Human'), /identity list/i); assert.equal(f.calls.length, 1);
});
test('name collision with a non-root identity fails without mutating it', async t => {
  const f = fixture(t, [[{ name: 'Human', cid: 'role-cid', kind: 'role' }]]);
  await assert.rejects(f.helper().serverEnsureIdentity(f.record, 'Human'), /already exists/i); assert.equal(f.calls.length, 1);
});
test('client handoff atomically publishes private profile and a separately issued credential', async t => {
  const f = fixture(t), settings = join(f.root, 'fleet.json'); writeFileSync(settings, '{}');
  const result = await f.helper().prepareLocalClient(f.record, ['codex', 'fleet'], settings);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].operation, 'access-issue');
  assert.equal(readFileSync(result.profile.credentialPath, 'utf8'), 'issued-client-secret\n');
  assert.deepEqual(JSON.parse(readFileSync(result.configPath)), result.profile);
  assert.equal(result.profile.endpoint, 'http://127.0.0.1:3050'); assert.equal(result.profile.expectedInstanceId, f.record.instanceId);
  assert.deepEqual(result.profile.installer, { integrations: ['codex', 'fleet'], fleetSettingsPath: settings });
  assert.equal(statSync(result.configPath).mode & 0o777, 0o600); assert.equal(statSync(result.profile.credentialPath).mode & 0o777, 0o600);
  assert.equal(f.messages.join('\n').includes('issued-client-secret'), false);
  assert.equal(readdirSync(join(f.root, 'client')).some(name => name.startsWith('.pending-')), false);
});
test('managed client selecting another server refuses before credential issuance', async t => {
  const f = fixture(t); f.effects.readManagedClientProfile = () => ({ endpoint: 'http://elsewhere:3050', expectedInstanceId: f.record.instanceId });
  await assert.rejects(f.helper().prepareLocalClient(f.record, ['codex']), /another server/i); assert.equal(f.calls.length, 0); assert.equal(existsSync(join(f.root, 'client')), false);
});
test('failed issuance leaves prior handoff unchanged and publishes nothing new', async t => {
  const f = fixture(t), prior = await f.helper().prepareLocalClient(f.record, ['codex']);
  const before = readFileSync(prior.configPath, 'utf8');
  f.effects.serverAccess = async () => { throw Error('fixture failure with sensitive diagnostic'); };
  await assert.rejects(f.helper().prepareLocalClient(f.record, ['claude-code']), /credential issuance failed/i);
  assert.equal(readFileSync(prior.configPath, 'utf8'), before); assert.equal(readdirSync(join(f.root, 'client')).length, 1);
});
test('insecure issued credentials are never published', async t => {
  const f = fixture(t); f.effects.serverAccess = async (_, __, { output }) => { writeFileSync(output, 'secret'); chmodSync(output, 0o644); };
  await assert.rejects(f.helper().prepareLocalClient(f.record, ['codex']), /private/i); assert.deepEqual(readdirSync(join(f.root, 'client')), []);
});
for (const integrations of [[], ['unknown'], ['codex', 'codex']]) test('invalid client selection fails before any issuance: ' + JSON.stringify(integrations), async t => {
  const f = fixture(t); await assert.rejects(f.helper().prepareLocalClient(f.record, integrations), /integrations/i); assert.equal(f.calls.length, 0);
});
