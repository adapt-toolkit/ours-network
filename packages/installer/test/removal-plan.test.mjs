// Ownership and ordering rules for complete removal. Pure: nothing is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectForRoot, tombstoneFor, unsafeTreeReason, planRemoval, describePlan, validateJournal, removeTomlTables, parseBuildCache, isOursCacheRecord, within, journalInstallation, ownedContainer, isOursCodexTable,
} from '../lib/removal-plan.mjs';
import { addOwner, ownedImagesRecord } from '../lib/ownership.mjs';

const home = '/home/u';
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const install = (root, instanceId, extra = {}) => ({ root, instanceId, project: 'ours-aaaaaaaaaaaaaaaa', mode: 'docker', candidateProjects: [], record: {}, ...extra });
// A retry-record entry: the project is bound to its root.
const journalItem = (root, instanceId) => ({ root, instanceId, project: projectForRoot(root), mode: 'docker', candidateProjects: [] });
const gen = (id, owners = null, extra = {}) => ({ id, path: `${home}/.ours-client-install/${id}`, owners: owners === null ? { state: 'absent' } : owners === 'invalid' ? { state: 'invalid' } : { state: 'valid', instances: owners }, ...extra });

test('tree guard refuses root, home, its ancestors, links, foreign and shared trees', () => {
  const files = {
    '/home/u/.ours-install': { type: 'dir', uid: 1, mode: 0o700 },
    '/home/u/link': { type: 'symlink', uid: 1, mode: 0o777 },
    '/home/u/shared': { type: 'dir', uid: 1, mode: 0o755 },
    '/home/u/foreign': { type: 'dir', uid: 2, mode: 0o700 },
    '/home/u/via/real': { type: 'dir', uid: 1, mode: 0o700 },
  };
  const io = { home, uid: 1, stat: p => files[p] ?? null, realpath: p => p === '/home/u/via/real' ? '/elsewhere/real' : p };
  assert.equal(unsafeTreeReason('/home/u/.ours-install', io), null);
  for (const path of ['/', '/home', '/home/u', 'relative', '/home/u/../u/.ours-install', '/tmp']) assert.ok(unsafeTreeReason(path, io), path);
  assert.match(unsafeTreeReason('/home/u/link', io), /symbolic link/);
  assert.match(unsafeTreeReason('/home/u/via/real', io), /symbolic link/);
  assert.match(unsafeTreeReason('/home/u/foreign', io), /another user/);
  assert.match(unsafeTreeReason('/home/u/shared', io), /not private/);
  assert.equal(unsafeTreeReason('/home/u/shared', { ...io, privateTree: false }), null);
  assert.equal(unsafeTreeReason('/home/u/absent', io), null, 'an absent path needs no deletion');
});

