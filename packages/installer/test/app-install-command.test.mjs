// The command the Ours App shows for a workspace on this computer (permanentInstallCommand
// in ours-app), driven through the public runSetup entry with a terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSetup, executeSetupPlan } from '../lib/setup.mjs';

const home = '/home/fixture';
const appArgv = ['--scope', 'all', '--username', 'alex', '--name', 'Alex', '--surname', 'Taylor', '--hostname', 'home', '--disable-fleet-agents-setup'];
const policy = { packages: Object.fromEntries(['sdk', 'cli', 'daemon', 'mcp', 'tg-connector', 'cowork', 'messenger-server', 'codex', 'claude-code', 'fleet'].map(n => [`@ours.network/${n}`, { type: 'npm', version: '1.0.0' }])) };
const instanceId = '12345678-1234-1234-1234-123456789abc';
const installation = (root, extra = {}) => ({ schema: 2, mode: 'docker', root, workDir: `${root}/runtime`, sourcesPath: `${root}/sources.json`, configPath: `${root}/storage/state/daemon/config.json`,
  instanceId, project: 'ours-test', services: ['daemon', 'telegram', 'cowork', 'messenger'], port: 4050, coworkPort: 4052, messengerPort: 9420, uid: 1000, gid: 1000, messengerIdentity: 'Retained Person', ...extra });

function terminal({ roots = {}, saved = null, answers = {}, lines = {}, selections = {} } = {}) {
  const files = new Map(Object.entries(roots).flatMap(([root, record]) => [[`${root}/installation.json`, record], [`${root}/sources.json`, policy]]));
  const asked = [], output = [], events = [];
  const effects = {
    home, env: {}, interactive: true, platform: { platform: 'linux', arch: 'x64', release: '6.8' }, username: () => 'alex',
    out: line => output.push(line),
    list: path => path === home ? Object.keys(roots).map(root => root.slice(home.length + 1)) : [],
    readJson: path => files.get(path) ?? null, readText: () => null,
    readManagedClientProfile: () => saved, packagedSourcePolicy: () => policy,
    detectHarnesses: async () => [{ name: 'codex', status: 'ok' }, { name: 'claude-code', status: 'absent' }],
    select: async (question, choices, fallback) => { asked.push(question); const value = selections[question] ?? fallback; assert(choices.some(c => c.value === value)); return value; },
    multiselect: async (question, _choices, fallback) => { asked.push(question); return fallback; },
    askLine: async (question, fallback) => { asked.push(question); return Object.hasOwn(lines, question) ? lines[question].shift() : fallback; },
    ask: async (question, fallback) => { asked.push(question); return answers[question] ?? fallback; },
    resolveSourcePolicy: async () => { events.push('resolve'); },
    serverLifecycle: async () => ['daemon'],
  };
  return { effects, asked, output, events, transcript: () => output.join('\n') };
}

// Read-only plan of what the App command would do: --dry-run stops before any package, lock or service work.
const plan = async t => {
  const code = await runSetup([...appArgv, '--dry-run'], t.effects);
  return { code, text: t.transcript() };
};

test('fresh App command: one recommended choice installs the complete local setup with Docker and Fleet', async () => {
  const t = terminal();
  const { code, text } = await plan(t);
  assert.equal(code, 0, text);
  assert.deepEqual(t.asked, ['How would you like to continue?'], 'no topology, folder, runtime, profile or confirmation questions');
  assert.match(text, /Install Ours on this computer/);
  assert.match(text, /Scope: all; mode: docker; directory: \/home\/fixture\/\.ours-install/);
  assert.match(text, /Client integrations: codex, fleet/);
  assert.doesNotMatch(text, /alex|Alex|Taylor/, 'valid supplied profile values are used silently');
  assert.deepEqual(t.events, [], 'dry run resolves nothing');
});

test('Customize exposes the existing questions but never topology, and Fleet stays included', async () => {
  const t = terminal({ selections: { 'How would you like to continue?': 'customize', 'How should the server run?': 'podman' } });
  const { code, text } = await plan(t);
  assert.equal(code, 0, text);
  assert.deepEqual(t.asked, ['How would you like to continue?', 'Where should server programs and data be stored?', 'How should the server run?',
    'Which integrations should be configured?', 'Installation settings', 'Continue with this setup?']);
  assert.doesNotMatch(text, /client-only|What would you like to set up/);
  assert.match(text, /Client integrations: codex, fleet/);
});

test('invalid supplied profile values are asked again; valid ones are not', async () => {
  const t = terminal({ lines: { 'Local username: ': ['Not Valid', 'alex2'] } });
  const code = await runSetup(['--scope', 'all', '--username', 'Alex', '--name', 'Alex', '--surname', 'Taylor', '--hostname', 'home', '--disable-fleet-agents-setup', '--dry-run'], t.effects);
  assert.equal(code, 0, t.transcript());
  assert.deepEqual(t.asked, ['How would you like to continue?', 'Local username: ', 'Local username: ']);
  assert.match(t.transcript(), /Not valid: Local username/);
  assert.match(t.transcript(), /Use 1–30 lowercase letters/);
});

