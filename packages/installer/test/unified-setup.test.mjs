import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runSetup, prepareSetupPlan, executeSetupPlan, completeReleasePolicy } from '../lib/setup.mjs';
import { runServerCommand } from '../lib/orchestrate.mjs';

const root = '/private/install';
const record = { schema: 2, mode: 'packages', root, workDir: `${root}/runtime`, sourcesPath: `${root}/sources.json`, configPath: `${root}/storage/state/daemon/config.json`, instanceId: '12345678-1234-1234-1234-123456789abc', project: 'ours-test', services: ['daemon', 'telegram', 'cowork', 'messenger'], port: 3050, coworkPort: 3052, messengerPort: 8420, uid: 1000, gid: 1000 };
const policy = { packages: Object.fromEntries(['sdk', 'cli', 'mcp', 'tg-connector', 'cowork', 'messenger-server', 'codex', 'claude-code', 'fleet'].map(n => [`@ours.network/${n}`, { type: 'npm', version: '1.0.0' }])) };
const options = { scope: 'all', operation: 'install', mode: 'packages', stateDir: root, identityName: 'Test Human', integrations: ['codex'], port: 3050, coworkPort: 3052, messengerPort: 8420, interactive: false };
function fixture(existing = false) {
  const events = [], lines = [];
  const files = new Map(existing ? [[`${root}/installation.json`, { ...record }], [record.sourcesPath, policy]] : []);
  const effects = {
    home: '/private', env: {}, platform: { platform: 'linux', arch: 'x64' }, interactive: false,
    out: line => lines.push(line), readJson: path => files.get(path) ?? null,
    readText: () => null, packagedSourcePolicy: () => policy, readManagedClientProfile: () => null,
    resolveSourcePolicy: async p => p,
    ask: () => assert.fail('CLI must never ask'), askLine: () => assert.fail('CLI must never ask'),
    withInstallationLock: async (_root, action) => { events.push('lock'); return action(); },
    newInstallation: () => ({ ...record }), serverPreflight: async () => { events.push('preflight'); },
    initializeSelection: async () => { events.push('initialize'); files.set(record.sourcesPath, policy); },
    writeJson: (path, text) => files.set(path, JSON.parse(text)), prepareInstallation: async () => { events.push('prepare'); },
    serverAccess: async (_record, operation) => { events.push(operation); }, recordInstallationBuild: async () => { events.push('record'); },
    serverLifecycle: async (_record, operation, services) => { events.push([operation, services]); },
    serverEnsureIdentity: async (_record, name) => { events.push(['identity', name]); return { name, cid: 'A'.repeat(64), created: false }; },
    prepareLocalClient: async () => { events.push('handoff'); return { configPath: '/private/client/profile.json' }; },
  };
  return { effects, events, lines, files };
}