test('a full removal orders Fleet, app registrations and commands before the downloads they point into', () => {
  const g = gen('aaaaaaaaaaaaaaaa', [A], { fleet: true });
  const found = {
    installations: [install('/home/u/.ours-install', A)], otherInstallations: [], generations: [g],
    client: { root: `${home}/.ours-client`, instanceId: A, integrations: ['claude-code', 'fleet'] },
    claude: { plugin: true, marketplace: { path: `${g.path}/marketplaces/claude-code` }, settingsPath: `${home}/.claude/settings.json`, settingsEntries: [['enabledPlugins', 'ours@ours.network']] },
    codex: null,
    fleet: { installedByOurs: true, bin: `${g.path}/node_modules/.bin/ours-fleet`, configPath: `${home}/fleet.yaml`, configExists: true, stateRoot: `${home}/.ours-fleet`, stateExists: true,
      units: [{ name: 'ours-fleet.service', path: `${home}/.config/systemd/user/ours-fleet.service`, bound: true }, { name: 'ours-fleet-agent@X.service', path: `${home}/.config/systemd/user/ours-fleet-agent@X.service`, bound: false }] },
    npm: { prefix: `${home}/.local`, root: `${home}/.local/lib/node_modules`, bins: [{ name: 'ours', path: `${home}/.local/bin/ours`, target: `${g.path}/node_modules/@ours.network/cli/dist/cli.js`, kind: 'generation' }],
      packages: [{ name: '@ours.network/codex', link: true, target: `${g.path}/node_modules/@ours.network/codex` }, { name: '@ours.network/install', link: false }] },
    clientInstallEmptyAfter: true, removeInstaller: true, otherEngineProjects: [],
  };
  const { steps, kept } = planRemoval(found, { home });
  const ids = steps.map(s => s.id);
  const at = id => ids.indexOf(id);
  assert.ok(at('fleet-down') < at(`generation:${g.id}`));
  assert.ok(at('claude-plugin') < at('claude-marketplace') && at('claude-marketplace') < at(`generation:${g.id}`));
  assert.ok(at(`bin:${home}/.local/bin/ours`) < at(`generation:${g.id}`));
  assert.ok(at('npm:@ours.network/codex') < at(`generation:${g.id}`));
  assert.ok(at('containers:ours-aaaaaaaaaaaaaaaa') < at('root:/home/u/.ours-install'));
  assert.ok(at('build-cache') > at('images:ours-aaaaaaaaaaaaaaaa'));
  assert.equal(steps.at(-1).id, 'installer');
  assert.ok(ids.includes('unit:ours-fleet.service'));
  assert.ok(!ids.includes('unit:ours-fleet-agent@X.service'), 'an unbound Fleet unit is never removed');
  assert.ok(kept.some(k => /ours-fleet-agent@X/.test(k.label)));
  for (const id of [`generation:${g.id}`, 'client']) assert.ok(steps.find(s => s.id === id).after.includes('claude-plugin'));
  const text = describePlan({ steps, kept }).join('\n');
  assert.match(text, /Persistent agents \(Fleet\):/);
  assert.match(text, /Kept \(not created by this installer/);
});

test('a generation used by another installation, or of unknown owner while another remains, is kept', () => {
  const found = {
    installations: [install('/home/u/.ours-install', A)], otherInstallations: [install('/home/u/.ours-other', B)],
    generations: [gen('aaaaaaaaaaaaaaaa', [A, B]), gen('bbbbbbbbbbbbbbbb', null), gen('cccccccccccccccc', [A])],
    client: { root: `${home}/.ours-client`, instanceId: B }, otherEngineProjects: ['ours-bbbbbbbbbbbbbbbb'],
  };
  const { steps, kept } = planRemoval(found, { home });
  const ids = steps.map(s => s.id);
  assert.ok(!ids.includes('generation:aaaaaaaaaaaaaaaa'));
  assert.ok(!ids.includes('generation:bbbbbbbbbbbbbbbb'));
  assert.ok(ids.includes('generation:cccccccccccccccc'));
  assert.ok(!ids.includes('client'), 'the client connection of another installation is kept');
  assert.ok(!ids.includes('build-cache'), 'the shared build cache is kept while another Ours project uses the engine');
  assert.ok(kept.some(k => /Shared Ours build cache/.test(k.label)));
});

test('registrations pointing outside removed downloads are never removed', () => {
  const g = gen('aaaaaaaaaaaaaaaa', [A]);
  const found = {
    installations: [install('/home/u/.ours-install', A)], otherInstallations: [], generations: [g],
    client: { root: `${home}/.ours-client`, instanceId: A },
    claude: { plugin: true, marketplace: { path: '/home/u/my-own-marketplace' }, settingsEntries: [] },
    codex: { plugin: true, marketplace: { path: 'https://github.com/someone/market' }, configTables: [] },
    npm: { bins: [{ name: 'ours', path: '/home/u/.local/bin/ours', target: '/usr/lib/ours/cli.js', kind: 'other' }], packages: [{ name: '@ours.network/fleet', link: true, target: '/home/u/.local/share/ours-fleet-nightly/fleet' }] },
  };
  const { steps, kept } = planRemoval(found, { home });
  for (const id of ['claude-plugin', 'claude-marketplace', 'codex-plugin', 'codex-marketplace', 'bin:/home/u/.local/bin/ours', 'npm:@ours.network/fleet'])
    assert.ok(!steps.some(s => s.id === id), id);
  assert.equal(kept.filter(k => /marketplace|Command|Global package/.test(k.label)).length, 4);
});

test('the retry record accepts only identities, never free-form paths', () => {
  const good = { schema: 1, startedAt: 'x', installations: [journalItem('/home/u/.ours-install', A)], clientInstanceIds: [A], generations: ['aaaaaaaaaaaaaaaa'], fleet: false, legacy: false, installer: true };
  assert.equal(validateJournal(good, { home }), good);
  for (const bad of [
    { ...good, extra: 1 }, { ...good, schema: 2 }, { ...good, generations: ['../../etc'] },
    { ...good, installations: [{ ...good.installations[0], root: 'relative' }] },
    { ...good, installations: [{ ...good.installations[0], project: 'evil' }] },
    // An arbitrary private folder cannot be named: the project must be the one derived from the root.
    { ...good, installations: [{ ...good.installations[0], root: '/synthetic/home/unrelated-private-project', project: 'ours-123' }] },
    { ...good, installations: [{ ...good.installations[0], root: '/synthetic/home/unrelated-private-project' }] },
    { ...good, installations: [{ ...good.installations[0], candidateProjects: ['ours-x'] }] },
    { ...good, clientInstanceIds: ['nope'] }, { ...good, fleet: 'yes' },
  ]) assert.throws(() => validateJournal(bad, { home }), /invalid/);
});

test('journal identity carries the candidate project of an interrupted update', () => {
  const record = { root: '/r', instanceId: A, project: 'ours-aaaaaaaaaaaaaaaa', mode: 'docker', buildTransition: { candidate: { project: 'ours-build' + 'a'.repeat(32) } } };
  assert.deepEqual(journalInstallation(record).candidateProjects, ['ours-build' + 'a'.repeat(32)]);
});

test('TOML table removal keeps every unrelated byte', () => {
  const text = '# mine\nmodel = "gpt-5"\n\n[profiles.mine]\napproval_policy = "never"\n\n[plugins."ours@ours-codex-marketplace"]\nenabled = true\n\n[hooks.state."ours@ours-codex-marketplace:hooks/hooks.json:session_start:0:0"]\ntrusted_hash = "x"\n\n[plugins."other@market"]\nenabled = true\n';
  const match = parts => isOursCodexTable(parts, 'ours@ours-codex-marketplace', 'ours-codex-marketplace');
  const { text: out, removed } = removeTomlTables(text, match);
  assert.equal(removed.length, 2);
  assert.equal(out, '# mine\nmodel = "gpt-5"\n\n[profiles.mine]\napproval_policy = "never"\n\n[plugins."other@market"]\nenabled = true\n');
  assert.deepEqual(removeTomlTables('a = 1\n', match), { text: 'a = 1\n', removed: [] });
});

test('only the installer\'s own cache mount record is selected', () => {
  const records = parseBuildCache([
    'ID:           f2dscz9rayea5rjkpfy0lhuxa', 'Description:  cached mount /root/.npm from exec /bin/sh -c node /build-scripts/build.mjs with id "/ours-dist-2-npm"', 'Size:         41MB', '',
    'ID:           abcdefghijklmnopqrstuvwxy', 'Description:  cached mount /root/.npm from exec /bin/sh -c npm ci with id "/other-tool"', 'Size:         10MB', '',
    'ID:           zzzzzzzzzzzzzzzzzzzzzzzzz', 'Description:  cached mount /cache from exec x with id "/ours-dist-2-npm-not"', '',
  ].join('\n'));
  assert.equal(records.length, 3);
  assert.deepEqual(records.filter(isOursCacheRecord).map(r => r.id), ['f2dscz9rayea5rjkpfy0lhuxa']);
});

test('owner and image records only grow with valid identities', () => {
  const first = addOwner(null, A);
  assert.deepEqual(JSON.parse(first), { schema: 1, instances: [A] });
  assert.equal(addOwner(first, A), null);
  assert.deepEqual(JSON.parse(addOwner(first, B)).instances, [A, B]);
  assert.equal(addOwner(first, 'nope'), null);
  assert.throws(() => addOwner('garbage', B), /damaged/, 'a damaged record is never replaced');
  assert.throws(() => addOwner(JSON.stringify({ schema: 1, instances: ['x'] }), B), /damaged/);
  const images = ownedImagesRecord(null, { 'ours-a:runtime': 'sha256:' + '1'.repeat(64) });
  assert.equal(ownedImagesRecord(images, { 'ours-a:runtime': 'sha256:' + '1'.repeat(64) }), null);
  assert.equal(ownedImagesRecord('{broken', { 'ours-a:runtime': 'sha256:' + '1'.repeat(64) }), null, 'a damaged image record is left as it is');
  assert.equal(ownedImagesRecord(null, { 'busybox:latest': 'sha256:' + '1'.repeat(64), 'ours-a:runtime': 'latest' }), null);
  assert.ok(within('/a/b/c', '/a/b') && within('/a/b', '/a/b') && !within('/a/bc', '/a/b'));
});

test('a rescan plans only engine items that still exist, and unknown ones conservatively', () => {
  const project = 'ours-aaaaaaaaaaaaaaaa';
  const base = { otherInstallations: [], generations: [], otherEngineProjects: [] };
  const gone = { ...install('/home/u/.ours-install', A), record: null, engine: { [project]: { containers: 0, images: {}, volumes: 0, networks: 0 } } };
  assert.deepEqual(planRemoval({ ...base, installations: [gone], buildCache: [] }, { home }).steps, [], 'a finished removal rescans as empty');
  const partial = { ...install('/home/u/.ours-install', A), record: undefined, engine: { [project]: { containers: 0, images: { [`${project}:runtime`]: 'sha256:' + '1'.repeat(64) }, volumes: null, networks: 0 } } };
  const { steps } = planRemoval({ ...base, installations: [partial], buildCache: null }, { home });
  const ids = steps.map(s => s.id);
  assert.deepEqual(ids.sort(), [`images:${project}`, 'build-cache', `volumes:${project}`].sort(), 'without its record the folder itself is never planned');
  assert.deepEqual(steps.find(s => s.id === `images:${project}`).tags, { [`${project}:runtime`]: 'sha256:' + '1'.repeat(64) }, 'only the proven tag is removed');
  assert.ok(!planRemoval({ ...base, installations: [partial], buildCache: [] }, { home }).steps.some(s => s.id === 'build-cache'));
});

test('a container is owned only when Compose ran it from inside this installation, or it is a named helper', () => {
  const project = 'ours-aaaaaaaaaaaaaaaa', root = '/home/u/.ours-install';
  const compose = { Name: '/ours-aaaaaaaaaaaaaaaa-daemon-1', Config: { Image: `${project}:runtime`, Labels: { 'com.docker.compose.project': project, 'com.docker.compose.project.working_dir': `${root}/runtime` } } };
  assert.equal(ownedContainer(compose, { root, project }), true);
  const candidate = { ...compose, Config: { ...compose.Config, Labels: { ...compose.Config.Labels, 'com.docker.compose.project.working_dir': `${root}/.build-x/runtime` } } };
  assert.equal(ownedContainer(candidate, { root, project }), true);
  // `docker create ours-…:runtime` inherits the image's project label but has no project folder.
  const inherited = { Name: '/user-made', Config: { Image: `${project}:runtime`, Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': 'daemon' } } };
  assert.equal(ownedContainer(inherited, { root, project }), false);
  const elsewhere = { ...compose, Config: { ...compose.Config, Labels: { ...compose.Config.Labels, 'com.docker.compose.project.working_dir': '/home/u/.ours-installer-copy/runtime' } } };
  assert.equal(ownedContainer(elsewhere, { root, project }), false);
  assert.equal(ownedContainer({ Name: `/${project}-records`, Config: { Image: `${project}:maintenance`, Labels: {} } }, { root, project }), true);
  assert.equal(ownedContainer({ Name: `/${project}-records`, Config: { Image: 'busybox', Labels: {} } }, { root, project }), false);
});

test('the retry record accepts proven image ids and engine bindings only in their exact forms', () => {
  const bound = journalItem('/home/u/.ours-install', A);
  const item = { ...bound, images: { [`${bound.project}:runtime`]: 'sha256:' + 'a'.repeat(64) } };
  const good = { schema: 1, startedAt: 'x', installations: [item], clientInstanceIds: [], generations: [], fleet: false, legacy: false, installer: false };
  assert.equal(validateJournal(good, { home }), good);
  for (const bad of [
    { ...item, images: { 'busybox:latest': 'sha256:' + 'a'.repeat(64) } }, { ...item, images: { 'ours-aaaaaaaaaaaaaaaa:runtime': 'latest' } },
    { ...item, images: [] }, { ...item, containerBinding: { version: 1 } }, { ...item, product: 'everything' }, { ...item, path: '/etc' },
  ]) assert.throws(() => validateJournal({ ...good, installations: [bad] }, { home }), /invalid/);
});

test('Ours tool records: the whole folder only when every entry is this installation\'s, else only its own rows and sessions', () => {
  const root = '/home/u/.ours-mcp';
  const tool = (extra = {}) => ({ root, configPath: `${root}/config.json`, valid: true, daemons: [], instances: [A], sessions: [A], others: [], ...extra });
  const base = { generations: [], client: { root: `${home}/.ours-client`, instanceId: A }, installations: [install('/home/u/.ours-install', A)], otherInstallations: [] };
  assert.deepEqual(planRemoval({ ...base, toolState: tool() }, { home }).steps.filter(s => s.group === 'apps').map(s => s.id), ['tool-state']);
  const shared = planRemoval({ ...base, toolState: tool({ instances: [A, B], sessions: [A, B] }) }, { home });
  const ids = shared.steps.map(s => s.id);
  assert.ok(!ids.includes('tool-state'));
  assert.ok(ids.includes(`tool-sessions:${A}`) && !ids.includes(`tool-sessions:${B}`));
  assert.deepEqual(shared.steps.find(s => s.id === 'tool-config').instances, [A]);
  assert.ok(shared.kept.some(k => /Other records/.test(k.label)));
  assert.ok(planRemoval({ ...base, toolState: tool({ daemons: ['/home/u/.ours'] }) }, { home }).steps.some(s => s.id === 'tool-config'), 'a legacy daemon row is kept');
  const invalid = planRemoval({ ...base, toolState: tool({ valid: false }) }, { home });
  assert.ok(!invalid.steps.some(s => s.id.startsWith('tool')) && invalid.kept.some(k => /could not be read/.test(k.reason)));
  const orphan = planRemoval({ installations: [], otherInstallations: [], generations: [], toolState: tool() }, { home });
  assert.deepEqual(orphan.steps, [], 'without an installation being removed nothing in it is attributable');
});

test('a generation with a damaged owner record is never removed, even when nothing else remains', () => {
  const found = { installations: [install('/home/u/.ours-install', A)], otherInstallations: [], generations: [gen('aaaaaaaaaaaaaaaa', 'invalid')], client: { root: `${home}/.ours-client`, instanceId: A } };
  const { steps, kept } = planRemoval(found, { home });
  assert.ok(!steps.some(s => s.id.startsWith('generation:')));
  assert.ok(kept.some(k => /owner record .* is damaged/.test(k.reason)));
});

test('TOML removal ignores header-like lines inside strings and arrays, and reads quoted or escaped headers', () => {
  const match = parts => isOursCodexTable(parts, 'ours@ours-codex-marketplace', 'ours-codex-marketplace');
  const user = [
    'note = """',
    '[plugins."ours@ours-codex-marketplace"]',
    'my notes about \\""" quoting',
    '"""',
    "raw = '''",
    '[marketplaces.ours-codex-marketplace]',
    "'''",
    'matrix = [',
    '  ["a"],',
    '  [plugins]',
    ']',
    'inline = { x = "[plugins.\\"ours@ours-codex-marketplace\\"]" } # [x]',
    '',
  ].join('\n');
  const ours = [
    '[ plugins . "ours@ours-codex-marketplace" ]',
    'enabled = true',
    '',
    "[marketplaces.'ours-codex-marketplace']",
    'source = "/x"',
    '',
    '[hooks.state."ours\\u0040ours-codex-marketplace:hooks/hooks.json:session_start:0:0"]',
    'trusted_hash = "x"',
    '',
    '[plugins."other@market"]',
    'enabled = true',
    '',
  ].join('\n');
  const { text, removed } = removeTomlTables(user + ours, match);
  assert.equal(removed.length, 3);
  assert.equal(text, user + '[plugins."other@market"]\nenabled = true\n');
  // Only the multiline string: unchanged, nothing matched.
  assert.deepEqual(removeTomlTables(user, match), { text: user, removed: [] });
  // Text that cannot be scanned safely is never edited.
  for (const broken of ['a = """\nunterminated', 'a = [\n1,', '[plugins."ours@ours-codex-marketplace"\nx=1', 'a = "open\n']) assert.equal(removeTomlTables(broken, match), null, broken);
});

test('installation and connection folders are retired only with their own record, via a tombstone', () => {
  const root = '/home/u/.ours-install';
  const tomb = tombstoneFor(root, A);
  assert.equal(tomb, `/home/u/.ours-install.ours-removing-${A}`);
  const found = { installations: [install(root, A, { tombstone: tomb })], otherInstallations: [], generations: [], client: { root: `${home}/.ours-client`, instanceId: A }, clientTombstones: [tombstoneFor(`${home}/.ours-client`, A)] };
  const { steps } = planRemoval(found, { home });
  const rootStep = steps.find(s => s.id === `root:${root}`);
  assert.deepEqual([rootStep.type, rootStep.recordFile, rootStep.recordField, rootStep.expectInstance, rootStep.tombstone], ['retire', 'installation.json', 'instanceId', A, tomb]);
  assert.equal(steps.find(s => s.id === 'client').type, 'retire');
  assert.ok(steps.some(s => s.id === `tombstone:${tomb}`) && steps.some(s => s.id === `tombstone:${home}/.ours-client.ours-removing-${A}`));
  const retained = planRemoval({ ...found, installations: [install(root, A, { record: null, tombstone: null })], clientTombstones: [] }, { home });
  assert.ok(!retained.steps.some(s => s.id === `root:${root}`), 'a retried root without its record is never deleted');
});