test('re-running on the retained default installation updates it with its runtime, ports and apps', async () => {
  const root = `${home}/.ours-install`;
  const containerBinding = { version: 1, uid: 1000, graphRoot: '/podman/graph', runRoot: '/podman/run', socket: '/podman/podman.sock', provider: '/usr/bin/podman-compose', driver: 'overlay', namespaceDigest: 'a'.repeat(64) };
  const t = terminal({ roots: { [root]: installation(root, { containerEngine: 'podman', containerBinding }) },
    saved: { expectedInstanceId: instanceId, endpoint: 'http://127.0.0.1:4050', installer: { integrations: ['claude-code', 'fleet'] } } });
  const { code, text } = await plan(t);
  assert.equal(code, 0, text);
  assert.deepEqual(t.asked, ['How would you like to continue?', 'Update now and keep a recovery backup?']);
  assert.match(text, /Update Ours on this computer/);
  assert.match(text, /\(Podman\)/);
  assert.match(text, /Scope: all; mode: docker; directory: \/home\/fixture\/\.ours-install/);
  assert.match(text, /Client integrations: claude-code, fleet/, 'the apps it already connected are kept');
});

test('re-running on a retained installation in a custom folder reuses that folder instead of creating another root', async () => {
  const root = `${home}/.ours-custom`;
  const t = terminal({ roots: { [root]: installation(root) } });
  const { code, text } = await plan(t);
  assert.equal(code, 0, text);
  assert.deepEqual(t.asked, ['How would you like to continue?', 'Update now and keep a recovery backup?']);
  assert.match(text, /Update Ours/);
  assert.match(text, /directory: \/home\/fixture\/\.ours-custom/);
  assert.match(text, /Client integrations: codex, fleet/);
});

test('declining the update backup consent changes nothing', async () => {
  const root = `${home}/.ours-custom`;
  const t = terminal({ roots: { [root]: installation(root) }, answers: { 'Update now and keep a recovery backup?': false } });
  const { code, text } = await plan(t);
  assert.equal(code, 2);
  assert.match(text, /Update cancelled; nothing was changed/);
  assert.deepEqual(t.events, []);
});

test('several installations, an unreadable one, or a native one are refused before any question or change', async () => {
  const cases = [
    [{ [`${home}/.ours-install`]: installation(`${home}/.ours-install`), [`${home}/.ours-b`]: installation(`${home}/.ours-b`) }, /Several Ours installations.*--state-dir/, []],
    [{ [`${home}/.ours-b`]: { schema: 2, mode: 'nonsense' } }, /could not be read/, []],
    [{ [`${home}/.ours-install`]: installation(`${home}/.ours-install`, { mode: 'packages' }) }, /runs natively/, []],
  ];
  for (const [roots, message, asked] of cases) {
    const t = terminal({ roots });
    const { code, text } = await plan(t);
    assert.equal(code, 2, text);
    assert.match(text, message);
    assert.deepEqual(t.asked, asked);
    assert.deepEqual(t.events, []);
  }
});

test('a client bound to another server is refused before any change', async () => {
  const t = terminal({ saved: { expectedInstanceId: 'ffffffff-1234-1234-1234-123456789abc', endpoint: 'https://elsewhere.invalid/daemon', installer: { integrations: [] } } });
  const { code, text } = await plan(t);
  assert.equal(code, 2);
  assert.match(text, /already has clients attached to a different server/);
  assert.deepEqual(t.events, []);
});

test('the installation summary states the result and the next App step', async () => {
  const t = terminal();
  const done = { scope: 'all', operation: 'install', mode: 'docker', stateDir: `${home}/.ours-install`, integrations: ['codex', 'fleet'], disableFleetAgentsSetup: true, sourcePolicy: policy, interactive: true };
  const root = `${home}/.ours-install`;
  t.effects.readJson = path => path === `${root}/sources.json` ? policy : installation(root);
  t.effects.prepareLocalClient = async () => ({ configPath: `${home}/.ours-client/profile.json` });
  assert.equal(await executeSetupPlan(done, t.effects, { server: async () => 0, client: async () => 0 }), 0);
  const text = t.transcript();
  assert.match(text, /Your installation summary/);
  assert.match(text, /Requested install completed/);
  assert.match(text, /Ours: \/home\/fixture\/\.ours-install, running in Docker/);
  assert.match(text, /Connected: Codex, Fleet/);
  assert.match(text, /Next: return to the Ours App in your browser/);
  assert.doesNotMatch(text, /setup-tunnel/);
});
