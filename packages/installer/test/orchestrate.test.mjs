// ours-install v3 — the orchestrator.
//
// Every side effect arrives through one injected `effects` object, so this walks
// the WHOLE flow without a socket, a filesystem, a subprocess or a terminal.
// NOTHING here installs, enables or starts a service, and `systemctl` is never
// named by any command this file allows through — asserted, not assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runInstall, runDaemonPhase, runServicePhase, EXIT_OK, EXIT_REFUSED } from '../lib/orchestrate.mjs';
import { CLI_UNIT_MARKER } from '../lib/plan.mjs';
import { isWholeDaemonEnv, DAEMON_ENV_KEYS } from '../lib/effects.mjs';

import { fx, said, HOME, OURS, TG } from './fake-effects.mjs';

const unitPath = (n) => join(HOME, '.config', 'systemd', 'user', n);

const LEGACY_UNIT = '[Unit]\nDescription=ours MCP daemon (secure agent-to-agent messaging over ADAPT)\n[Service]\nExecStart=/usr/bin/node /x/ours-mcp/dist/cli.js serve\n';
const PROFILE_PATH = '/home/me/private/profile.json';
const PROFILE = { endpoint: 'http://127.0.0.1:8787', expectedInstanceId: '6d1e0b1a-cba2-4d33-9389-7d1787ea325f', credentialPath: '/home/me/private/token' };

// ------------------------------------------------------ the safety invariant --

test('NO code path this orchestrator takes ever runs systemctl, or splits the daemon pair', () => {
  // The one rule that outranks every feature here. systemd is reached only
  // through `ours-daemon install-service`, which owns its own refusals.
  //
  // Second host constraint: now that run() can carry
  // an environment, EVERY invocation must carry the whole daemon pair or none of
  // it. A half pair is the quiet failure — the child falls back to ~/.ours and
  // attaches to a daemon the operator did not choose.
  const cases = [
    { json: {}, net: {} },
    { json: { [join(OURS, 'config.json')]: { port: 3050 } }, net: { 3050: { ok: true, stateDir: OURS } } },
    { text: { [unitPath('ours.service')]: LEGACY_UNIT } },
  ];
  return Promise.all(cases.map(async (seed) => {
    const e = fx(seed);
    await runInstall([], e);
    for (const cmd of e.recorder.ran) {
      assert.ok(!cmd.includes('systemctl'), `systemctl must never be run: ${cmd.join(' ')}`);
      assert.ok(!cmd.includes('loginctl'), `loginctl must never be run: ${cmd.join(' ')}`);
    }
    e.recorder.ranEnv.forEach((env, i) => {
      assert.ok(isWholeDaemonEnv(env), `half a daemon pair handed to: ${e.recorder.ran[i].join(' ')}`);
    });
  }));
});

test('a --dry-run mutates NOTHING: no command, no write', async () => {
  const e = fx({ text: { [unitPath('ours.service')]: LEGACY_UNIT } });
  const code = await runInstall(['--dry-run'], e);
  assert.equal(code, EXIT_OK);
  assert.deepEqual(e.recorder.ran, [], 'no subprocess');
  assert.deepEqual(e.recorder.wrote, [], 'no file written');
  assert.match(said(e), /\[dry-run\] would: /, 'and it says what it would have done');
});

test('host-profile install validates first and never starts, stops, configures, or removes a local daemon', async () => {
  const e = fx({
    env: { OURS_CONFIG: PROFILE_PATH, OURS_ASSUME_YES: '1' }, profile: PROFILE,
    text: { [join(HOME, 'fleet.yaml')]: 'api_version: ours.network/fleet/v2\n' },
    harnesses: [
      { name: 'claude-code', command: 'claude', label: 'Claude Code', status: 'ok' },
      { name: 'codex', command: 'codex', label: 'Codex', status: 'ok' },
    ],
  });
  assert.equal(await runInstall([], e), EXIT_OK);
  const commands = e.recorder.ran.map((command) => command.join(' '));
  assert.ok(commands.some((command) => command.includes('@ours.network/mcp@9.9.9')));
  assert.ok(commands.some((command) => command.includes('@ours.network/codex@9.9.9')));
  assert.ok(commands.some((command) => command.includes('@ours.network/fleet')));
  assert.ok(!commands.some((command) => /daemon (start|restart|stop|install-service|uninstall-service)/.test(command)));
  assert.ok(!commands.some((command) => /tg-connector|cowork|create-root/.test(command)));
  assert.ok(!e.recorder.wrote.some(([path]) => path === join(OURS, 'config.json')), 'profile mode writes no local daemon config');
  for (let index = 0; index < commands.length; index += 1) {
    if (/^(claude|codex|ours-fleet)/.test(commands[index])) {
      assert.deepEqual(e.recorder.ranEnv[index], { OURS_CONFIG: PROFILE_PATH }, commands[index]);
    }
  }
  assert.match(said(e), /external daemon.*127\.0\.0\.1:8787/i);
  assert.match(said(e), /Telegram.*Compose-owned/i);
});

