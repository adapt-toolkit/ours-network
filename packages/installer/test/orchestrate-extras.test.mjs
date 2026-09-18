import { restartHints } from '../lib/extras.mjs';
// ours-install v3 — the four retained extras, as the orchestrator runs them.
//
// lib/extras.mjs proves the PLANS are right. This file proves the orchestrator
// performs them in the right order, with the right environment, and — the part
// that matters most — that it never claims something the arrangement does not
// do. Same rules as the rest of the suite: fake effects only, no socket, no
// filesystem, no subprocess, no terminal, and nothing that could touch a host
// running the live fleet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  runInstall, runHarnessPhase, runFleetPhase, runVoicePhase, runIdentityPhase,
  runPreflight, endScreen, resolveExactSuite, EXIT_OK, EXIT_REFUSED,
} from '../lib/orchestrate.mjs';
import { isWholeDaemonEnv } from '../lib/effects.mjs';
import { fx, said, HOME, OURS, TG } from './fake-effects.mjs';

const ARGS = { dryRun: false, assumeYes: false, channel: 'latest', brokerUrl: 'wss://b' };
const AT_DEFAULT = { stateDir: OURS, port: 3050, action: 'update' };
const AT_TG = { stateDir: TG, port: 3051, action: 'create' };
const ranAsText = (e) => e.recorder.ran.map((c) => c.join(' '));
const envFor = (e, needle) => e.recorder.ranEnv[e.recorder.ran.findIndex((c) => c.join(' ').includes(needle))];

test('release suite resolves one exact version and rejects a partial publication', async () => {
  const stable = fx({ registryVersions: {
    '@ours.network/mcp@latest': '0.17.2',
    '@ours.network/claude-code@latest': '0.17.2',
    '@ours.network/codex@latest': '0.17.2',
  } });
  assert.deepEqual(await resolveExactSuite(ARGS, stable), {
    ok: true,
    channel: 'latest',
    version: '0.17.2',
    packages: { mcp: '0.17.2', 'claude-code': '0.17.2', codex: '0.17.2' },
  });
  const partial = fx({ registryVersions: {
    '@ours.network/mcp@latest': '0.17.2',
    '@ours.network/claude-code@latest': '0.17.2',
    '@ours.network/codex@latest': '0.17.3',
  } });
  assert.match((await resolveExactSuite(ARGS, partial)).reason, /not lockstep/);
});

// ------------------------------------------------------------- the order ----

test('the run walks daemon → components → identity → harness → fleet → voice → summary', async () => {
  // The order is a decision, not an accident: `ours-mcp` is a COMPONENT under
  // v3, and both the identity step and voice invoke it, so neither can run
  // where v2 had them. Pinning the sequence is what stops a later edit from
  // quietly moving one of them back above the phase that installs it.
  const e = fx({
    env: { OURS_ASSUME_YES: '1' },
    harnesses: [{ name: 'claude-code', command: 'claude', label: 'Claude Code', status: 'ok' }],
  });
  assert.equal(await runInstall([], e), EXIT_OK);
  const out = said(e);
  const at = (needle) => out.indexOf(needle);
  assert.ok(at('daemon found') >= 0 || at('creating a daemon here') >= 0, 'the daemon phase ran');
  assert.ok(at('Your human identity') < at('Harness plugins'), 'identity precedes the harness plugins');
  assert.ok(at('Harness plugins') < at('ours-fleet'), 'harness plugins precede ours-fleet');
  assert.ok(at('ours-fleet') < at('Voice messages'), 'ours-fleet precedes voice');
  assert.ok(at('Voice messages') < at('install complete'), 'the summary is last');
  // And the MCP server is installed before anything shells out to `ours-mcp`.
  const ran = ranAsText(e);
  assert.ok(ran.findIndex((s) => s.includes('@ours.network/mcp')) < ran.findIndex((s) => s.includes('create-root')),
    'the MCP server is installed before the identity step invokes it');
});

// ---------------------------------------------------------------------- harnesses ----

