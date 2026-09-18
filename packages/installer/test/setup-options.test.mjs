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

function interactiveFixture({ existing = null, lines = {}, answers = {} } = {}) {
  const questions = [], output = [];
  const effects = {
    interactive: true, home: '/home/fixture', platform: { platform: 'linux', arch: 'x64', release: '6.8' },
    username: () => 'Taylor', readJson: () => existing,
    detectHarnesses: async () => [{ name: 'codex', status: 'ok' }, { name: 'claude-code', status: 'absent' }],
    out: line => output.push(line),
    askLine: async (question, fallback) => { questions.push([question, fallback]); return Object.hasOwn(lines, question) ? lines[question] : fallback; },
    ask: async (question, fallback) => { questions.push([question, fallback]); return Object.hasOwn(answers, question) ? answers[question] : question === 'Continue with this setup?' ? true : fallback; },
  };
  return { effects, questions, output };
}

test('no-argument interactive collection includes detected integrations, Fleet wizard and confirmation', async () => {
  const f = interactiveFixture(); const options = await collectSetupOptions(f.effects);
  assert.equal(options.scope, 'all'); assert.equal(options.mode, 'packages');
  assert.equal(options.stateDir, '/home/fixture/.ours-install'); assert.equal(options.identityName, 'Taylor');
  assert.equal(options.interactive, true); assert.deepEqual(options.integrations, ['codex', 'fleet']);
  assert.equal(options.fleetSettingsPath, undefined); assert.equal(options.migrate, undefined);
  assert.deepEqual(options.explicitPorts, ['port', 'coworkPort', 'messengerPort']);
  assert.equal(f.questions.at(-1)[0], 'Continue with this setup?');
  assert(f.output.some(line => line.startsWith('Setup:')));
});

test('existing installation defaults to update and retained mode and ports with explicit compatibility consent', async () => {
  const f = interactiveFixture({ existing: { mode: 'docker', port: 4050, coworkPort: 4052, messengerPort: 9420 }, answers: { 'Confirm that the selected update is compatible with retained state?': true } });
  const options = await collectSetupOptions(f.effects);
  assert.equal(options.operation, 'update'); assert.equal(options.mode, 'docker');
  assert.equal(options.port, 4050); assert.equal(options.compatible, true);
});

test('interactive client collection takes a prepared profile and allows no integrations', async () => {
  const f = interactiveFixture({ lines: { 'Set up all, server, or client? ': 'client' }, answers: { 'Install codex?': false, 'Install fleet?': false } });
  const options = await collectSetupOptions(f.effects);
  assert.equal(options.config, '/home/fixture/.ours-client/profile.json'); assert.deepEqual(options.integrations, []);
  assert.equal(options.stateDir, undefined); assert.deepEqual(options.explicitPorts, []);
});

test('interactive setup refuses absent TTY and cancellation without initiating work', async () => {
  await assert.rejects(collectSetupOptions({ interactive: false, askLine: () => { throw new Error('must not prompt'); } }), /TTY/);
  const f = interactiveFixture({ answers: { 'Continue with this setup?': false } });
  await assert.rejects(collectSetupOptions(f.effects), /cancelled/);
});


test('client presets support a non-mutating dry-run', () => {
  assert.equal(parse(['client', '--config=/private/profile', '--integrations=none', '--dry-run']).dryRun, true);
});


test('interactive setup does not silently replace a legacy global installation with a new root', async () => {
  const f = interactiveFixture();
  f.effects.readJson = path => path === '/home/fixture/.ours/config.json' ? { stateDir: '/home/fixture/.ours', port: 3050 } : null;
  await assert.rejects(collectSetupOptions(f.effects), /existing global daemon.*cannot migrate/is);
});