test('mismatched host profile refuses before the first mutation', async () => {
  const e = fx({ env: { OURS_CONFIG: PROFILE_PATH }, profile: PROFILE, profileVerificationError: 'instance mismatch' });
  assert.equal(await runInstall([], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, []);
  assert.deepEqual(e.recorder.wrote, []);
  assert.deepEqual(e.recorder.wroteText, []);
  assert.match(said(e), /instance mismatch.*Nothing was changed/i);
});

test('a failed profile client is never announced as complete', async () => {
  const e = fx({ env: { OURS_CONFIG: PROFILE_PATH }, profile: PROFILE, runFails: ['@ours.network/mcp@9.9.9'] });
  assert.equal(await runInstall([], e), EXIT_REFUSED);
  assert.doesNotMatch(said(e), /Client setup .* complete/);
  assert.match(said(e), /client setup.*incomplete/i);
});

// ---------------------------------------------------------------------- refusals --

test('a bad argument exits 2 before anything happens', async () => {
  const e = fx();
  assert.equal(await runInstall(['--nope'], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, []);
  assert.deepEqual(e.recorder.wrote, []);
  assert.match(said(e), /unknown option: --nope/);
});

test('a mismatched release suite exits 2 before any mutation', async () => {
  const e = fx({ registryVersions: {
    '@ours.network/mcp@latest': '0.17.2',
    '@ours.network/claude-code@latest': '0.17.2',
    '@ours.network/codex@latest': '0.17.3',
  } });
  assert.equal(await runInstall([], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, []);
  assert.deepEqual(e.recorder.wrote, []);
  assert.match(said(e), /not lockstep.*Nothing was changed/);
});

test('a foreign daemon on the RECORDED port exits 2 and names the other directory', async () => {
  // On the port this directory's own config named — which is what makes it an
  // incoherent selection rather than just a busy machine.
  const e = fx({ json: { [join(OURS, 'config.json')]: { port: 3050 } }, net: { 3050: { ok: true, stateDir: TG } } });
  assert.equal(await runInstall([], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.wrote, [], 'nothing written');
  assert.deepEqual(e.recorder.ran, [], 'nothing run');
  assert.match(said(e), /owns state directory .*\.ours-tg/);
  assert.match(said(e), /re-run with --port/);
});

test('a --port disagreeing with the running daemon exits 2 and writes nothing', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: { port: 3050 } },
    net: { 3050: { ok: true, stateDir: OURS } },
  });
  assert.equal(await runInstall(['--port', '3999'], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.wrote, []);
  assert.match(said(e), /--port 3999 disagrees with port 3050/);
  assert.match(said(e), /Nothing was written/);
});

// -------------------------------------------------------------------- the daemon ----

test('creating a daemon: the MCP server, the CLI, config, start, then service', async () => {
  const e = fx();
  const r = await runDaemonPhase({ stateDir: TG, port: 3051, portExplicit: true, dryRun: false, brokerUrl: 'wss://b' }, e);
  assert.equal(r.target.action, 'create');
  assert.deepEqual(r.steps.map((s) => s.id), ['mcp-package', 'cli', 'config', 'start', 'service']);
  const [path, body] = e.recorder.wrote[0];
  assert.equal(path, join(TG, 'config.json'));
  const written = JSON.parse(body);
  assert.equal(written.port, 3051);
  assert.equal(written.stateDir, TG);
  assert.ok(!('createdBy' in written), 'no provenance marker: --purge works on any state directory, so it would have no consumer');
  // Order matters: the daemon is started before its boot service is installed.
  const ids = e.recorder.ran.map((c) => c.join(' '));
  assert.ok(ids.findIndex((s) => s.includes('daemon start')) < ids.findIndex((s) => s.includes('install-service')));
});

test('updating an existing daemon restarts it without starting a second one or moving the port', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: { port: 3060, stateDir: OURS, brokerUrl: 'wss://b', apiVisibility: 'shared' } },
    net: { 3060: { ok: true, stateDir: OURS } },
  });
  const r = await runDaemonPhase({ stateDir: OURS, port: null, portExplicit: false, dryRun: false, brokerUrl: 'wss://b' }, e);
  assert.equal(r.target.action, 'update');
  assert.equal(r.target.port, 3060);
  assert.ok(!r.steps.some((s) => s.id === 'start'));
  assert.ok(r.steps.some((s) => s.id === 'restart'));
  const restartIndex = e.recorder.ran.findIndex((cmd) => cmd.includes('restart'));
  assert.ok(restartIndex >= 0);
  assert.equal(e.recorder.runOptions[restartIndex].stream, true, 'startup progress is inherited live');
  assert.deepEqual(e.recorder.wrote, [], 'a config that already matches is not rewritten');
  assert.match(said(e), /already correct — not touched/);
});

test('an existing daemon found only by its PID record is still an update', async () => {
  // The corruption guard, end to end: no recorded port, daemon on 3060.
  const e = fx({
    json: { [join(OURS, 'ours-cli-daemon.json')]: { port: 3060 } },
    net: { 3060: { ok: true, stateDir: OURS } },
  });
  const r = await runDaemonPhase({ stateDir: OURS, port: null, portExplicit: false, dryRun: false, brokerUrl: 'wss://b' }, e);
  assert.equal(r.target.action, 'update', 'a second daemon must not be created on this state directory');
  assert.equal(r.target.port, 3060);
});

// ---------------------------------------------------------------------- the unit ---

test('a legacy ours-mcp unit is adopted silently, with --force and one line', async () => {
  // --force is back with the SDK CLI's install-service, and so is the marker check
  // behind it: the CLI refuses to overwrite a unit it did not write, which restores
  // the second opinion behind classifyUnit that #74 had to give up.
  const e = fx({ text: { [unitPath('ours.service')]: LEGACY_UNIT } });
  const r = await runServicePhase({ dryRun: false }, e, OURS, 3050);
  assert.equal(r.plan.action, 'adopt');
  assert.deepEqual(e.recorder.asked, [], 'no prompt — the operation is intentionally non-interactive');
  const cmd = e.recorder.ran.find((x) => x.includes('install-service'));
  assert.ok(cmd.includes('--force'), 'adoption needs --force, and this is the only place it is passed');
  assert.match(said(e), /replaced .*ours\.service/);
  assert.doesNotMatch(said(e), /lost|delete|erase|wipe|destroy/i, 'no false data-loss wording');
});

test('an unidentifiable unit stops the run and is never forced', async () => {
  const e = fx({ text: { [unitPath('ours.service')]: '[Unit]\nDescription=stranger\n' } });
  assert.equal(await runInstall([], e), EXIT_REFUSED);
  assert.ok(!e.recorder.ran.some((c) => c.includes('--force')), 'never forced over a file we cannot identify');
  // Never prompted about it EITHER: an unidentified unit is a refusal, not a
  // question. (The broker question belongs to the create path and is asked
  // before this; what must not exist is a prompt offering to overwrite.)
  assert.ok(!e.recorder.asked.some((p) => /unit|overwrite|force|service/i.test(p)),
    'and never prompted about it either');
  assert.match(said(e), /Refusing to touch it/);
});

test('a clean install passes no --force at all', async () => {
  const e = fx();
  await runServicePhase({ dryRun: false }, e, OURS, 3050);
  const cmd = e.recorder.ran.find((x) => x.includes('install-service'));
  assert.ok(!cmd.includes('--force'));
});

// -------------------------------------------------------------------- components ----

