import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSetupArgs, collectSetupOptions, validateSetupOptions, recommendedMode } from '../lib/setup-options.mjs';

const server = ['--mode', 'native', '--state-dir', '/private/ours', '--identity-name', 'Taylor'];
const parse = argv => parseSetupArgs(argv, { home: '/home/fixture' });

test('CLI all preset normalizes native and requires explicit integration selection', () => {
  const options = parse(['all', 'install', ...server, '--integrations', 'none']);
  assert.equal(options.scope, 'all'); assert.equal(options.operation, 'install');
  assert.equal(options.mode, 'packages'); assert.equal(options.interactive, false);
  assert.deepEqual(options.integrations, []);
  assert.deepEqual([options.port, options.coworkPort, options.messengerPort], [3050, 3052, 8420]);
  assert.deepEqual(options.explicitPorts, []);
});

test('server shortcut and explicit scope/action support fully specified noninteractive options', () => {
  assert.equal(parse(['server', ...server]).operation, 'install');
  const options = parse(['--scope=server', '--action=update', ...server, '--compatible', '--dry-run', '--migrate', '--port=4050']);
  assert.equal(options.operation, 'update'); assert.equal(options.compatible, true);
  assert.equal(options.dryRun, true); assert.equal(options.migrate, true);
  assert.equal(options.port, 4050); assert.deepEqual(options.explicitPorts, ['port']);
});

test('missing CLI answers are listed together without collecting defaults interactively', () => {
  assert.throws(() => parse(['all']), error => ['--mode', '--state-dir', '--identity-name', '--integrations'].every(flag => error.message.includes(flag)));
  assert.throws(() => parse(['server', 'update', ...server]), /--compatible/);
  assert.throws(() => parse(['client', '--integrations=fleet', '--config=/private/profile.json']), /--fleet-settings/);
});

test('client accepts prepared profile, selected integrations and fleet settings paths', () => {
  const options = parse(['client', 'update', '--config=~/profile.json', '--integrations=codex,fleet', '--fleet-settings=~/fleet.json', '--sources=~/sources.json']);
  assert.equal(options.config, '/home/fixture/profile.json'); assert.equal(options.fleetSettingsPath, '/home/fixture/fleet.json');
  assert.equal(options.sources, '/home/fixture/sources.json'); assert.deepEqual(options.integrations, ['codex', 'fleet']);
  assert.equal(options.mode, undefined); assert.deepEqual(options.explicitPorts, []);
});

test('unknown, duplicate, conflicting and malformed CLI values fail closed', () => {
  for (const args of [
    ['server', ...server, '--unknown'], ['server', ...server, '--mode=docker'],
    ['server', ...server, '--scope=server'], ['server', 'install', ...server, '--action=update'],
    ['server', ...server, '--integrations=none'], ['server', ...server, '--config=/private/profile'],
    ['client', '--config=/private/profile', '--integrations=none', '--mode=docker'],
    ['all', ...server, '--integrations=none,codex'], ['all', ...server, '--integrations=codex,codex'],
    ['all', ...server, '--integrations=none', '--fleet-settings=/private/fleet'],
    ['server', ...server, '--port=3052'], ['server', ...server, '--port=65536'],
    ['server', ...server, '--port=3.5'], ['server', ...server, '--migrate=true'],
    ['server', ...server, '--sources'], ['server', ...server, 'unexpected'],
  ]) assert.throws(() => parse(args), args.join(' '));
});

test('validation is pure and distinguishes interactive Fleet wizard from strict CLI settings', () => {
  const input = { scope: 'all', mode: 'native', stateDir: '/private/ours', identityName: ' Taylor ', integrations: ['fleet'] };
  const snapshot = structuredClone(input);
  assert.throws(() => validateSetupOptions(input, { interactive: false }), /--fleet-settings/);
  const result = validateSetupOptions(input, { interactive: true });
  assert.equal(result.identityName, 'Taylor'); assert.equal(result.mode, 'packages');
  assert.deepEqual(input, snapshot); assert.notEqual(result.integrations, input.integrations);
});

test('platform recommendations prefer native Linux x64 and Docker elsewhere', () => {
  assert.equal(recommendedMode({ platform: 'linux', arch: 'x64', release: '6.8' }).mode, 'packages');
  for (const platform of [{ platform: 'darwin', arch: 'arm64' }, { platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'arm64' }, { platform: 'linux', arch: 'x64', release: '5.15-microsoft-standard-WSL2' }]) assert.equal(recommendedMode(platform).mode, 'docker');
});