test('public executable invokes the unified setup entry', () => {
  const entry = readFileSync(new URL('../install.mjs', import.meta.url), 'utf8');
  assert.match(entry, /import \{ runSetup \} from '\.\/lib\/setup\.mjs'/);
  assert.match(entry, /await runSetup\(process.argv.slice\(2\)/);
});

test('incomplete CLI presets refuse before reads, locks or prompts', async () => {
  const { effects, events, lines } = fixture();
  effects.packagedSourcePolicy = () => assert.fail('missing CLI inputs must precede policy reads');
  assert.equal(await runSetup(['server', '--mode', 'docker'], effects), 2);
  assert.deepEqual(events, []);
  assert.match(lines.join('\n'), /state-dir|identity-name/);
});

test('no-argument headless invocation refuses instead of silently choosing defaults', async () => {
  const { effects, events } = fixture();
  assert.equal(await runSetup([], effects), 2);
  assert.deepEqual(events, []);
});

test('dry-run uses the complete plan without executing server or client actions', async () => {
  const { effects, events } = fixture();
  const plan = await prepareSetupPlan({ ...options, dryRun: true }, effects);
  assert.equal(await executeSetupPlan(plan, effects, { server: () => assert.fail('server mutation'), client: () => assert.fail('client mutation') }), 0);
  assert.deepEqual(events, []);
});

test('missing Fleet settings file refuses before server preparation', async () => {
  const { effects, events } = fixture();
  await assert.rejects(prepareSetupPlan({ ...options, integrations: ['fleet'], fleetSettingsPath: '/missing.json' }, effects), /Fleet settings/);
  assert.deepEqual(events, []);
});

test('full installation starts daemon, retains identity, starts consumers, then connects clients', async () => {
  const { effects, events, files } = fixture();
  const result = await executeSetupPlan({ ...options, sourcePolicy: policy }, effects, { server: runServerCommand, client: async command => { events.push(['clients', command]); return 0; } });
  assert.equal(result, 0);
  const daemon = events.findIndex(e => Array.isArray(e) && e[0] === 'start' && e[1]?.length === 1);
  const identity = events.findIndex(e => Array.isArray(e) && e[0] === 'identity');
  const consumers = events.findIndex(e => Array.isArray(e) && e[0] === 'start' && e[1]?.includes('messenger'));
  assert.ok(daemon < identity && identity < consumers && consumers < events.indexOf('handoff'));
  assert.equal(files.get(`${root}/installation.json`).messengerIdentity, 'Test Human');
  const command = events.find(e => Array.isArray(e) && e[0] === 'clients')[1];
  assert.equal(command.preset, true); assert.equal(command.nonInteractive, true);
  assert.deepEqual(command.integrations, ['codex']);
});

test('server failure prevents client handoff and a false completion message', async () => {
  const { effects, events, lines } = fixture();
  assert.equal(await executeSetupPlan({ ...options, sourcePolicy: policy }, effects, { server: async () => 2, client: () => assert.fail('must not configure clients') }), 2);
  assert.ok(!events.includes('handoff'));
  assert.doesNotMatch(lines.join('\n'), /Requested install completed/);
});

test('retained release reconstructs client selection without changing component versions', () => {
  const release = { packages: { '@ours.network/fleet': { version: '4.2.0', integrity: 'same' } } };
  const full = completeReleasePolicy({ release, packages: {} }, policy);
  assert.equal(full.release, release);
  assert.deepEqual(full.packages['@ours.network/fleet'], { type: 'npm', version: '4.2.0' });
  assert.throws(() => completeReleasePolicy({ packages: {} }), /full --sources/);
});

test('client-only repair retains its pinned source policy while explicit update selects the new release', async () => {
  const { effects, files } = fixture();
  const profile = { endpoint: 'http://127.0.0.1:3050', expectedInstanceId: record.instanceId, credentialPath: '/private/token', installer: { sourcesPath: '/private/retained.json' } };
  const retained = { packages: { '@ours.network/codex': { type: 'npm', version: '0.9.0' } } };
  files.set('/private/profile.json', profile); files.set('/private/retained.json', retained);
  effects.readText = () => 'credential'; effects.readManagedClientProfile = () => profile;
  const client = { scope: 'client', operation: 'install', config: '/private/profile.json', integrations: ['codex'], interactive: false };
  assert.equal((await prepareSetupPlan(client, effects)).sourcePolicy, retained);
  assert.equal((await prepareSetupPlan({ ...client, operation: 'update' }, effects)).sourcePolicy, policy);
});

test('server-only update preserves a stopped daemon without probing or creating identities', async () => {
  const { effects, events, lines } = fixture(true);
  effects.serverLifecycle = async () => [];
  effects.serverEnsureIdentity = () => assert.fail('stopped daemon must not receive identity requests');
  assert.equal(await executeSetupPlan({ ...options, scope: 'server', operation: 'update', integrations: undefined }, effects, { server: async () => 0 }), 0);
  assert.match(lines.join('\n'), /Daemon remains stopped/);
  assert.ok(!events.includes('handoff'));
});

test('invalid Human names fail before acquiring a server lock', async () => {
  const { effects, events } = fixture();
  await assert.rejects(prepareSetupPlan({ ...options, identityName: '../invalid' }, effects), /Invalid Human identity name/);
  assert.deepEqual(events, []);
});