test('assume-yes installs the complete stack, runs both durable shims, delegates Fleet configuration, and asks nothing', async () => {
  const e = fx({ env: { OURS_ASSUME_YES: '1' }, versions: { '@ours.network/cowork': '0.5.0' } });
  assert.equal(await runInstall([], e), EXIT_OK);
  assert.deepEqual(e.recorder.asked, [], 'a linear run reads no input');
  const ran = e.recorder.ran.map((c) => c.join(' '));
  assert.ok(ran.some((s) => s.includes('@ours.network/mcp')));
  assert.ok(ran.some((s) => s.includes('@ours.network/tg-connector')));
  assert.ok(ran.some((s) => s.includes('@ours.network/cowork')));
  assert.ok(ran.some((s) => s.includes('@ours.network/fleet')));
  assert.ok(ran.some((s) => s.includes('ours-tg-connector install-service')), 'Telegram runs durably');
  assert.ok(ran.some((s) => s.includes('ours-cowork install-service')), 'cowork runs durably');
  assert.ok(!ran.some((s) => s.includes('ours-fleet up')), 'Fleet stays stopped');
  assert.ok(e.recorder.interactive.some((call) => call.join(' ').startsWith('ours-fleet init --configuration ')), 'Fleet owns its wizard');
  assert.equal(e.recorder.wroteText.length, 0, 'the installer does not write Fleet configuration');
});

test('a connector selected by default is never moved without a yes', async () => {
  const path = join(HOME, '.ours-telegram', 'config.json');
  const seed = { json: { [path]: { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS, botToken: 'secret' } } };

  const declined = fx(seed);
  await runInstall(['--state-dir', TG, '--port', '3051'], { ...declined, ask: async (p) => { declined.recorder.asked.push(p); return false; } });
  assert.ok(declined.recorder.asked.some((p) => /Point it at/.test(p)), 'moving an existing connector is the one required confirmation');
  assert.ok(!declined.recorder.wrote.some(([p]) => p === path), 'declining leaves the connector where it is');
});