function interactiveFixture({ existing = null, lines = {}, selections = {}, chosenIntegrations, answers = {}, legacy = null, journal = null } = {}) {
  const questions = [], output = [], events = [];
  const effects = {
    interactive: true, home: '/home/fixture', platform: { platform: 'linux', arch: 'x64', release: '6.8' },
    username: () => 'Taylor',
    readJson: path => path.endsWith('/installation.json') ? existing
      : path.endsWith('/legacy-migration.json') ? journal
      : path.endsWith('/root.json') ? { name: 'Retained Human' }
      : path.endsWith('/config.json') ? legacy : null,
    detectHarnesses: async () => [{ name: 'codex', status: 'ok' }, { name: 'claude-code', status: 'absent' }],
    out: text => { output.push(text); events.push(['out', text]); },
    select: async (question, choices, fallback) => {
      assert.equal(events.at(-1)?.[0], 'out', `${question} needs an explanation before its menu`);
      assert(choices.every(choice => typeof choice.value === 'string' && typeof choice.label === 'string'));
      const value = selections[question] ?? fallback;
      assert(choices.some(choice => choice.value === value));
      questions.push([question, fallback, 'select', choices]); events.push(['select', question]); return value;
    },
    multiselect: async (question, choices, fallback) => {
      assert.equal(events.at(-1)?.[0], 'out');
      questions.push([question, fallback, 'multiselect', choices]); events.push(['multiselect', question]);
      return chosenIntegrations ?? fallback;
    },
    askLine: async (question, fallback) => { questions.push([question, fallback, 'text']); events.push(['text', question]); return Object.hasOwn(lines, question) ? lines[question] : fallback; },
    ask: async (question, fallback) => {
      assert.equal(events.at(-1)?.[0], 'out', `${question} needs an explanation before confirmation`);
      questions.push([question, fallback, 'confirmation']); events.push(['confirmation', question]);
      return Object.hasOwn(answers, question) ? answers[question] : question === 'Continue with this setup?' ? true : fallback;
    },
  };
  return { effects, questions, output };
}

test('recommended wizard flow uses menus and multiselect, with only the Human name entered as text', async () => {
  const f = interactiveFixture(); const options = await collectSetupOptions(f.effects);
  assert.equal(options.scope, 'all'); assert.equal(options.mode, 'packages');
  assert.equal(options.stateDir, '/home/fixture/.ours-install'); assert.equal(options.identityName, 'Taylor');
  assert.deepEqual(options.integrations, ['codex', 'fleet']); assert.deepEqual(options.explicitPorts, []);
  assert.deepEqual(f.questions.filter(row => row[2] === 'text').map(row => row[0]), ['What name should others see? ']);
  assert.equal(f.questions.filter(row => row[2] === 'multiselect').length, 1);
  assert.equal(options.fleetSettingsPath, undefined);
  assert(f.output.some(line => line.includes('Stores the server programs and data')));
  assert.equal(f.questions.at(-1)[0], 'Continue with this setup?');
});

test('scope menu labels explain each finite choice', async () => {
  const f = interactiveFixture(); await collectSetupOptions(f.effects);
  assert.deepEqual(f.questions[0][3].map(choice => choice.label), ['Everything on this computer', 'Server only', 'Connect this computer to an existing server']);
});

test('custom directory and advanced settings alone reveal path and port entry', async () => {
  const f = interactiveFixture({ selections: {
    'Where should server programs and data be stored?': 'custom', 'Installation settings': 'custom',
  }, lines: { 'Folder for server programs and data: ': '~/chosen', 'Daemon port: ': '4050', 'Source policy override file (optional): ': '~/sources.json' } });
  const options = await collectSetupOptions(f.effects);
  assert.equal(options.stateDir, '/home/fixture/chosen'); assert.equal(options.port, 4050);
  assert.equal(options.sources, '/home/fixture/sources.json'); assert.deepEqual(options.explicitPorts, ['port', 'coworkPort', 'messengerPort']);
});

test('existing installation defaults to update with retained mode and ports without override intent', async () => {
  const f = interactiveFixture({ existing: { mode: 'docker', port: 4050, coworkPort: 4052, messengerPort: 9420 }, answers: { 'Proceed with this update and keep a recovery backup?': true } });
  const options = await collectSetupOptions(f.effects);
  assert.equal(options.operation, 'update'); assert.equal(options.mode, 'docker'); assert.equal(options.port, 4050);
  assert.equal(options.compatible, true); assert.deepEqual(options.explicitPorts, []);
});

test('client scope permits an empty multiselection and a chosen profile file', async () => {
  const f = interactiveFixture({ selections: { 'What would you like to set up?': 'client' }, chosenIntegrations: [], lines: { 'Connection profile file: ': '~/remote.json' } });
  const options = await collectSetupOptions(f.effects);
  assert.equal(options.config, '/home/fixture/remote.json'); assert.deepEqual(options.integrations, []);
  assert.equal(options.stateDir, undefined); assert(!f.questions.some(row => row[0].includes('server programs and data')));
});

test('Fleet settings path is requested only after choosing a prepared file', async () => {
  const f = interactiveFixture({ selections: { 'How should Fleet be configured?': 'file' }, lines: { 'Fleet settings file: ': '~/fleet.json' } });
  assert.equal((await collectSetupOptions(f.effects)).fleetSettingsPath, '/home/fixture/fleet.json');
});

