import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSetupArgs, collectSetupOptions, validateSetupOptions, recommendedMode, defaultHostname } from '../lib/setup-options.mjs';
import { parseNetworkArgs, InstallUsageError } from '../lib/target.mjs';
import { MIGRATE_FROM_UNSUPPORTED, UNSUPPORTED_LAYOUT } from '../lib/plan.mjs';

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

test('platform recommendations select the integrated Docker gateway', () => {
  assert.equal(recommendedMode({ platform: 'linux', arch: 'x64', release: '6.8' }).mode, 'docker');
  for (const platform of [{ platform: 'darwin', arch: 'arm64' }, { platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'arm64' }, { platform: 'linux', arch: 'x64', release: '5.15-microsoft-standard-WSL2' }]) assert.equal(recommendedMode(platform).mode, 'docker');
});

function interactiveFixture({ existing = null, lines = {}, selections = {}, chosenIntegrations, answers = {}, legacy = null, journal = null } = {}) {
  const questions = [], output = [], events = [], reads = [];
  const effects = {
    interactive: true, home: '/home/fixture', platform: { platform: 'linux', arch: 'x64', release: '6.8' },
    username: () => 'Taylor',
    readJson: path => (reads.push(path), path.endsWith('/installation.json') ? existing
      : path.endsWith('/legacy-migration.json') ? journal
      : path.endsWith('/root.json') ? { name: 'Retained Human' }
      : path.endsWith('/config.json') ? legacy : null),
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
    askLine: async (question, fallback) => { questions.push([question, fallback, 'text']); events.push(['text', question]); return Object.hasOwn(lines, question) ? lines[question] : question === 'Name: ' ? 'Taylor' : question === 'Surname: ' ? 'Example' : fallback; },
    ask: async (question, fallback) => {
      assert.equal(events.at(-1)?.[0], 'out', `${question} needs an explanation before confirmation`);
      questions.push([question, fallback, 'confirmation']); events.push(['confirmation', question]);
      return Object.hasOwn(answers, question) ? answers[question] : question === 'Continue with this setup?' ? true : fallback;
    },
  };
  return { effects, questions, output, reads };
}