test('cowork older than the floor is left embedded rather than handed a block', async () => {
  const e = fx({ versions: { '@ours.network/cowork': '0.4.0' } });
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { cowork: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.ok(summary.skipped.includes('cowork'));
  assert.match(said(e), /leaving cowork embedded/);
  assert.ok(!e.recorder.wrote.some(([p]) => p.includes('.ours-cowork')), 'no block written to an older build');
});

test('a component that throws is reported with a retry and the run continues', async () => {
  const e = fx();
  const failing = { ...e, run: async (cmd, a) => {
    e.recorder.ran.push([cmd, ...a]);
    if (a.includes('@ours.network/mcp')) throw new Error('npm exited 1');
    return { ok: true };
  } };
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { mcp: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b' },
    failing,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(summary.failed.map((f) => f.key), ['mcp']);
  assert.equal(summary.continued, true);
  assert.match(said(e), /retry manually: npm i -g @ours\.network\/mcp/);
});

// ------------------------------------------------------------- idempotence ---

test('a second identical run preserves config, refreshes packages, and restarts the daemon', async () => {
  const json = {
    [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS, brokerUrl: 'wss://broker1.ours.network' },
    [join(HOME, '.ours-telegram', 'config.json')]: {
      daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS, brokerUrl: 'wss://broker1.ours.network',
    },
    [join(HOME, '.ours-cowork', 'config.json')]: {
      daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: OURS },
    },
  };
  const e = fx({
    json,
    net: { 3050: { ok: true, stateDir: OURS } },
    text: {
      [unitPath('ours.service')]: `${CLI_UNIT_MARKER}\n[Unit]\n`,
      [join(HOME, 'fleet.yaml')]: 'roles: {}\n',
    },
    versions: { '@ours.network/cowork': '0.5.0' },
    unitUnchanged: true,
  });
  assert.equal(await runInstall([], e), EXIT_OK);
  assert.deepEqual(e.recorder.wrote, [], 'no config rewritten');
  assert.deepEqual(e.recorder.wroteText, [], 'an existing fleet config is preserved');
  assert.match(said(e), /restart the daemon on port 3050/);
});

// ---------------------------------------------------- the real effects layer --

test('legacy effects keep service ownership and never mutate ambient process environment', async () => {
  // The audit this file exists to make possible: every mutation the installer can
  // perform lives in one small module, so "does this touch the machine" is one
  // grep rather than a code review of the whole flow.
  const { readFileSync } = await import('node:fs');
  // Comments are stripped first: the file DISCUSSES systemctl at length, saying
  // it never runs it, and the assertion is about the code rather than the prose.
  const code = readFileSync(new URL('../lib/effects.mjs', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');
  for (const f of ['systemctl', 'loginctl', 'systemd/user']) {
    assert.ok(!code.split('export const INSTALLER_ASSETS')[0].includes(f), `${f} must not appear in the legacy effects layer's code`);
  }
  // Extended for the env parameter: a daemon environment reaches a CHILD and
  // never this process. If the effects layer ever assigned into process.env, a
  // state directory chosen by one run would outlive it and be inherited by
  // everything the operator started from the same shell afterwards.
  assert.ok(!/process\.env\s*\[/.test(code) && !/process\.env\.[A-Za-z_]+\s*=[^=]/.test(code),
    'the effects layer must never write into process.env');
  // And there is exactly ONE constructor for that environment: no code above the
  // pair section names a daemon variable, so "which call sites can emit half a
  // pair" stays answerable by reading one function rather than the whole file.
  const beforeThePair = code.split('DAEMON_ENV_KEYS')[0];
  for (const key of DAEMON_ENV_KEYS) {
    assert.ok(!beforeThePair.includes(key), `${key} must only be named by the pair constructor, not by ${'realEffects'}`);
  }
});

// ----------------------------------------------------------------------- channel --

test('CHANNEL=nightly installs the NIGHTLY component packages, not stable ones beside nightly plugins', async () => {
  // The whole point, asserted on the recorded invocation rather than on a screen
  // line: a nightly run that installs a stable MCP server produces exactly the
  // split-brain deployment the channel exists to prevent, and it looked like
  // success because the plugins and ours-fleet WERE nightly.
  const e = fx({ env: { OURS_CHANNEL: 'nightly', OURS_ASSUME_YES: '1' } });
  await runInstall([], e);
  const installs = e.recorder.ran.filter((c) => c.join(' ').startsWith('npm i -g')).map((c) => c[c.length - 1]);
  assert.ok(
    installs.some((spec) => /^@ours\.network\/mcp@\d+\.\d+\.\d+-nightly\.\d+$/.test(spec)),
    `mcp must be pinned to the resolved nightly suite, got: ${installs.join(', ')}`,
  );
  assert.ok(installs.includes('@ours.network/cli@nightly'));
  assert.ok(installs.includes('@ours.network/daemon@nightly'));
  assert.ok(
    !installs.includes('@ours.network/mcp'),
    'and never the untagged name on a nightly run — that installs @latest',
  );
});

test('an incompatible major is refused before package replacement when purge is declined', async () => {
  const e = fx({
    json: {
      [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' },
      [join(OURS, 'ours-cli-daemon.json')]: { version: 1, owner: '@ours.network/cli', pid: 42, port: 3050, stateDir: OURS },
    },
    net: { 3050: { ok: true, stateDir: OURS, version: '2.9.4' } },
    packageDeps: { '@ours.network/daemon': { '@ours.network/sdk': '^3.0.0' } },
    answers: [false],
  });
  const result = await runDaemonPhase(
    { stateDir: OURS, port: null, portExplicit: false, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'latest' },
    e,
  );
  assert.equal(result.refused.reason, 'incompatible-major-declined');
  assert.deepEqual(e.recorder.ran, [], 'the old CLI and daemon are untouched');
  assert.deepEqual(e.recorder.copied, []);
  assert.match(said(e), /major upgrades are intentionally incompatible/);
  assert.match(said(e), /Nothing was changed/);
});

test('a confirmed incompatible major stops, backs up, purges, and initializes in that order', async () => {
  const e = fx({
    json: {
      [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' },
      [join(OURS, 'ours-cli-daemon.json')]: { version: 1, owner: '@ours.network/cli', pid: 42, port: 3050, stateDir: OURS },
    },
    net: { 3050: { ok: true, stateDir: OURS, version: '2.9.4' } },
    packageDeps: { '@ours.network/daemon': { '@ours.network/sdk': '^3.0.0' } },
    answers: [true],
  });
  const result = await runDaemonPhase(
    { stateDir: OURS, port: null, portExplicit: false, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'latest' },
    e,
  );
  const backup = join(HOME, '.ours-backups', '.ours-before-v3-1');
  assert.equal(result.target.action, 'create');
  assert.equal(result.target.backupPath, backup);
  assert.deepEqual(e.recorder.copied, [[OURS, backup]]);
  assert.deepEqual(e.recorder.removedDirs, [OURS]);
  const commands = e.recorder.ran.map((cmd) => cmd.join(' '));
  const stop = commands.findIndex((cmd) => cmd.includes('daemon stop'));
  const uninstall = commands.findIndex((cmd) => cmd.includes('daemon uninstall-service'));
  const install = commands.findIndex((cmd) => cmd.startsWith('npm i -g'));
  const start = commands.findIndex((cmd) => cmd.includes('daemon start'));
  assert.ok(stop >= 0 && stop < uninstall && uninstall < install && install < start, commands.join('\n'));
  assert.match(said(e), new RegExp(`backup retained at ${backup.replaceAll('.', '\\.')}`));
});

test('a failed incompatible service removal keeps both copies and restarts the old daemon', async () => {
  const e = fx({
    json: {
      [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' },
      [join(OURS, 'ours-cli-daemon.json')]: { version: 1, owner: '@ours.network/cli', pid: 42, port: 3050, stateDir: OURS },
    },
    net: { 3050: { ok: true, stateDir: OURS, version: '2.9.4' } },
    packageDeps: { '@ours.network/daemon': { '@ours.network/sdk': '^3.0.0' } },
    answers: [true],
    runFails: ['uninstall-service'],
  });
  await assert.rejects(
    runDaemonPhase(
      { stateDir: OURS, port: null, portExplicit: false, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'latest' },
      e,
    ),
    /ours exited 1/,
  );
  assert.equal(e.recorder.copied.length, 1, 'the completed backup is retained');
  assert.deepEqual(e.recorder.removedDirs, [], 'the original state was not deleted');
  assert.ok(e.recorder.ran.some((cmd) => cmd.includes('start')), 'the old daemon is recovered');
  assert.match(said(e), /service removal failed, but the old daemon was started again/);
});

test('a nightly run selecting the connector and cowork tags BOTH of them too', async () => {
  const e = fx({
    env: { OURS_CHANNEL: 'nightly' },
    versions: { '@ours.network/cowork': '0.5.0' },
  });
  await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { mcp: true, tg: true, cowork: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'nightly' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  const installs = e.recorder.ran.filter((c) => c.join(' ').startsWith('npm i -g')).map((c) => c[c.length - 1]);
  assert.deepEqual(installs, [
    '@ours.network/mcp@nightly',
    '@ours.network/tg-connector@nightly',
    '@ours.network/cowork@nightly',
  ]);
});

test('the version column and the cowork floor still read the BARE package name', async () => {
  // The trap in the fix rather than in the bug: keying the version lookup by the
  // tagged spec returns null forever, which fails the cowork floor closed and
  // reports "too old" for a build that is new enough.
  const asked = [];
  const base = fx({ env: { OURS_CHANNEL: 'nightly' }, versions: { '@ours.network/cowork': '0.5.0' } });
  const e = { ...base, installedVersion: (pkg) => { asked.push(pkg); return base.installedVersion(pkg); } };
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { cowork: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'nightly' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(asked, ['@ours.network/cowork'], 'no dist-tag in a version lookup');
  assert.ok(summary.installed.includes('cowork'), 'so the floor passes and the block is written');
});

test('a failed component on nightly hands back a NIGHTLY retry command', async () => {
  const e = fx({ env: { OURS_CHANNEL: 'nightly' } });
  const failing = { ...e, run: async (cmd, a) => {
    e.recorder.ran.push([cmd, ...a]);
    if (a.some((x) => String(x).startsWith('@ours.network/mcp'))) throw new Error('npm exited 1');
    return { ok: true };
  } };
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { mcp: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'nightly' },
    failing,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(summary.failed.map((f) => f.retry), ['npm i -g @ours.network/mcp@nightly'],
    'a stable retry command would walk the operator into the split-brain by hand');
});

// ------------------------------------------------- the config journal (L2) ---
//
// v3 could write a config file describing a daemon it then failed to bring up,
// print one warning, and go on to say "install complete". The bytes and the daemon
// they describe are ONE unit of work; these pin that they are treated as one.

test('a daemon that fails to start does not leave a config naming its port', async () => {
  // The failure state that decides this: the next run reads config.json FIRST
  // (target.mjs findDaemon), probes the port nothing listens on, and has only the
  // ours-cli-daemon.json lookup between it and creating a SECOND daemon on this
  // state directory — two writers on one state_data.bin.
  const e = fx({ runFails: ['daemon start'] });
  await assert.rejects(() => runInstall([], e));
  assert.deepEqual(e.recorder.restored.map(([p]) => p), [join(OURS, 'config.json')]);
  assert.match(said(e), /did not reach the state its config describes/);
  assert.match(said(e), /removed .*config\.json — this run created it and did not finish/);
});

test('an existing config is rolled back to its PREVIOUS bytes, not deleted', async () => {
  const before = { port: 3050, stateDir: OURS, brokerUrl: 'wss://old.example', keepThis: true };
  const e = fx({
    json: { [join(OURS, 'config.json')]: before },
    net: { 3050: { ok: true, stateDir: OURS } },
    runFails: ['install-service'],
    env: { OURS_ASSUME_YES: '1' },
  });
  await assert.rejects(() => runInstall([], e));
  const [path, snapshot] = e.recorder.restored[0];
  assert.equal(path, join(OURS, 'config.json'));
  assert.equal(snapshot.exists, true);
  assert.equal(JSON.parse(snapshot.text).keepThis, true, 'the operator keys come back too');
  assert.match(said(e), /rolled back .*config\.json to its previous contents/);
});

test('the rollback states what it could NOT undo', async () => {
  const e = fx({ runFails: ['daemon start'] });
  await assert.rejects(() => runInstall([], e));
  assert.match(said(e), /completed package installs were not rolled back/,
    'the CLI package install always ran by this point; saying so is the honest boundary');
});

test('a REFUSAL after the config write rolls it back too', async () => {
  // An unknown unit file stops the run exactly as a failed start does, and it
  // stops it with config.json already rewritten. Same rollback, same report.
  const e = fx({ text: { [unitPath('ours.service')]: '[Unit]\nDescription=somebody elses thing\n' } });
  const code = await runInstall([], e);
  assert.equal(code, EXIT_REFUSED);
  assert.deepEqual(e.recorder.restored.map(([p]) => p), [join(OURS, 'config.json')]);
});

test('a failed rollback is REPORTED, never swallowed and never thrown over the real error', async () => {
  const e = fx({ runFails: ['daemon start'], restoreFails: [join(OURS, 'config.json')] });
  // The original failure must be what propagates: losing it to a second error
  // raised by the recovery would hide the thing that actually went wrong.
  await assert.rejects(() => runInstall([], e), /ours-daemon exited 1/, 'the original failure survives');
  assert.match(said(e), /could NOT roll back .*config\.json: permission denied/);
});

// ---------------------------------------------- the restore is read back --
// A rollback that LIES is worse than one that admits it failed: the operator is
// told the machine is back where it was, stops looking, and the next run reads a
// config naming a port nothing listens on. `restore` returning proves a call
// completed; only reading the bytes back proves the file holds them.

test('a restore that silently did not take is reported as NOT restored', async () => {
  const before = { port: 3050, stateDir: OURS, keepThis: true };
  const e = fx({
    json: { [join(OURS, 'config.json')]: before },
    net: { 3050: { ok: true, stateDir: OURS } },
    runFails: ['install-service'],
    env: { OURS_ASSUME_YES: '1' },
    restoreDoesNotTake: [join(OURS, 'config.json')],
  });
  await assert.rejects(() => runInstall([], e));
  assert.match(said(e), /could NOT roll back .*config\.json: the restore reported success but the bytes on disk are not the previous ones/);
  assert.ok(!/rolled back .*config\.json to its previous contents/.test(said(e)),
    'and it must NOT also be announced as restored — one file, one truthful line');
});

test('a file this run created whose removal did not take is reported, not called removed', async () => {
  const e = fx({ runFails: ['daemon start'], restoreDoesNotTake: [join(OURS, 'config.json')] });
  await assert.rejects(() => runInstall([], e));
  assert.match(said(e), /could NOT roll back .*config\.json: this run created it and the removal did not take — the file is still there/);
  assert.ok(!/removed .*config\.json/.test(said(e)), 'never claims a removal that did not happen');
});

test('bytes back but permissions drifted is reported as restored-with-a-caveat, naming both modes', async () => {
  const before = { port: 3050, stateDir: OURS, keepThis: true };
  const e = fx({
    json: { [join(OURS, 'config.json')]: before },
    net: { 3050: { ok: true, stateDir: OURS } },
    runFails: ['install-service'],
    env: { OURS_ASSUME_YES: '1' },
    restoreChangesMode: [join(OURS, 'config.json')],
  });
  await assert.rejects(() => runInstall([], e));
  // The contents ARE back, so this must not read as "your config is lost".
  assert.match(said(e), /contents restored, but the permissions are 0644 and were 0600/);
});

test('a read-back that itself fails counts as not restored, never as success', async () => {
  const e = fx({ runFails: ['daemon start'] });
  const realSnapshot = e.snapshot;
  let restoreDone = false;
  e.restore = (p, snap) => { restoreDone = true; e.recorder.restored.push([p, snap]); };
  e.snapshot = (p) => { if (restoreDone) throw new Error('EIO'); return realSnapshot(p); };
  await assert.rejects(() => runInstall([], e));
  assert.match(said(e), /could NOT roll back .*config\.json: restored, but the file could not be read back to confirm it \(EIO\)/);
});

test('a --dry-run snapshots nothing, because it wrote nothing', async () => {
  const e = fx({ runFails: ['daemon start'] });
  const code = await runInstall(['--dry-run'], e);
  assert.equal(code, EXIT_OK, 'a dry run never reaches a real failure');
  assert.deepEqual(e.recorder.restored, []);
  assert.ok(!said(e).includes('rolled back'), 'and says nothing about rolling back');
});

test('Telegram config and durable service are one rollback-scoped operation', async () => {
  const e = fx({
    json: { [join(HOME, '.ours-telegram', 'config.json')]: { botToken: 'secret', daemonUrl: 'http://127.0.0.1:9999', daemonStateDir: '/elsewhere' } },
    runFails: ['ours-tg-connector install-service'],
    answers: [true],
  });
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { tg: true, cowork: false }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'latest' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.ok(summary.failed.some((failure) => failure.key === 'tg'));
  assert.ok(e.recorder.wrote.some(([p]) => p === join(HOME, '.ours-telegram', 'config.json')));
  assert.ok(e.recorder.ran.some((cmd) => cmd.join(' ').includes('ours-tg-connector install-service')));
  assert.deepEqual(e.recorder.restored.map(([path]) => path), [join(HOME, '.ours-telegram', 'config.json')]);
});

test('a component rollback NEVER touches the daemon that came up correctly', async () => {
  // The whole reason the journal is scoped per unit of work rather than per run:
  // nightly's run-wide journal, copied here, would undo the daemon's own config
  // because a connector failed.
  const e = fx({ runFails: ['ours-cowork install-service'], versions: { '@ours.network/cowork': '0.5.0' } });
  await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { cowork: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'latest' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(
    e.recorder.restored.map(([p]) => p),
    [join(HOME, '.ours-cowork', 'config.json')],
    'only cowork\'s own config — never the daemon config.json',
  );
  assert.match(said(e), /leaves cowork embedded as it was/);
});

test('a config that did not change is not snapshotted, so nothing is "rolled back"', async () => {
  // Restoring a file this run never wrote would be a change dressed as a recovery.
  const already = { daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: OURS } };
  const e = fx({
    json: { [join(HOME, '.ours-cowork', 'config.json')]: already },
    runFails: ['ours-cowork install-service'],
    versions: { '@ours.network/cowork': '0.5.0' },
  });
  await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { cowork: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'latest' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(e.recorder.restored, [], 'the file was already correct and was never touched');
});

test('the replaced legacy unit is NAMED in the rollback, because it cannot be restored', async () => {
  // Writing unit bytes back into ~/.config/systemd/user would break the invariant
  // that systemd is reached only through `ours-daemon install-service`, and without
  // a daemon-reload it would not even mean anything. So it is reported, not fixed.
  const e = fx({
    text: { [unitPath('ours.service')]: LEGACY_UNIT },
    runFails: ['install-service'],
  });
  await assert.rejects(() => runInstall([], e));
  assert.match(said(e), /is NOT restored — the older ours-mcp unit is gone/);
  assert.match(said(e), /state directory .* is untouched|state directory is untouched/);
  assert.deepEqual(e.recorder.restored.map(([p]) => p), [join(OURS, 'config.json')],
    'the config still goes back; only the unit does not');
});

test('the end screen tells a running harness it must restart before any of this works', async () => {
  // THE REPRODUCTION for the restart hints: v3 printed "Everything installed
  // cleanly" and nothing else, so a user went back to an already-open Claude Code,
  // found no ours tools, and read a successful install as a failed one.
  const e = fx({
    env: { OURS_ASSUME_YES: '1' },
    harnesses: [{ name: 'claude-code', status: 'ok', label: 'Claude Code' }],
  });
  await runInstall([], e);
  const screen = said(e);
  assert.match(screen, /restart Claude Code/);
  assert.match(screen, /already open has not picked it up yet/);
  assert.ok(
    screen.indexOf('restart Claude Code') < screen.indexOf('ONE LAST STEP')
      || !screen.includes('ONE LAST STEP'),
    'said before the hand-off prompt: it is the only thing here the operator must do himself',
  );
});

// ------------------------------------------------- the selection screen (C1) --

const SECOND_DIR = join(HOME, '.ours-work');

test('several daemons are SHOWN and the operator picks — never asked to type a path', async () => {
  const e = fx({
    known: [OURS, SECOND_DIR],
    json: {
      [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS },
      [join(SECOND_DIR, 'config.json')]: { port: 3060, stateDir: SECOND_DIR },
    },
    net: { 3060: { ok: true, stateDir: SECOND_DIR } },
    lines: ['2'],
  });
  await runInstall([], e);
  const screen = said(e);
  assert.match(screen, /Which ours daemon is this for\?/);
  assert.match(screen, /1\) .*\.ours\b/);
  assert.match(screen, /2\) .*\.ours-work/);
  assert.match(screen, /3\) create a new one at .*\.ours-2/);
  assert.match(screen, /using the ours daemon at .*\.ours-work/);
  assert.ok(
    e.recorder.askedLines.every((p) => !/state directory|path/i.test(p)),
    'the prompt asks for a NUMBER and never asks for a path',
  );
});

test('the Telegram connector is never offered as a daemon to install into', async () => {
  // ~/.ours-telegram matches a ~/.ours* scan and has a config.json. Offering it
  // would let the operator pick it and have a daemon created inside the
  // connector's own directory.
  const TG_DIR = join(HOME, '.ours-telegram');
  const e = fx({
    known: [OURS, TG_DIR],
    json: {
      [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS },
      [join(TG_DIR, 'config.json')]: { botToken: 's', daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS },
    },
    net: { 3050: { ok: true, stateDir: OURS } },
  });
  await runInstall([], e);
  assert.doesNotMatch(said(e), /Which ours daemon is this for\?/, 'one daemon, so no screen');
  assert.doesNotMatch(said(e), /using the ours daemon at .*\.ours-telegram/, 'the connector directory is never selected as the daemon');
  assert.match(said(e), /the only one found/);
});

test('exactly one daemon: no question, but the run SAYS which one', async () => {
  const e = fx({
    known: [OURS],
    json: { [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS } },
    net: { 3050: { ok: true, stateDir: OURS } },
  });
  await runInstall([], e);
  assert.deepEqual(e.recorder.askedLines.filter((p) => /Choose/.test(p)), [], 'no choice offered');
  assert.match(said(e), /using the ours daemon at .*\.ours \(port 3050\) — the only one found/);
});

test('--state-dir outranks everything detected: no screen at all', async () => {
  const e = fx({
    known: [OURS, SECOND_DIR],
    json: {
      [join(OURS, 'config.json')]: { port: 3050 },
      [join(SECOND_DIR, 'config.json')]: { port: 3060 },
    },
  });
  await runInstall(['--state-dir', TG], e);
  assert.doesNotMatch(said(e), /Which ours daemon is this for\?/);
  assert.match(said(e), new RegExp(`target ${TG}`));
});

test('a non-interactive run never sees the screen, whatever is on the machine', async () => {
  const e = fx({
    env: { OURS_ASSUME_YES: '1' },
    known: [OURS, SECOND_DIR],
    json: { [join(OURS, 'config.json')]: { port: 3050 }, [join(SECOND_DIR, 'config.json')]: { port: 3060 } },
  });
  await runInstall([], e);
  assert.doesNotMatch(said(e), /Which ours daemon is this for\?/);
  assert.deepEqual(e.recorder.askedLines, [], 'nothing asked at all');
});

test('an answer that is not on the list REFUSES and changes nothing', async () => {
  const e = fx({
    known: [OURS, SECOND_DIR],
    json: { [join(OURS, 'config.json')]: { port: 3050 }, [join(SECOND_DIR, 'config.json')]: { port: 3060 } },
    lines: ['/etc/passwd'],
  });
  assert.equal(await runInstall([], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, [], 'nothing installed');
  assert.deepEqual(e.recorder.wrote, [], 'nothing written');
  assert.match(said(e), /not one of the numbers offered/);
});

test('picking "create a new one" targets the DERIVED directory, not the default', async () => {
  const e = fx({
    known: [OURS, SECOND_DIR],
    json: { [join(OURS, 'config.json')]: { port: 3050 }, [join(SECOND_DIR, 'config.json')]: { port: 3060 } },
    lines: ['3'],
  });
  await runInstall([], e);
  assert.match(said(e), /creating a new daemon at .*\.ours-2/);
  assert.ok(e.recorder.wrote.some(([p]) => p === join(HOME, '.ours-2', 'config.json')));
});

// ------------------------------------------ daemon recovery after a failed unit --

test('a failed install-service does not leave the daemon down without trying to bring it back', async () => {
  // install-service can STOP a running daemon before it fails: it installs a unit
  // that will own the process. v3 just ended the run there, so a person who typed
  // ours-install and got an error was also, silently, left without the daemon they
  // had before.
  const e = fx({
    json: { [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' } },
    net: { 3050: { ok: true, stateDir: OURS } },
    runFails: ['install-service'],
    env: { OURS_ASSUME_YES: '1' },
  });
  await assert.rejects(() => runInstall([], e));
  const started = e.recorder.ran.filter((c) => c.join(' ').includes('daemon start'));
  assert.equal(started.length, 1, 'exactly one recovery attempt');
  assert.deepEqual(started[0], ['ours-daemon', 'start', '--config', join(OURS, 'config.json')]);
  assert.match(said(e), /your daemon is running again/);
});

test('the two outcomes are told apart, because only one of them needs a human now', async () => {
  // "The service failed but the daemon is back" is a bad evening. "The service
  // failed AND it will not come back" is the one that needs someone tonight.
  const e = fx({
    json: { [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' } },
    net: { 3050: { ok: true, stateDir: OURS } },
    runFails: ['install-service', 'daemon start'],
    env: { OURS_ASSUME_YES: '1' },
  });
  await assert.rejects(() => runInstall([], e));
  assert.match(said(e), /the daemon did NOT come back up/);
  assert.match(said(e), /ours-daemon start --config .*config\.json/, 'and the exact command to fix it');
});

test('a daemon that never started is not "recovered" — there is nothing to recover', async () => {
  // Running start after a failed start would fail again and stack a second, less
  // useful error on top of the first.
  const e = fx({ runFails: ['daemon start'], env: { OURS_ASSUME_YES: '1' } });
  await assert.rejects(() => runInstall([], e));
  const starts = e.recorder.ran.filter((c) => c.join(' ').includes('daemon start'));
  assert.equal(starts.length, 1, 'the original attempt only — no retry');
  assert.doesNotMatch(said(e), /running again|did NOT come back up/);
});

test('a dry run recovers nothing, because it stopped nothing', async () => {
  const e = fx({ runFails: ['install-service'], env: { OURS_ASSUME_YES: '1' } });
  await runInstall(['--dry-run'], e);
  assert.deepEqual(e.recorder.ran, [], 'a dry run performs nothing at all');
});

// ------------------------------ macOS now gets a REAL boot service ----------
//
// The skip that used to live here is gone: the installer now delegates to the
// CLI's install-service, which handles systemd AND launchd.
// Whether launchctl accepts the agent is still unproven — nothing here is macOS —
// but it is now real code rather than a documented refusal.

test('on macOS the installer requests the CLI-managed daemon LaunchAgent before durable shims', async () => {
  const e = fx({
    platform: 'darwin',
    env: { OURS_ASSUME_YES: '1' },
    versions: { '@ours.network/cowork': '0.5.0' },
    text: { [join(HOME, 'fleet.yaml')]: 'api_version: ours.network/fleet/v2\n' },
  });
  assert.equal(await runInstall([], e), EXIT_OK);
  const service = e.recorder.ran.find((c) => c.join(' ').includes('daemon install-service'));
  assert.deepEqual(service, [
    'ours-daemon', 'install-service', '--yes', '--json', '--state-dir', OURS,
    '--config', join(OURS, 'config.json'),
  ], 'the CLI dispatches this exact request to its launchd adapter');
  assert.ok(!service.includes('--force'), 'Darwin never enters Linux legacy-unit adoption');
  const commands = e.recorder.ran.map((c) => c.join(' '));
  const start = commands.findIndex((c) => c.includes('daemon start'));
  const daemonService = commands.findIndex((c) => c.includes('daemon install-service'));
  const telegramService = commands.findIndex((c) => c.includes('ours-tg-connector install-service'));
  assert.ok(start < daemonService && daemonService < telegramService, 'daemon starts, gains persistence, then shims install');
  assert.ok(
    e.recorder.ran.some((c) => c.join(' ').includes('ours-tg-connector install-service')),
    'the Telegram shim is installed as a durable service',
  );
  assert.ok(
    e.recorder.ran.some((c) => c.join(' ').includes('ours-cowork install-service')),
    'the cowork shim is installed as a durable service',
  );
  assert.doesNotMatch(said(e), /not available on macOS|needs attention/);
  assert.match(said(e), /solutions\.adaptframework\.ours installed and enabled/);
});

test('a macOS LaunchAgent re-run uses CLI JSON to report unchanged and never forces', async () => {
  const e = fx({ platform: 'darwin', unitUnchanged: true });
  const result = await runServicePhase({ dryRun: false }, e, OURS, 3050);
  assert.equal(result.step.changed, false);
  assert.equal(result.step.reason, 'unit unchanged');
  assert.equal(result.plan.unit, 'solutions.adaptframework.ours');
  const service = e.recorder.ran.find((c) => c.includes('install-service'));
  assert.ok(service.includes('--json'));
  assert.ok(!service.includes('--force'));
});

test('a failed macOS LaunchAgent install reports the failure and attempts daemon recovery', async () => {
  const e = fx({
    platform: 'darwin',
    json: { [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' } },
    net: { 3050: { ok: true, stateDir: OURS } },
    runFails: ['install-service'],
    env: { OURS_ASSUME_YES: '1' },
  });
  await assert.rejects(() => runInstall([], e), /ours-daemon exited 1/);
  assert.ok(e.recorder.ran.some((c) => c.join(' ').includes('daemon install-service')));
  assert.deepEqual(
    e.recorder.ran.filter((c) => c.join(' ').includes('daemon start')),
    [['ours-daemon', 'start', '--config', join(OURS, 'config.json')]],
    'one recovery attempt after the launchd adapter failure',
  );
  assert.match(said(e), /your daemon is running again/);
});

test('Linux is completely unaffected — same walk, same service install', async () => {
  const e = fx({ env: { OURS_ASSUME_YES: '1' } });
  await runInstall([], e);
  assert.ok(e.recorder.ran.some((c) => c.join(' ').includes('daemon install-service')));
  assert.doesNotMatch(said(e), /not available on/);
});

// ------------------------------------------- the channel signal of last resort --

test('a NIGHTLY installer with NO env var installs nightly, not latest', async () => {
  // THE DEFECT THIS PINS, and the reason every other channel test missed it: they
  // all set OURS_CHANNEL. resolveChannel only falls back to the installer's own
  // version when the environment is silent, and the v3 orchestrator passed no
  // version at all — so the one case nobody tested, a published nightly installer
  // run with no env, resolved to `latest` and installed the whole stack stable.
  const e = fx({ env: { OURS_ASSUME_YES: '1' }, harnesses: [{ name: 'codex', status: 'ok', label: 'Codex' }] });
  e.version = '0.17.0-nightly.7';
  await runInstall([], e);
  const installs = e.recorder.ran.filter((c) => c.join(' ').startsWith('npm i -g')).map((c) => c[c.length - 1]);
  assert.ok(installs.length > 0, 'something was installed');
  for (const spec of installs) {
    // @ours.network/cli is exempt and must stay exempt: it publishes only `latest`,
    // so pinning it to a nightly tag would 404. Suite-managed packages are resolved
    // to one exact nightly version; other packages continue to use the nightly tag.
    if (spec === '@ours.network/cli') continue;
    if (spec.startsWith('@ours.network/mcp@') || spec.startsWith('@ours.network/codex@')) {
      assert.match(spec, /@\d+\.\d+\.\d+-nightly\.\d+$/, `suite package must use an exact nightly, got ${spec}`);
    } else {
      assert.match(spec, /@nightly$/, `every other package with a nightly tag must use it, got ${spec}`);
    }
  }
});

test('a STABLE installer with no env var still installs latest', async () => {
  const e = fx({ env: { OURS_ASSUME_YES: '1' }, harnesses: [{ name: 'codex', status: 'ok', label: 'Codex' }] });
  e.version = '0.16.0';
  await runInstall([], e);
  const installs = e.recorder.ran.filter((c) => c.join(' ').startsWith('npm i -g')).map((c) => c[c.length - 1]);
  for (const spec of installs) {
    assert.doesNotMatch(spec, /@nightly$/, `a stable installer must never install a nightly, got ${spec}`);
  }
});

test('an explicit env var still outranks the installer version, both ways', async () => {
  const pinned = fx({ env: { OURS_ASSUME_YES: '1', OURS_CHANNEL: 'latest' } });
  pinned.version = '0.17.0-nightly.7';
  await runInstall([], pinned);
  assert.ok(!pinned.recorder.ran.some((c) => c.join(' ').includes('@nightly')), 'a nightly installer can be pinned to stable');

  const optedIn = fx({ env: { OURS_ASSUME_YES: '1', OURS_CHANNEL: 'nightly' } });
  optedIn.version = '0.16.0';
  await runInstall([], optedIn);
  assert.ok(optedIn.recorder.ran.some((c) => c.join(' ').includes('@nightly')), 'and a stable one can opt in');
});

// ------------------------------ the component question that was never asked --

test('the complete component stack is selected without package questions', async () => {
  const e = fx({ versions: { '@ours.network/cowork': '0.5.0' } });
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'latest' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(e.recorder.asked, []);
  assert.ok(summary.installed.includes('tg') && summary.installed.includes('cowork'));
});

test('the required MCP adapter is never presented as optional', async () => {
  // The daemon phase has already installed the adapter by the time this runs.
  const e = fx({ answers: [false, false] });
  await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'latest' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.ok(!e.recorder.asked.some((p) => /MCP server|ours daemon/.test(p)), 'not offered as a choice');
});

test('explicit programmatic omissions remain available for compatibility', async () => {
  const e = fx();
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { tg: false, cowork: false }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'latest' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(summary.skipped.sort(), ['cowork', 'tg']);
  assert.deepEqual(e.recorder.wrote, [], 'nothing written for a component that was declined');
});

test('a non-interactive run asks NOTHING and selects the complete stack', async () => {
  const e = fx({ env: { OURS_ASSUME_YES: '1' }, versions: { '@ours.network/cowork': '0.5.0' } });
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { dryRun: false, assumeYes: true, brokerUrl: 'wss://b', channel: 'latest' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(e.recorder.asked, [], 'nothing asked');
  assert.ok(summary.installed.includes('tg') && summary.installed.includes('cowork'));
});