test('a harness we cannot drive is never called, and never dead-ends either', async () => {
  const e = fx({
    harnesses: [
      { name: 'claude-code', command: 'claude', label: 'Claude Code', status: 'alias', detail: 'a shell alias, not the real command' },
      { name: 'codex', command: 'codex', label: 'Codex', status: 'absent', detail: 'not installed' },
    ],
  });
  const rows = await runHarnessPhase(ARGS, e, { target: AT_DEFAULT, isDefaultStateDir: true });
  assert.deepEqual(ranAsText(e), [], 'an alias is never invoked');
  assert.match(said(e), /\/plugin marketplace add adapt-toolkit\/ours-claude-marketplace/, 'manual steps are still printed');
  assert.match(said(e), /\/plugin install ours/);
  assert.equal(rows.find((r) => r.key === 'claude-code').state, 'skipped');
  assert.equal(rows.find((r) => r.key === 'codex').state, 'skipped');
});

test('a manual host-profile harness gets a safely quoted native-launch export', async () => {
  const configPath = "/home/me/private/profile with 'quote'.json";
  const e = fx({ harnesses: [{ name: 'claude-code', command: 'claude', label: 'Claude Code', status: 'alias', detail: 'shell alias' }] });
  await runHarnessPhase(ARGS, e, {
    target: { mode: 'host-profile', configPath, profile: {}, endpoint: 'http://127.0.0.1:8787' }, isDefaultStateDir: false,
  });
  assert.match(said(e), /export OURS_CONFIG='\/home\/me\/private\/profile with '\"'\"'quote'\"'\"'\.json'/);
});

test('a drivable harness is installed automatically, in order', async () => {
  const e = fx({
    answers: [true],
    harnesses: [{ name: 'codex', command: 'codex', label: 'Codex', status: 'ok' }],
  });
  const rows = await runHarnessPhase(ARGS, e, { target: AT_DEFAULT, isDefaultStateDir: true });
  assert.deepEqual(ranAsText(e), [
    'codex plugin marketplace add adapt-toolkit/ours-codex-marketplace',
    'codex plugin add ours@ours-codex-marketplace',
    'npm i -g @ours.network/codex@latest',
  ], 'the plugin and the ours-codex launcher, in the Product requirement order');
  assert.equal(rows[0].state, 'installed');
});

test('an exact suite writes local marketplaces and installs exact plugin versions', async () => {
  const e = fx({
    harnesses: [{ name: 'codex', command: 'codex', label: 'Codex', status: 'ok' }],
    codexMarket: { name: 'ours-codex-marketplace', marketplaceSource: { sourceType: 'git', source: 'moving' } },
  });
  const exactSuite = { channel: 'latest', version: '0.17.2', packages: { mcp: '0.17.2', 'claude-code': '0.17.2', codex: '0.17.2' } };
  const rows = await runHarnessPhase(ARGS, e, { target: AT_DEFAULT, isDefaultStateDir: true, exactSuite });
  assert.ok(e.recorder.wrote.some(([path, body]) => path.endsWith('/.agents/plugins/marketplace.json') && body.includes('"version": "0.17.2"')));
  assert.deepEqual(ranAsText(e), [
    'codex plugin marketplace remove ours-codex-marketplace',
    `codex plugin marketplace add ${join(HOME, '.ours/install/marketplaces/codex')}`,
    'codex plugin add ours@ours-codex-marketplace',
    'npm i -g @ours.network/codex@0.17.2',
  ]);
  assert.equal(rows[0].state, 'installed');
});

test('detected safe harnesses are not gated by package-selection questions', async () => {
  const e = fx({ answers: [false], harnesses: [{ name: 'codex', command: 'codex', label: 'Codex', status: 'ok' }] });
  const rows = await runHarnessPhase(ARGS, e, { target: AT_DEFAULT, isDefaultStateDir: true });
  assert.ok(ranAsText(e).some((line) => line.startsWith('codex plugin add')));
  assert.equal(rows[0].state, 'installed');
  assert.deepEqual(e.recorder.asked, []);
});

test('a harness whose install fails still gets its manual path, and the run continues', async () => {
  const e = fx({
    answers: [true],
    runFails: ['plugin marketplace add'],
    harnesses: [{ name: 'claude-code', command: 'claude', label: 'Claude Code', status: 'ok' }],
  });
  const rows = await runHarnessPhase(ARGS, e, { target: AT_DEFAULT, isDefaultStateDir: true });
  assert.equal(rows[0].state, 'failed');
  assert.match(said(e), /can still be installed by hand/);
  assert.match(said(e), /\/plugin install ours/);
});

test('a non-default state directory: Hermes carries the whole pair, Claude and Codex promise nothing', async () => {
  // The load-bearing case: a harness registration should carry OURS_CONFIG so
  // the pair travels together — and for two of the three it
  // CANNOT: Claude's marketplace plugin has no env key and Codex's env_vars is
  // an allowlist of names. So the pair is applied where it is real and printed
  // where it is not, and the screen never claims the guarantee it does not have.
  const e = fx({
    answers: [true, true],
    harnesses: [
      { name: 'claude-code', command: 'claude', label: 'Claude Code', status: 'ok' },
      { name: 'hermes', command: 'hermes', label: 'Hermes', status: 'ok' },
    ],
  });
  await runHarnessPhase(ARGS, e, { target: AT_TG, isDefaultStateDir: false });

  const hermesEnv = envFor(e, 'ours-hermes-install');
  assert.ok(isWholeDaemonEnv(hermesEnv), 'Hermes gets a WHOLE pair or none of one');
  assert.equal(hermesEnv.OURS_CONFIG, join(TG, 'config.json'));
  assert.equal(hermesEnv.OURS_PORT, '3051');
  assert.equal(envFor(e, 'claude plugin install'), null, 'Claude gets no environment, because it cannot carry one');

  const out = said(e);
  assert.match(out, /Claude Code's registration cannot carry a value/, 'says so plainly');
  assert.match(out, new RegExp(`export OURS_CONFIG=${join(TG, 'config.json')}`), 'and gives the exact line');
  assert.doesNotMatch(out, /Hermes.*cannot carry a value/, 'Hermes is not disclaimed — for Hermes the pair is real');
});

test('the DEFAULT state directory prints no env line at all', async () => {
  const e = fx({ answers: [true], harnesses: [{ name: 'hermes', command: 'hermes', label: 'Hermes', status: 'ok' }] });
  await runHarnessPhase(ARGS, e, { target: AT_DEFAULT, isDefaultStateDir: true });
  assert.doesNotMatch(said(e), /OURS_CONFIG/, "today's behaviour, byte for byte");
  assert.equal(envFor(e, 'ours-hermes-install'), null, 'no environment on the default daemon either');
});

// ------------------------------------------------------------- ours-fleet ---

test('ours-fleet publishes its own configuration through the interactive wizard', async () => {
  const text = {};
  const e = fx({ answers: [true], text });
  const interactive = e.runInteractive;
  e.runInteractive = async (...call) => {
    const result = await interactive(...call);
    text[join(HOME, 'fleet.yaml')] = 'version: 2\n';
    return result;
  };
  const row = await runFleetPhase(ARGS, e, { target: AT_DEFAULT, isDefaultStateDir: true });
  assert.deepEqual(ranAsText(e), ['npm i -g @ours.network/fleet@latest', `ours-fleet init --configuration ${join(HOME, 'fleet.yaml')}`]);
  assert.deepEqual(e.recorder.wroteText, [], 'the installer never writes Fleet-owned configuration');
  // Installing a package needs no daemon selection. Initialization may inspect
  // daemon state, so it receives the complete state-directory/endpoint pair;
  // passing both also prevents a non-default install from silently falling back.
  assert.equal(e.recorder.ranEnv[0], null, 'the package install needs no daemon');
  assert.deepEqual(e.recorder.ranEnv[1], {
    OURS_CONFIG: join(OURS, 'config.json'), OURS_STATE_DIR: OURS, OURS_PORT: '3050',
  }, 'init carries the whole pair, never half of one');
  assert.equal(row.state, 'installed');
});

test('prepared-profile Fleet init keeps the profile on the interactive invocation', async () => {
  const profilePath = '/home/me/private/profile.json';
  const text = {};
  const e = fx({ text });
  const interactive = e.runInteractive;
  e.runInteractive = async (...call) => {
    const result = await interactive(...call);
    text[join(HOME, 'fleet.yaml')] = 'version: 2\n';
    return result;
  };
  const row = await runFleetPhase(ARGS, e, {
    target: { mode: 'host-profile', configPath: profilePath, profile: {}, endpoint: 'http://127.0.0.1:8787' },
    isDefaultStateDir: false,
  });
  assert.equal(row.state, 'installed');
  assert.deepEqual(e.recorder.interactive, [['ours-fleet', 'init', '--configuration', join(HOME, 'fleet.yaml')]]);
  assert.deepEqual(e.recorder.ranEnv.at(-1), { OURS_CONFIG: profilePath });
});

test('prepared Fleet settings use the captured runner with settings, profile, and output path', async () => {
  const profilePath = '/home/me/private/profile.json';
  const settingsPath = '/home/me/private/setup/fleet.json';
  const text = {};
  const e = fx({ text });
  const run = e.run;
  e.run = async (...call) => {
    const result = await run(...call);
    text[join(HOME, 'fleet.yaml')] = 'version: 2\n';
    return result;
  };
  const row = await runFleetPhase({ ...ARGS, fleetSettingsPath: settingsPath }, e, {
    target: { mode: 'host-profile', configPath: profilePath, profile: {}, endpoint: 'http://127.0.0.1:8787' },
    isDefaultStateDir: false,
  });
  assert.equal(row.state, 'installed');
  assert.deepEqual(e.recorder.interactive, []);
  assert.deepEqual(e.recorder.ran.at(-1), [
    'ours-fleet', 'init', '--configuration', join(HOME, 'fleet.yaml'), '--settings', settingsPath,
  ]);
  assert.deepEqual(e.recorder.ranEnv.at(-1), { OURS_CONFIG: profilePath });
});

test('a cancelled Fleet wizard publishes nothing and is reported incomplete', async () => {
  const e = fx({ answers: [true] });
  const row = await runFleetPhase(ARGS, e, { target: AT_DEFAULT, isDefaultStateDir: true });
  assert.equal(row.state, 'failed');
  assert.match(row.note, /not published/);
  assert.match(said(e), /configuration was not published/i);
});

test('a cancelled repeat Fleet wizard does not turn an existing manifest into success', async () => {
  const path = join(HOME, 'fleet.yaml');
  const e = fx({ text: { [path]: 'api_version: ours.network/fleet/v2\n' }, interactiveOk: false });
  const row = await runFleetPhase(ARGS, e, { target: AT_DEFAULT, isDefaultStateDir: true });
  assert.equal(row.state, 'failed');
  assert.equal(row.note, 'ours-fleet init failed');
  assert.equal(e.recorder.wroteText.length, 0);
  assert.match(said(e), /retry manually: ours-fleet init/);
  assert.doesNotMatch(said(e), /✓ ours-fleet init .*interactive Fleet configuration/);
});

test('prepared-settings Fleet retry preserves shell-safe profile, output, and settings paths', async () => {
  const profilePath = "/home/me/private/client's profile.json";
  const settingsPath = '/home/me/private/setup path/fleet.json';
  const e = fx({ runFails: ['--settings'] });
  const row = await runFleetPhase({ ...ARGS, fleetSettingsPath: settingsPath }, e, {
    target: { mode: 'host-profile', configPath: profilePath, profile: {}, endpoint: 'http://127.0.0.1:8787' },
    isDefaultStateDir: false,
  });
  assert.equal(row.state, 'failed');
  assert.match(said(e), /retry manually: OURS_CONFIG='\/home\/me\/private\/client'"'"'s profile\.json' ours-fleet init --configuration \/home\/me\/fleet\.yaml --settings '\/home\/me\/private\/setup path\/fleet\.json'/);
});

// ------------------------------------------------------------------ voice ---

test('voice configuration is left to the shared daemon', async () => {
  const e = fx();
  const row = await runVoicePhase(ARGS, e, { target: AT_DEFAULT, mcpReady: true });
  assert.deepEqual(ranAsText(e), []);
  assert.equal(row.state, 'skipped');
  assert.match(said(e), /not managed by ours-mcp/);
});

// --------------------------------------------------------------- identity ---

test('the human identity is created with the daemon pair, after the MCP server exists', async () => {
  const e = fx({ lines: ['Vitalii'] });
  const row = await runIdentityPhase(ARGS, e, { target: AT_TG, mcpReady: true });
  assert.deepEqual(ranAsText(e), ['ours identity create-root --name Vitalii --json']);
  assert.ok(isWholeDaemonEnv(e.recorder.ranEnv[0]));
  assert.equal(e.recorder.ranEnv[0].OURS_CONFIG, join(TG, 'config.json'));
  assert.equal(row.state, 'installed');
});

test('an identity that already exists is a keep, not a failure', async () => {
  const base = fx();
  const e = {
    ...base,
    run: async (cmd, args) => {
      base.recorder.ran.push([cmd, ...args]);
      base.recorder.ranEnv.push(null);
      throw new Error('ours identity create-root: a root identity already exists ("Vitalii")');
    },
  };
  const row = await runIdentityPhase({ ...ARGS, assumeYes: true }, e, { target: AT_DEFAULT, mcpReady: true });
  assert.equal(row.state, 'current');
  assert.equal(row.note, 'existing identity kept');
  assert.match(said(base), /keeping it/);
  assert.doesNotMatch(said(base), /needs attention/);
});

test('an unreachable daemon gives the exact retry command, naming THIS daemon', async () => {
  const e = fx({ runFails: ['create-root'], lines: ['me'] });
  const failing = { ...e, run: async () => { throw new Error('ours identity create-root: daemon not running'); } };
  const row = await runIdentityPhase({ ...ARGS, assumeYes: true }, failing, { target: AT_TG, mcpReady: true });
  assert.equal(row.state, 'failed');
  // The hint NAMES THIS DAEMON. A retry command without the config path starts the
  // DEFAULT daemon, and the operator ends up with an identity on a daemon they did
  // not choose, with no error to tell them.
  assert.match(said(e), new RegExp(`ours daemon start --config ${join(TG, 'config.json')}`));
});

// -------------------------------------------------- the summary + hand-off ---

test('the hand-off drops what this run already did and keeps what it did not', async () => {
  const e = fx();
  const summary = [
    { key: 'core', label: 'ours core (daemon)', state: 'installed' },
    { key: 'identity', label: 'Human identity', state: 'installed' },
    { key: 'fleet', label: 'ours-fleet', state: 'installed' },
    { key: 'tg', label: 'Telegram connector', state: 'skipped' },
  ];
  await endScreen(ARGS, e, { summary, target: AT_DEFAULT, isDefaultStateDir: true, brokerUrl: e.brokerUrl });
  const out = said(e);
  assert.doesNotMatch(out, /Create my Ours human identity/, 'an identity created in-run drops out of the hand-off');
  assert.match(out, /Review the Fleet wizard output in ~\/fleet\.yaml/, 'fleet was installed, so its review step stays');
  assert.doesNotMatch(out, /Set up my Telegram bot/, 'a skipped connector drops its step');
  assert.doesNotMatch(out, /OURS_CONFIG/, 'the default state directory adds nothing to the prompt');
});

test('a non-default state directory tells the agent which daemon it is configuring', async () => {
  const e = fx();
  await endScreen(ARGS, e, {
    summary: [{ key: 'core', label: 'ours core (daemon)', state: 'installed' }, { key: 'fleet', label: 'ours-fleet', state: 'installed' }],
    target: AT_TG,
    isDefaultStateDir: false,
    brokerUrl: e.brokerUrl,
  });
  assert.match(said(e), /set OURS_CONFIG to that path/);
  assert.match(said(e), new RegExp(join(TG, 'config.json').replace(/\//g, '\\/')));
});

test('nothing left to finish shows no empty box', async () => {
  const e = fx();
  await endScreen(ARGS, e, {
    summary: [{ key: 'core', label: 'ours core (daemon)', state: 'installed' }, { key: 'identity', label: 'Human identity', state: 'current' }],
    target: AT_DEFAULT,
    isDefaultStateDir: true,
    brokerUrl: e.brokerUrl,
  });
  assert.doesNotMatch(said(e), /paste this into your agent/);
  assert.match(said(e), /You're all set/);
});

// ---------------------------------------------------- pre-flight and flags ---

test('--help and --version print and do absolutely nothing else', async () => {
  for (const flag of ['--help', '--version', '-h', '-V']) {
    const e = fx();
    assert.equal(await runInstall([flag], e), EXIT_OK, flag);
    assert.deepEqual(e.recorder.ran, [], `${flag} runs nothing`);
    assert.deepEqual(e.recorder.wrote, [], `${flag} writes nothing`);
  }
  const help = fx();
  await runInstall(['--help'], help);
  assert.match(said(help), /--state-dir/, 'help names the flag that identifies a daemon');
  assert.match(said(help), /--dry-run/);
  const version = fx();
  await runInstall(['--version'], version);
  assert.match(said(version), /ours-install v9\.9\.9/);
});

test('an unsupported platform stops before the first mutation', async () => {
  const e = fx({ platform: 'win32' });
  await runInstall([], e);
  assert.deepEqual(e.recorder.ran, [], 'nothing installed on a machine this cannot run on');
  assert.deepEqual(e.recorder.wrote, []);
  assert.match(said(e), /WSL/);
});

test('a Node older than 22 stops before the first mutation', async () => {
  const e = fx({ nodeVersion: '20.19.0' });
  await runInstall([], e);
  assert.deepEqual(e.recorder.ran, []);
  assert.match(said(e), /needs v22 or newer/);
});

test('no harness at all no longer abandons the daemon', async () => {
  // A deliberate divergence from v2, which exited before installing anything.
  // Under v3 the daemon is the product; a harness plugin is one extra of
  // several, and a machine without one still gets a working daemon.
  const e = fx({ env: { OURS_ASSUME_YES: '1' }, harnesses: [] });
  assert.equal(await runInstall([], e), EXIT_OK);
  // The daemon's package is @ours.network/mcp now: it is the only MCP-capable
  // daemon in the stack, and the SDK CLI's daemon does not mount /mcp at all.
  assert.ok(ranAsText(e).some((s) => s.includes('@ours.network/cli')), 'the daemon is still installed');
  assert.match(said(e), /No Claude Code, Codex or Hermes found/);
});

test('the whole extended flow still refuses an incoherent selection before touching anything', () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: { port: 3050 } }, net: { 3050: { ok: true, stateDir: TG } } });
  return runInstall([], e).then((code) => {
    assert.equal(code, EXIT_REFUSED);
    assert.deepEqual(e.recorder.ran, []);
    assert.deepEqual(e.recorder.wrote, []);
  });
});

test('a second daemon alongside the first says whose daemon holds the default port', async () => {
  // Creating the second daemon is allowed, and
  // the operator is told why it did not get the port they might have expected.
  const e = fx({ env: { OURS_ASSUME_YES: '1' }, net: { 3050: { ok: true, stateDir: OURS } }, taken: [3050] });
  assert.equal(await runInstall(['--state-dir', TG], e), EXIT_OK);
  assert.match(said(e), /creating a daemon here/);
  assert.match(said(e), /port 3050 is held by another ours daemon \(state directory .*\.ours\); this one uses/);
  assert.ok(ranAsText(e).some((s) => s.includes('daemon start')), 'and it really is created');
});

test('runPreflight names what it checked, so a supported machine is not silent', () => {
  const e = fx();
  const result = runPreflight(e);
  assert.equal(result.ok, true);
  assert.match(said(e), /Platform: Linux \(supported\)/);
  assert.match(said(e), /Node\.js 22\.0\.0/);
});

test('the extended flow never splits the daemon pair, on any path', async () => {
  const seeds = [
    { env: { OURS_ASSUME_YES: '1' }, harnesses: [{ name: 'hermes', command: 'hermes', label: 'Hermes', status: 'ok' }] },
    { answers: [false, true, true, true], harnesses: [{ name: 'codex', command: 'codex', label: 'Codex', status: 'ok' }] },
  ];
  for (const seed of seeds) {
    for (const argv of [[], ['--state-dir', TG]]) {
      const e = fx(seed);
      await runInstall(argv, e);
      e.recorder.ranEnv.forEach((env, i) => {
        assert.ok(isWholeDaemonEnv(env), `half a daemon pair handed to: ${e.recorder.ran[i].join(' ')}`);
      });
      for (const cmd of e.recorder.ran) {
        assert.ok(!cmd.includes('systemctl') && !cmd.includes('loginctl'), `never: ${cmd.join(' ')}`);
      }
    }
  }
});

// ------------------------------------------------------- restart hints (8.2) --

test('a harness that got a plugin is told to restart, because nothing works until it does', () => {
  // The ours MCP server is spawned BY the harness, once per session. A harness that
  // was already running when its plugin landed has no ours tools, and v3 said
  // nothing at all — so a successful install read as a failed one.
  const hints = restartHints([
    { key: 'mcp', state: 'installed' },
    { key: 'claude-code', state: 'installed' },
    { key: 'hermes', state: 'current' },
    { key: 'codex', state: 'skipped' },
  ]);
  assert.deepEqual(hints.map((h) => h.key), ['claude-code', 'hermes'], 'a skipped harness is not told to restart');
  assert.match(hints[0].action, /restart Claude Code/);
  assert.match(hints[1].action, /\/reload-mcp/);
});

test('no harness plugin this run means no restart advice at all', () => {
  // The MCP server alone changes nothing a running harness can see, so telling
  // someone to restart would be advice with no reason behind it.
  assert.deepEqual(restartHints([{ key: 'mcp', state: 'installed' }, { key: 'fleet', state: 'installed' }]), []);
  assert.deepEqual(restartHints([]), []);
});

test('the connectors are deliberately NOT in the restart list', () => {
  // The installer runs their install-service itself, so their configuration is
  // already applied. Telling someone to restart what was just restarted for them is
  // noise, and noise is what stops the real lines being read.
  const hints = restartHints([{ key: 'tg', state: 'installed' }, { key: 'cowork', state: 'installed' }]);
  assert.deepEqual(hints, []);
});

test('`ours-fleet init` is handed the daemon pair, as insurance against an unresolved contradiction', async () => {
  // nightly-install.mjs:611 says init without the pair points every role at the
  // historical default daemon; extras.mjs:180 says init reads no daemon config at
  // all and resolves per role. Neither is verified — ours-fleet is not in this
  // repo — and passing the pair is harmless if the second is right and
  // load-bearing if the first is.
  const e = fx({ env: { OURS_ASSUME_YES: '1' } });
  await (await import('../lib/orchestrate.mjs')).runFleetPhase(
    { assumeYes: true, dryRun: false, channel: 'latest' },
    e,
    { target: { stateDir: OURS, port: 3050 }, isDefaultStateDir: true },
  );
  const i = e.recorder.ran.findIndex((cmd) => cmd.join(' ').startsWith('ours-fleet init --configuration '));
  assert.ok(i >= 0, 'init ran');
  assert.deepEqual(e.recorder.ranEnv[i], {
    OURS_CONFIG: join(OURS, 'config.json'),
    OURS_STATE_DIR: OURS,
    OURS_PORT: '3050',
  }, 'the WHOLE pair, never half of one');
});

test('the pair reaches init for the DEFAULT state directory too, as nightly does', async () => {
  // The install step is a package and needs no daemon; only init is a host setup
  // that happens beside a specific daemon.
  const e = fx({ env: { OURS_ASSUME_YES: '1' } });
  await (await import('../lib/orchestrate.mjs')).runFleetPhase(
    { assumeYes: true, dryRun: false, channel: 'latest' },
    e,
    { target: { stateDir: TG, port: 3060 }, isDefaultStateDir: false },
  );
  const i = e.recorder.ran.findIndex((cmd) => cmd.join(' ').startsWith('ours-fleet init --configuration '));
  assert.equal(e.recorder.ranEnv[i].OURS_PORT, '3060');
  assert.equal(e.recorder.ranEnv[i].OURS_STATE_DIR, TG);
});
