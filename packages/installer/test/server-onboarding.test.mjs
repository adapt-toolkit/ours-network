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
  assert.equal(f.calls.length, 1); assert.equal(JSON.parse(f.calls[0].args.at(-1)).operation, 'list');
  assert.match(f.messages.join('\n'), /2/);
});
test('fresh native server uses supported create-root arguments and rereads root', async t => {
  const created = { ...rootRow, name: 'New Human', cid: 'new-cid', session: null };
  const f = fixture(t, [[], { info: { name: created.name, cid: created.cid }, hierarchy: 'root' }, [created]]);
  assert.deepEqual(await f.helper().serverEnsureIdentity(f.record, created.name), { name: created.name, cid: created.cid, created: true });
  const call = f.calls[1];
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args.slice(0, 2), ['--input-type=module', '-e']);
  const selection = JSON.parse(call.args.at(-1));
  assert.equal(selection.operation, 'create-root'); assert.equal(selection.name, 'New Human');
  assert.equal(selection.endpoint, 'http://127.0.0.1:3050');
  assert.equal(selection.instanceId, f.record.instanceId);
  assert.equal(selection.credentialPath, join(f.root, 'storage/state/daemon/daemon-token'));
  assert.equal(selection.anchor, join(f.record.workDir, 'package.json'));
  assert.equal(selection.leaseToken, undefined); assert.match(call.args[2], /leaseToken: randomUUID\(\)/);
  assert.equal(call.options.sensitive,true);
  assert.match(call.args[2], /skipIfRootExists: true/);
  assert.match(call.args[2], /releaseLease/); assert.match(call.args[2], /env: \{\}/);
  assert.equal(call.args.includes('--force'), false);
  assert.equal(call.options.env.OURS_DAEMON_ID, f.record.instanceId);
});
test('Docker identity operations execute inside the running daemon container', async t => {
  const f = fixture(t, [[rootRow]]); f.record.mode = 'docker';
  await f.helper().serverEnsureIdentity(f.record, 'Human');
  assert.deepEqual(f.calls[0].args.slice(0, 5), ['exec', '-T', 'daemon', 'node', '--input-type=module']);
  const selection = JSON.parse(f.calls[0].args.at(-1));
  assert.equal(selection.endpoint, 'http://127.0.0.1:3050');
  assert.equal(selection.credentialPath, '/var/lib/ours/daemon-token');
  assert.equal(selection.instanceId, f.record.instanceId);
  assert.equal(selection.anchor, '/opt/ours/package.json');

});
for (const name of ['', '../Human', 'contact-book', 'root.json', 'e\u0301', 'a'.repeat(65)]) test('invalid identity fails before owner effects: ' + JSON.stringify(name), async t => {
  const f = fixture(t); await assert.rejects(f.helper().serverEnsureIdentity(f.record, name), /identity name/i); assert.equal(f.calls.length, 0);
});
test('root creation failure is retained only if another root is now visible', async t => {
  const f = fixture(t); let n = 0;
  f.effects.run = async () => { n++; if (n === 2) throw Object.assign(Error('root already created'), { code: 'ROOT_EXISTS' }); return { stdout: JSON.stringify(n === 1 ? [] : [rootRow]) }; };
  assert.deepEqual(await f.helper().serverEnsureIdentity(f.record, 'Human'), { name: rootRow.name, cid: rootRow.cid, created: false });
});
test('malformed list never triggers identity creation', async t => {
  const f = fixture(t, [{ identities: [] }]); await assert.rejects(f.helper().serverEnsureIdentity(f.record, 'Human'), /identity list/i); assert.equal(f.calls.length, 1);
});
test('name collision with a non-root identity fails without mutating it', async t => {
  const f = fixture(t, [[{ name: 'Human', cid: 'role-cid', kind: 'role' }]]);
  await assert.rejects(f.helper().serverEnsureIdentity(f.record, 'Human'), /already exists/i); assert.equal(f.calls.length, 1);
});
const own = { name: 'Ada Lovelace', cid: 'own-cid', kind: 'role', temp: null, session: null };
test('an existing permanent identity of that name under the root is the Messenger identity, unchanged', async t => {
  const f = fixture(t, [[rootRow, own, { name: 'Role', cid: 'role-cid', kind: 'role' }]]);
  assert.deepEqual(await f.helper().serverEnsureMessengerIdentity(f.record, own.name), { name: own.name, cid: own.cid, created: false });
  assert.equal(f.calls.length, 1); assert.equal(JSON.parse(f.calls[0].args.at(-1)).operation, 'list');
});
test('a missing Messenger identity is created as a role under the retained root and reread', async t => {
  const f = fixture(t, [[rootRow], { info: { name: own.name, cid: own.cid }, hierarchy: 'role', underRoot: rootRow.name }, [rootRow, own]]);
  assert.deepEqual(await f.helper().serverEnsureMessengerIdentity(f.record, own.name), { name: own.name, cid: own.cid, created: true });
  const selection = JSON.parse(f.calls[1].args.at(-1));
  assert.equal(selection.operation, 'create-role'); assert.equal(selection.name, own.name);
  assert.match(f.calls[1].args[2], /createIdentity\(/); assert.match(f.calls[1].args[2], /releaseLease/);
  assert.equal(f.calls[1].options.sensitive, true); assert.equal(f.calls.length, 3);
});
for (const [label, taken] of [['the root', { ...rootRow, name: own.name }], ['a temporary identity', { ...own, temp: { state: 'other-live', ownerPid: 1 } }], ['a quarantined identity', { name: own.name, status: 'awaiting-root' }]])
  test('a name held by ' + label + ' is refused without creating or changing anything', async t => {
    const f = fixture(t, [[...(taken.kind === 'root' ? [] : [rootRow]), taken]]);
    await assert.rejects(f.helper().serverEnsureMessengerIdentity(f.record, own.name), /already used by another identity/); assert.equal(f.calls.length, 1);
  });
test('no Messenger identity is created on a host without a Human identity', async t => {
  const f = fixture(t, [[]]);
  await assert.rejects(f.helper().serverEnsureMessengerIdentity(f.record, own.name), /requires the Human identity/); assert.equal(f.calls.length, 1);
});
test('a creation that did not delegate under the root, or left the root changed, is not accepted', async t => {
  let f = fixture(t, [[rootRow], { info: { name: own.name, cid: own.cid }, hierarchy: 'root' }, [rootRow, own]]);
  await assert.rejects(f.helper().serverEnsureMessengerIdentity(f.record, own.name), /did not delegate/);
  f = fixture(t, [[rootRow], { info: { name: own.name, cid: own.cid }, hierarchy: 'role' }, [{ ...rootRow, cid: 'other-root' }, own]]);
  await assert.rejects(f.helper().serverEnsureMessengerIdentity(f.record, own.name), /without a usable identity/);
});
for (const [label, after, expected] of [
  ['a compatible winner is used', [rootRow, own], { name: own.name, cid: own.cid, created: false }],
  ['an incompatible winner is refused', [rootRow, { ...own, temp: { state: 'other-live', ownerPid: 1 } }], /already used by another identity/],
  ['no winner keeps the original failure', [rootRow], error => error.code === 'NAME_TAKEN'],
]) test('concurrent creation of the Messenger identity: ' + label, async t => {
  const f = fixture(t); let n = 0;
  f.effects.run = async () => { n++; if (n === 2) throw Object.assign(Error('create failed'), { code: 'NAME_TAKEN' }); return { stdout: JSON.stringify(n === 1 ? [rootRow] : after) }; };
  const result = f.helper().serverEnsureMessengerIdentity(f.record, own.name);
  if (expected instanceof RegExp || typeof expected === 'function') await assert.rejects(result, expected); else assert.deepEqual(await result, expected);
  assert.equal(n, 3);
});
for (const name of ['', '../Ada', 'a'.repeat(65)]) test('invalid Messenger identity name fails before owner effects: ' + JSON.stringify(name), async t => {
  const f = fixture(t); await assert.rejects(f.helper().serverEnsureMessengerIdentity(f.record, name), /identity name/i); assert.equal(f.calls.length, 0);
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
for (const integrations of [['unknown'], ['codex', 'codex']]) test('invalid client selection fails before any issuance: ' + JSON.stringify(integrations), async t => {
  const f = fixture(t); await assert.rejects(f.helper().prepareLocalClient(f.record, integrations), /integrations/i); assert.equal(f.calls.length, 0);
});
test('CLI-only workspace handoff issues a private profile without harness integrations', async t => {
  const f = fixture(t), result=await f.helper().prepareLocalClient(f.record, []);
  assert.deepEqual(result.profile.installer.integrations, []);
  assert.equal(f.calls.length, 1);
  assert.equal(statSync(result.profile.credentialPath).mode & 0o777, 0o600);
});

test('gateway handoff derives daemon prefix and retains existing managed credential on rerun', async t => {
  const f = fixture(t);
  f.record.mode = 'docker'; f.record.gateway = { version: 1 };
  const first = await f.helper().prepareLocalClient(f.record, ['fleet']);
  assert.equal(first.profile.serverUrl, 'http://127.0.0.1:3050');
  assert.equal(first.profile.endpoint, 'http://127.0.0.1:3050/daemon');
  f.effects.readManagedClientProfile = () => first.profile;
  const second = await f.helper().prepareLocalClient(f.record, ['fleet', 'codex']);
  assert.equal(f.calls.length, 1, 'reruns must not issue another credential');
  assert.equal(second.profile.credentialPath, first.profile.credentialPath);
  assert.deepEqual(second.profile.installer.integrations, ['fleet', 'codex']);
  assert.equal(readFileSync(first.profile.credentialPath, 'utf8'), 'issued-client-secret\n');
});

test('permission and lifecycle failures never trigger root reread or retry', async t => {
  for (const code of ['UNAUTHORIZED', 'BINDING_REASSIGNED', 'OWNER_OPERATION_FAILED']) {
    const f=fixture(t,[[], {onboardingError:code}]);
    await assert.rejects(f.helper().serverEnsureIdentity(f.record,'Human'), error=>error.code===code);
    assert.equal(f.calls.length,2);
  }
});

test('Messenger profile handoff preserves retained root and profile bytes through the executed helper', async t => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const f=fixture(t),cid='a'.repeat(64),original=JSON.stringify({name:'Existing',surname:'Human'}),profilePath=join(f.root,'profile.json');
  writeFileSync(profilePath,original,{mode:0o600});
  const { installationPaths }=await import('../lib/plan.mjs');
  const credential=installationPaths(f.record).credentials.messenger;
  const { dirname }=await import('node:path');
  const { mkdirSync }=await import('node:fs');mkdirSync(dirname(credential),{recursive:true,mode:0o700});writeFileSync(credential,'fixture-token',{mode:0o600});
  const calls=[];
  const server=createServer((req,res)=>{
    calls.push(req.method+' '+req.url);assert.equal(req.headers['x-ours-api-token'],'fixture-token');
    assert.equal(req.method,'GET','existing profile must never be rewritten');assert.equal(req.url,'/api/identity');
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({cid,name:'Existing Root',humanProfile:JSON.parse(readFileSync(profilePath,'utf8'))}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  f.record.messengerPort=server.address().port;
  f.effects.run=async (command,args,options)=>{const result=await exec(command,args,{env:{...process.env,...options.env}});return {code:0,stdout:result.stdout};};
  await f.helper().serverEnsureHumanProfile(f.record,{name:'Requested',surname:'Replacement'});
  assert.deepEqual(calls,['GET /api/identity']);assert.equal(readFileSync(profilePath,'utf8'),original);
  assert.equal(f.calls.length,0,'no daemon root identity operation, credential issuance or Compose mutation');
});

test('Messenger profile handoff uses the gateway origin for a Docker gateway installation', async t => {
  const f=fixture(t);Object.assign(f.record,{mode:'docker',gateway:{version:1},port:3057,messengerPort:8421});
  const selections=[];
  f.deps.compose=async (selected,args)=>{assert.deepEqual(args.slice(0,4),['exec','-T','messenger','node']);selections.push(JSON.parse(args.at(-1)));return {code:0,stdout:'Messenger Name and Surname initialized.'};};
  await f.helper().serverEnsureHumanProfile(f.record,{name:'Ada',surname:'Lovelace'});
  assert.equal(selections.length,1);
  assert.equal(selections[0].origin,'http://127.0.0.1:3057','mutations carry the origin Messenger is configured with');
  assert.equal(selections[0].base,'http://127.0.0.1:8420','requests stay on the container-local Messenger port');
  f.record.gateway={version:1,serverUrl:'https://ours.example.test/team'};
  await f.helper().serverEnsureHumanProfile(f.record,{name:'Ada',surname:'Lovelace'});
  assert.equal(selections[1].origin,'https://ours.example.test');
});