test('recommended wizard flow uses menus and multiselect, collects local username, human profile and optional host name', async () => {
  const f = interactiveFixture(); const options = await collectSetupOptions(f.effects);
  assert.equal(options.scope, 'all'); assert.equal(options.mode, 'docker');
  assert.equal(options.stateDir, '/home/fixture/.ours-install'); assert.equal(options.identityName, `taylor@${defaultHostname()}`);
  assert.deepEqual(options.integrations, ['codex', 'fleet']); assert.deepEqual(options.explicitPorts, []);
  assert.deepEqual(f.questions.filter(row => row[2] === 'text').map(row => row[0]), ['Local username: ', 'Name: ', 'Surname: ', 'Host / machine name (optional): ']);
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

test('--migrate-from is refused by name as unsupported in every entry point', () => {
  const refused = error => error instanceof InstallUsageError && error.message === MIGRATE_FROM_UNSUPPORTED;
  for (const args of [['all', '--integrations=none', ...server, '--migrate-from=/home/fixture/.ours/config.json', '--compatible'],
    ['server', ...server, '--migrate-from', '/private/old/config.json'], ['client', '--config=/private/profile', '--integrations=none', '--migrate-from=/private/old/config.json']]) {
    assert.throws(() => parse(args), refused);
    assert.throws(() => parseSetupArgs(args, { home: '/home/fixture', validate: false }), refused);
  }
  assert.throws(() => validateSetupOptions({ scope: 'server', mode: 'docker', stateDir: '/private/ours', identityName: 'Taylor', migrateFrom: '/private/old/config.json' }), refused);
  assert.throws(() => parseNetworkArgs(['server', 'install', '--state-dir', '/srv/ours', '--mode', 'docker', '--migrate-from=/private/old/config.json']), refused);
  assert.match(MIGRATE_FROM_UNSUPPORTED, /^--migrate-from is no longer supported.*install fresh into a new folder; existing data was not changed\.$/i);
  assert.equal(parse(['server', ...server, '--migrate']).migrate, true, 'daemon credential migration stays available');
});

test('a leftover ~/.ours is neither offered for migration nor read; setup proceeds as a fresh install', async () => {
  for (const legacy of [{ stateDir: '/private/old' }, {}]) {
    const f = interactiveFixture({ legacy });
    const options = await collectSetupOptions(f.effects);
    assert.equal(options.operation, 'install'); assert.equal(options.migrateFrom, undefined);
    assert.equal(options.identityName, `taylor@${defaultHostname()}`);
    assert(!f.reads.some(path => path.startsWith('/home/fixture/.ours/')), 'old files are not read');
    assert(!f.questions.some(row => /existing ours|brought over|migrat/i.test(row[0])));
    assert(!f.output.some(line => /migrat/i.test(line)));
  }
});

test('a selected folder with an old layout or unfinished import is refused before any question about it', async () => {
  for (const [existing, journal] of [[{ schema: 1, mode: 'packages' }, null], [{ schema: 2, mode: 'docker', layoutConversion: {} }, null],
    [{ schema: 2, mode: 'docker', legacyMigrationSource: '/private/old/config.json' }, { phase: 'copied' }]]) {
    const f = interactiveFixture({ existing, journal });
    await assert.rejects(collectSetupOptions(f.effects), { message: UNSUPPORTED_LAYOUT });
    assert(!f.questions.some(row => row[0] === 'What should happen?'));
  }
  const completed = interactiveFixture({ existing: { schema: 2, mode: 'docker', legacyMigrationSource: '/private/old/config.json' }, journal: { phase: 'complete' }, answers: { 'Proceed with this update and keep a recovery backup?': true } });
  assert.equal((await collectSetupOptions(completed.effects)).operation, 'update', 'a completed import is an ordinary installation');
});

test('permanent partial command presets survive remaining prompts and skip Fleet model questions',async()=>{
 const f=interactiveFixture();
 const presets=parseSetupArgs(['--username','alex','--name','Alex','--surname','Taylor','--disable-fleet-agents-setup'],{home:f.effects.home,validate:false});
 const options=await collectSetupOptions(f.effects,presets);
 assert.equal(options.identityName,`alex@${defaultHostname()}`);assert.equal(options.disableFleetAgentsSetup,true);
 assert.deepEqual([options.name,options.surname],['Alex','Taylor']);
 assert(!f.questions.some(row=>['Local username: ','Name: ','Surname: ','How should Fleet be configured?'].includes(row[0])));
 assert(f.questions.some(row=>row[0]==='How should the server run?'));
});

test('complete permanent presets support unattended Fleet CLI installation without settings',()=>{
 const options=parse(['--mode=docker','--state-dir=/private/ours','--username=alex','--name=Alex','--surname=Taylor','--hostname=work','--integrations=fleet','--disable-fleet-agents-setup']);
 assert.equal(options.identityName,'alex@work');assert.equal(options.fleetSettingsPath,undefined);
 assert.throws(()=>parse(['--mode=docker','--state-dir=/private/ours','--username=alex','--name=Alex','--surname=Taylor','--integrations=fleet']),/--fleet-settings/);
 assert.throws(()=>parse(['--mode=docker','--state-dir=/private/ours','--username=alex','--name=Alex','--surname=Taylor','--integrations=fleet','--disable-fleet-agents-setup','--fleet-settings=/private/settings']),/conflicts/);
});

test('full setup offers only runtimes that can finish; native stays for server-only setup',async()=>{
 const runtimes=f=>f.questions.find(row=>row[0]==='How should the server run?')[3].map(choice=>choice.value);
 const full=interactiveFixture();await collectSetupOptions(full.effects);
 assert.deepEqual(runtimes(full),['docker','podman']);
 const server=interactiveFixture({selections:{'What would you like to set up?':'server'}});await collectSetupOptions(server.effects);
 assert.deepEqual(runtimes(server),['packages','docker','podman']);
 const retainedServer=interactiveFixture({existing:{mode:'packages'},selections:{'What would you like to set up?':'server','What should happen?':'install'}});
 assert.equal((await collectSetupOptions(retainedServer.effects)).mode,'packages');
 const retainedFull=interactiveFixture({existing:{mode:'packages'},selections:{'What should happen?':'install'}});
 await assert.rejects(collectSetupOptions(retainedFull.effects),/runs natively, which supports the server only.*ours-install server.*Nothing was changed/);
 assert(!retainedFull.questions.some(row=>row[0]==='How should the server run?'),'no runtime menu for a combination that cannot finish');
});

test('Podman selection uses the container plan and retained engine',async()=>{
 const f=interactiveFixture({selections:{'How should the server run?':'podman'}});
 const options=await collectSetupOptions(f.effects);assert.equal(options.mode,'docker');assert.equal(options.containerEngine,'podman');
});


test('partial username collects missing profile inputs on a retained installation',async()=>{
 const f=interactiveFixture({existing:{mode:'docker',messengerIdentity:'Different Existing Root'},answers:{'Proceed with this update and keep a recovery backup?':true}});
 const options=await collectSetupOptions(f.effects,{localUsername:'alex',disableFleetAgentsSetup:true});
 assert.equal(options.name,'Taylor');assert.equal(options.surname,'Example');
 assert(f.questions.some(row=>row[0]==='Name: '));assert(f.questions.some(row=>row[0]==='Surname: '));
});

test('permanent profile presets name a fresh installation beside a leftover ~/.ours',async()=>{
 const f=interactiveFixture({legacy:{stateDir:'/private/old'}});
 const options=await collectSetupOptions(f.effects,{localUsername:'alex',name:'Alex',surname:'Taylor',disableFleetAgentsSetup:true});
 assert.equal(options.identityName,`alex@${defaultHostname()}`);assert.equal(options.migrateFrom,undefined);assert.equal(options.name,'Alex');
});


for(const key of ['name','surname'])for(const fresh of [false,true])test(`${key}-only presets collect remaining human fields on ${fresh?'fresh':'retained'} path`,async()=>{
 const f=interactiveFixture({existing:fresh?null:{mode:'docker',messengerIdentity:'Existing Root'},legacy:fresh?{stateDir:'/private/old'}:null,answers:{'Proceed with this update and keep a recovery backup?':true}});
 const options=await collectSetupOptions(f.effects,{[key]:'Supplied',disableFleetAgentsSetup:true});
 assert.equal(options[key],'Supplied');assert.equal(options.localUsername,'Taylor'.toLowerCase());assert(options.name);assert(options.surname);
 if(fresh)assert.equal(options.identityName,`taylor@${defaultHostname()}`);
});