test('TTY and confirmation are required before setup proceeds', async () => {
  await assert.rejects(collectSetupOptions({ interactive: false, select: () => { throw new Error('must not prompt'); } }), /TTY/);
  const f = interactiveFixture({ answers: { 'Continue with this setup?': false } });
  await assert.rejects(collectSetupOptions(f.effects), /cancelled/);
});

test('client CLI accepts dry-run without prompting', () => {
  assert.equal(parse(['client', '--config=/private/profile', '--integrations=none', '--dry-run']).dryRun, true);
});

for (const scope of ['all', 'server']) {
  test(`${scope} CLI migration obtains Human name from source rather than requiring a new name`, () => {
    const args = [scope, 'install', '--mode=packages', '--state-dir=/private/new', ...(scope === 'all' ? ['--integrations=none'] : []), '--migrate-from=~/.ours/config.json', '--compatible'];
    const options = parse(args);
    assert.equal(options.migrateFrom, '/home/fixture/.ours/config.json'); assert.equal(options.compatible, true);
    assert.equal(options.identityName, undefined); assert.equal(options.migrate, undefined);
    assert.equal(parse([...args, '--migrate']).migrate, true);
  });
}

test('migration rejects missing compatibility, client/update scope, duplicates, and relative paths', () => {
  assert.throws(() => parse(['server', ...server, '--migrate-from=/private/old/config.json']), /--compatible/);
  assert.throws(() => parse(['client', '--config=/private/profile', '--integrations=none', '--migrate-from=/private/old/config.json', '--compatible']), /requires server or all/);
  assert.throws(() => parse(['server', 'update', ...server, '--migrate-from=/private/old/config.json', '--compatible']), /operation install/);
  assert.throws(() => parse(['server', ...server, '--migrate-from=old/config.json', '--compatible']), /absolute/);
  assert.throws(() => parse(['server', ...server, '--migrate-from=/private/old/config.json', '--migrate-from=/private/another/config.json', '--compatible']), /Duplicate/);
});

const migrationConsent = 'Proceed with this release and keep the original state as a recovery copy?';
test('detected migration retains the stored Human name and explains data preservation instead of requesting a replacement', async () => {
  const f = interactiveFixture({ legacy: { stateDir: '/private/custom-daemon' }, answers: { [migrationConsent]: true } });
  const options = await collectSetupOptions(f.effects);
  assert.equal(options.migrateFrom, '/home/fixture/.ours/config.json'); assert.equal(options.identityName, 'Retained Human');
  assert(!f.questions.some(row => row[0] === 'What name should others see? '));
  assert(f.output.some(line => line.includes('/private/custom-daemon') && line.includes('identities, messages and settings')));
  assert(f.output.some(line => line.includes('compatibility') && line.includes('cannot be guaranteed')));
});

test('migration confirmation stays explicit and declining migration cannot silently create a fresh server', async () => {
  await assert.rejects(collectSetupOptions(interactiveFixture({ legacy: { stateDir: '/private/old' } }).effects), /explicit compatibility/);
  const answers = { 'Upgrade this existing ours installation and keep its data?': false };
  await assert.rejects(collectSetupOptions(interactiveFixture({ legacy: { stateDir: '/private/old' }, answers }).effects), /cancelled/);
  const separate = interactiveFixture({ legacy: { stateDir: '/private/old' }, answers: { ...answers, 'Create a separate fresh installation and keep the existing daemon unchanged?': true } });
  assert.equal((await collectSetupOptions(separate.effects)).migrateFrom, undefined);
});

test('nondefault migration source is entered only after selecting migration', async () => {
  const f = interactiveFixture({ selections: { 'What would you like to set up?': 'server', 'Should existing ours data be brought over?': 'migrate' }, lines: { 'Existing daemon configuration file: ': '~/other/config.json' }, answers: { [migrationConsent]: true } });
  assert.equal((await collectSetupOptions(f.effects)).migrateFrom, '/home/fixture/other/config.json');
});

test('existing managed target refuses unrelated migration but offers a pending transaction resume', async () => {
  const ordinary = interactiveFixture({ existing: { mode: 'packages' }, selections: { 'What should happen?': 'install', 'Should existing ours data be brought over?': 'migrate' }, lines: { 'Existing daemon configuration file: ': '/private/old/config.json' } });
  await assert.rejects(collectSetupOptions(ordinary.effects), /new managed installation root/);
  const pending = interactiveFixture({ existing: { mode: 'packages', legacyMigrationSource: '/private/old/config.json' }, journal: { phase: 'copied' }, answers: { [migrationConsent]: true } });
  const options = await collectSetupOptions(pending.effects);
  assert.equal(options.operation, 'install'); assert.equal(options.migrateFrom, '/private/old/config.json');
  assert(pending.questions.find(row => row[0] === 'What should happen?')[3].some(choice => choice.label === 'Resume the unfinished migration'));
});
