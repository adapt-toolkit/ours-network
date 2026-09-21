// ours-uninstall v3 — the orchestrator.
//
// Every side effect is injected, so this walks whole removals without deleting
// anything, stopping anything, or running a command. NOTHING here touches a real
// state directory, and `removeDir` is a recorder in every test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { runUninstall, runPurgePhase, EXIT_OK, EXIT_REFUSED } from '../lib/orchestrate-uninstall.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const TG_CFG = join(HOME, '.ours-telegram', 'config.json');
const COWORK_CFG = join(HOME, '.ours-cowork', 'config.json');

function fx({ json = {}, text = {}, env = {}, answers = [], typed = null, known = [OURS], isStateDir = true, present = () => false, runFails = [], profile = null, profileVerificationError = null } = {}) {
  const recorder = { ran: [], wrote: [], out: [], asked: [], removed: [], wroteText: [], restored: [], profileVerifications: 0 };
  let i = 0;
  return {
    recorder,
    home: HOME,
    env,
    readJson: (p) => (Object.prototype.hasOwnProperty.call(json, p) ? json[p] : null),
    readProfile: () => profile,
    verifyHostProfile: async () => {
      recorder.profileVerifications += 1;
      if (profileVerificationError) throw new Error(profileVerificationError);
      return { profile, version: { instanceId: profile?.expectedInstanceId } };
    },
    writeJson: (p, body) => { recorder.wrote.push([p, body]); },
    run: async (cmd, a) => {
      recorder.ran.push([cmd, ...a]);
      if (runFails.some((f) => [cmd, ...a].join(' ').includes(f))) throw new Error(`${cmd} exited 1`);
      return { ok: true, code: 0, stdout: '' };
    },
    // The rollback seam, seeded from `json` exactly as readJson is, and RECORDED
    // rather than performed — so a test proves the bytes went back without a
    // filesystem.
    snapshot: (p) => ({ exists: Object.prototype.hasOwnProperty.call(json, p), text: Object.prototype.hasOwnProperty.call(json, p) ? `${JSON.stringify(json[p], null, 2)}\n` : '', mode: 0o600 }),
    restore: (p, snap) => { recorder.restored.push([p, snap]); },
    removeDir: async (p) => { recorder.removed.push(p); },
    removeFile: async (p) => { recorder.removed.push(p); },
    readText: (p) => (Object.prototype.hasOwnProperty.call(text, p) ? text[p] : null),
    writeText: (p, body) => { recorder.wroteText.push([p, body]); },
    knownStateDirs: () => known,
    // `isStateDir` answers the purge gate; `present` answers "does this plugin
    // file exist", so a test can leave the plugin phase with nothing to do.
    exists: (p) => (p === env.OURS_CONFIG && profile ? true : String(p).includes('.hermes') || String(p).includes('.codex') || String(p).includes('skills') ? present(p) : isStateDir),
    out: (l) => recorder.out.push(String(l)),
    // The real `ask` takes a DEFAULT, and questions in this file disagree about
    // what it is — the component confirmation defaults to no, the per-harness
    // plugin question to yes. A fake that hardcoded `false` would silently answer
    // half of them the wrong way and pass anyway.
    ask: async (p, def = false) => { recorder.asked.push(p); return answers[i] === undefined ? def : answers[i++]; },
    askLine: async (p) => { recorder.asked.push(p); return typed; },
  };
}
const said = (e) => e.recorder.out.join('\n');
const CFG = { port: 3050, stateDir: OURS };
const PROFILE_PATH = '/home/me/private/profile.json';
const PROFILE = { endpoint: 'http://127.0.0.1:8787', expectedInstanceId: '6d1e0b1a-cba2-4d33-9389-7d1787ea325f', credentialPath: '/home/me/private/token' };

test('host-profile uninstall removes selected client attachments but never daemon state or shared credentials, even with --purge', async () => {
  const e = fx({
    env: { OURS_CONFIG: PROFILE_PATH, OURS_UNINSTALL: 'codex' }, profile: PROFILE,
    present: (path) => String(path).includes('.codex'),
  });
  assert.equal(await runUninstall(['--purge'], e), EXIT_OK);
  const commands = e.recorder.ran.map((command) => command.join(' '));
  assert.ok(commands.some((command) => command === 'npm rm -g @ours.network/codex'));
  assert.ok(!commands.some((command) => /daemon|install-service|uninstall-service/.test(command)));
  assert.ok(!e.recorder.removed.includes(PROFILE_PATH));
  assert.ok(!e.recorder.removed.includes(PROFILE.credentialPath));
  assert.match(said(e), /profile.*credential.*kept/i);
  assert.equal(e.recorder.profileVerifications, 0, 'client-only removal has no online daemon precondition');
});

test('invalid selected profile refuses uninstall before mutation without probing a daemon', async () => {
  const e = fx({ env: { OURS_CONFIG: PROFILE_PATH }, profile: { endpoint: PROFILE.endpoint } });
  assert.equal(await runUninstall([], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, []);
  assert.deepEqual(e.recorder.removed, []);
  assert.equal(e.recorder.profileVerifications, 0);
});

test('host-profile removal excludes a pre-existing local Hermes integration', async () => {
  const e = fx({
    env: { OURS_CONFIG: PROFILE_PATH, OURS_UNINSTALL: 'all' }, profile: PROFILE,
    present: (path) => String(path).includes('.hermes') || String(path).includes('.codex'),
  });
  assert.equal(await runUninstall([], e), EXIT_OK);
  assert.ok(!e.recorder.ran.some((command) => command.includes('@ours.network/hermes')));
  assert.ok(!e.recorder.removed.some((path) => String(path).includes('.hermes')));
});

test('NO uninstall path ever runs systemctl', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG } });
  await runUninstall(['--state-dir', OURS], e);
  for (const cmd of e.recorder.ran) {
    assert.ok(!cmd.includes('systemctl') && !cmd.includes('loginctl'), `never: ${cmd.join(' ')}`);
  }
});

test('a component still pointing here refuses BEFORE the first mutation', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG, [TG_CFG]: { daemonStateDir: OURS, botToken: 's' } } });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, [], 'nothing stopped or removed');
  assert.deepEqual(e.recorder.wrote, []);
  assert.deepEqual(e.recorder.removed, []);
  assert.match(said(e), /still point at this daemon/);
});

test('confirming the component in the same run lets it proceed, and KEEPS the file', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG, [TG_CFG]: { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS, botToken: 'secret' } },
    answers: [true],
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);
  const [path, body] = e.recorder.wrote.find(([p]) => p === TG_CFG);
  const rewritten = JSON.parse(body);
  assert.equal(path, TG_CFG);
  assert.equal(rewritten.botToken, 'secret', 'the operator bot token was never ours to delete');
  assert.ok(!('daemonUrl' in rewritten) && !('daemonStateDir' in rewritten));
  assert.ok(e.recorder.ran.some((c) => c.join(' ') === 'ours-tg-connector uninstall-service'));
});

test('detaching cowork announces the behaviour change before it happens', async () => {
  const e = fx({
    json: {
      [join(OURS, 'config.json')]: CFG,
      [COWORK_CFG]: { stateDir: '/home/me/.ours-cowork', daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: OURS } },
    },
    answers: [true],
  });
  await runUninstall(['--state-dir', OURS], e);
  const announced = said(e).indexOf('returns to embedded mode');
  const written = said(e).indexOf('.ours-cowork/config.json');
  assert.ok(announced >= 0, 'the change is stated');
  assert.ok(announced < written, 'and stated BEFORE the file is touched');
});

test('a daemon the CLI did not start is named, not signalled', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG } });
  await runUninstall(['--state-dir', OURS], e);
  assert.ok(!e.recorder.ran.some((c) => c.join(' ').includes('daemon stop')), 'no PID record, so no signal');
  assert.match(said(e), /not started by the CLI/);
});

test('a managed daemon is stopped, whichever daemon wrote the record', async () => {
  // EITHER record proves it: ours-cli-daemon.json is what `ours-daemon start`
  // writes now, while daemon.pid is retained only as prerelease migration
  // evidence. Reading only one would decline to stop a daemon we can stop.
  const byCli = fx({ json: { [join(OURS, 'config.json')]: CFG, [join(OURS, 'ours-cli-daemon.json')]: { pid: 1, port: 3050 } } });
  await runUninstall(['--state-dir', OURS], byCli);
  assert.ok(byCli.recorder.ran.some((c) => c.join(' ').startsWith('ours-daemon stop ')), 'the CLI-written record still counts');

  const byMcp = fx({ json: { [join(OURS, 'config.json')]: CFG }, text: { [join(OURS, 'daemon.pid')]: '4242' } });
  await runUninstall(['--state-dir', OURS], byMcp);
  assert.ok(byMcp.recorder.ran.some((c) => c.join(' ').startsWith('ours-daemon stop ')), 'and so does the legacy pid file');
});

test('--dry-run removes, stops and deletes nothing', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG }, typed: OURS });
  assert.equal(await runUninstall(['--state-dir', OURS, '--purge', '--dry-run'], e), EXIT_OK);
  assert.deepEqual(e.recorder.ran, []);
  assert.deepEqual(e.recorder.wrote, []);
  assert.deepEqual(e.recorder.removed, [], 'not even under --purge');
  assert.match(said(e), /\[dry-run\] would: delete/);
});

// ------------------------------------------------------------------ --purge --

test('state is kept by default, with the hint', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG } });
  await runUninstall(['--state-dir', OURS], e);
  assert.deepEqual(e.recorder.removed, []);
  assert.match(said(e), /state .* kept/);
  assert.match(said(e), /--purge/);
});

test('--purge with a matching typed path deletes exactly that directory', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG }, typed: OURS });
  const r = await runPurgePhase({ dir: OURS, purge: true, args: { dryRun: false, assumeYes: false }, effects: e });
  assert.equal(r.purged, true);
  assert.deepEqual(e.recorder.removed, [OURS], 'the exact directory, never a parent');
});

test('--purge with a WRONG typed path keeps the state and does not retry', async () => {
  // A second chance at deleting identity keys is not a kindness.
  for (const wrong of ['y', 'yes', '', `${OURS}/`, '/home/me']) {
    const e = fx({ typed: wrong });
    const r = await runPurgePhase({ dir: OURS, purge: true, args: { dryRun: false, assumeYes: false }, effects: e });
    assert.equal(r.purged, false, `${JSON.stringify(wrong)} must not purge`);
    assert.deepEqual(e.recorder.removed, []);
    assert.equal(e.recorder.asked.length, 1, 'asked once, not in a loop');
  }
});

test('--purge refuses a directory that is not a state directory at all', async () => {
  const e = fx({ typed: OURS, isStateDir: false });
  const r = await runPurgePhase({ dir: OURS, purge: true, args: { dryRun: false, assumeYes: false }, effects: e, config: { port: 3050 } });
  assert.equal(r.purged, false);
  assert.deepEqual(e.recorder.asked, [], 'it is not even asked about');
  assert.match(said(e), /does not look like an ours state directory/);
});

// --------------------------------------------------------- non-interactive behavior ---

test('an unattended run never consents to removing a component, so it refuses', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG, [TG_CFG]: { daemonStateDir: OURS } },
    env: { OURS_ASSUME_YES: '1' },
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.asked, [], 'no question is asked');
  assert.deepEqual(e.recorder.ran, [], 'and nothing is removed');
});

test('an unattended --purge never deletes state', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG }, env: { OURS_ASSUME_YES: '1' }, typed: OURS });
  assert.equal(await runUninstall(['--state-dir', OURS, '--purge'], e), EXIT_OK);
  assert.deepEqual(e.recorder.removed, []);
  assert.match(said(e), /never deleted non-interactively/);
});

// ------------------------------------------------------- global package cleanup -----

test('global packages are kept while another daemon still needs them', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG }, known: [OURS, join(HOME, '.ours-tg')] });
  await runUninstall(['--state-dir', OURS], e);
  assert.ok(!e.recorder.ran.some((c) => c.includes('rm')), 'nothing removed globally');
  assert.match(said(e), /kept — still used by the daemon at/);
});

test('global packages go only when this was the last daemon', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG }, known: [OURS] });
  await runUninstall(['--state-dir', OURS], e);
  const removals = e.recorder.ran.filter((c) => c.includes('rm')).map((c) => c[c.length - 1]);
  assert.deepEqual(removals, ['@ours.network/cli', '@ours.network/mcp']);
});

// ------------------------------------------------- the harness plugin phase --

const HERMES_CFG = join(HOME, '.hermes', 'config.yaml');
const BLOCK = ['# >>> ours.network plugin (managed block)', 'mcpServers:', '# <<< ours.network plugin'];

test('the plugin phase strips only our block, and keeps the file', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [HERMES_CFG]: `theirs\n${BLOCK.join('\n')}\nalso theirs\n` },
    present: (p) => String(p).includes('.hermes'),
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);
  const [path, body] = e.recorder.wroteText.find(([p]) => p === HERMES_CFG);
  assert.equal(path, HERMES_CFG);
  assert.equal(body, 'theirs\nalso theirs\n', 'the file is kept — only our span goes');
  assert.ok(e.recorder.ran.some((c) => c.join(' ') === 'npm rm -g @ours.network/hermes'));
});

test('an unterminated block is reported and the file is never written', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [HERMES_CFG]: '# >>> ours.network plugin (managed block)\nmcpServers:\ntheir own settings\n' },
    present: (p) => String(p).includes('.hermes'),
  });
  await runUninstall(['--state-dir', OURS], e);
  assert.deepEqual(e.recorder.wroteText, [], 'damage we cannot bound is damage we do not do');
  assert.match(said(e), /no closing marker/);
});

test('a second daemon leaves every plugin file alone', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [HERMES_CFG]: `theirs\n${BLOCK.join('\n')}\n` },
    present: () => true,
    known: [OURS, resolve(HOME, '.ours-tg')],
  });
  await runUninstall(['--state-dir', OURS], e);
  assert.deepEqual(e.recorder.wroteText, []);
  assert.deepEqual(e.recorder.removed, []);
  assert.match(said(e), /harness plugins kept/);
});

test("Claude Code's own removal is always printed, even when nothing else is", async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG } });
  await runUninstall(['--state-dir', OURS], e);
  assert.match(said(e), /\/plugin uninstall ours/);
  assert.match(said(e), /nothing on disk is ours to remove/);
});

// ------------------------------------- the component config we cannot read ---

test('a corrupt connector config refuses the run and removes NOTHING', async () => {
  // The fail-open this closes: readJson turned the parse error into null, the
  // connector looked absent, and the daemon was removed out from under it.
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [TG_CFG]: '{ "daemonStateDir": "/home/me/.ours"' },
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, [], 'nothing stopped, uninstalled or npm-removed');
  assert.deepEqual(e.recorder.wrote, [], 'and no config rewritten');
  assert.deepEqual(e.recorder.wroteText, []);
  assert.deepEqual(e.recorder.removed, [], 'and nothing deleted');
  assert.match(said(e), /corrupt or unsafe to inspect/);
});

test('the corrupt-config refusal is not asked away, and beats even --purge', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [COWORK_CFG]: 'not json' },
    answers: [true, true, true],
    typed: OURS,
  });
  assert.equal(await runUninstall(['--state-dir', OURS, '--purge'], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.removed, [], 'the irreversible step is never reached');
  assert.deepEqual(e.recorder.asked, [], 'and the operator is not offered a way to consent past it');
});

// --------------------------------------- the detach journal (L2, site 4) -----

test('a daemon that will not go away leaves its connectors attached, not detached', async () => {
  // The bytes said "no longer attached to this daemon" and only the daemon's
  // removal made that true. It did not happen, so they go back — AND the service is
  // re-applied, because a config restored under a stopped service is a half
  // rollback, and half-states are what this eliminates.
  const e = fx({
    json: {
      [join(OURS, 'config.json')]: CFG,
      [TG_CFG]: { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS, botToken: 'secret' },
    },
    answers: [true],
    runFails: ['ours-daemon uninstall-service'],
  });
  await assert.rejects(() => runUninstall(['--state-dir', OURS], e), /ours-daemon exited 1/,
    'the original failure is what propagates, never the recovery');
  const [path, snapshot] = e.recorder.restored[0];
  assert.equal(path, TG_CFG);
  assert.equal(JSON.parse(snapshot.text).daemonUrl, 'http://127.0.0.1:3050', 'attached again');
  assert.equal(JSON.parse(snapshot.text).botToken, 'secret');
  assert.ok(
    e.recorder.ran.some((c) => c.join(' ') === 'ours-tg-connector install-service'),
    'and its service is put back up, as nightly does',
  );
  assert.match(said(e), /attached and running again/);
});

test('a re-apply that itself fails is reported and does not replace the real fault', async () => {
  const e = fx({
    json: {
      [join(OURS, 'config.json')]: CFG,
      [COWORK_CFG]: { stateDir: '/home/me/.ours-cowork', daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: OURS } },
    },
    answers: [true],
    runFails: ['ours-daemon uninstall-service', 'ours-cowork install-service'],
  });
  await assert.rejects(() => runUninstall(['--state-dir', OURS], e), /ours-daemon exited 1/);
  assert.deepEqual(e.recorder.restored.map(([p]) => p), [COWORK_CFG], 'the bytes still went back');
  assert.match(said(e), /could NOT re-apply cowork's service/);
  assert.match(said(e), /run 'ours-cowork install-service' yourself/);
});

test('nothing is rolled back when the daemon removal succeeds', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG, [TG_CFG]: { daemonStateDir: OURS, botToken: 's' } },
    answers: [true],
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);
  assert.deepEqual(e.recorder.restored, []);
  assert.ok(!e.recorder.ran.some((c) => c.join(' ') === 'ours-tg-connector install-service'),
    'and the connector is NOT put back up — it was meant to come down');
});

test('a dry-run detach journals nothing, because it wrote nothing', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG, [TG_CFG]: { daemonStateDir: OURS } },
    answers: [true],
    runFails: ['ours-daemon uninstall-service'],
  });
  assert.equal(await runUninstall(['--state-dir', OURS, '--dry-run'], e), EXIT_OK);
  assert.deepEqual(e.recorder.restored, []);
  assert.deepEqual(e.recorder.ran, [], 'a dry run never reaches a real failure');
});

// -------------------- item 9.5 — the operator chooses which harnesses go ------

const CODEX_TOML = join(HOME, '.codex', 'config.toml');
const HERMES_SKILL = join(HOME, '.hermes', 'skills', 'communication', 'ours');
const CODEX_SKILL = join(HOME, '.agents', 'skills', 'ours');

test('saying no to a harness leaves its files, its directories and its launcher alone', async () => {
  // Both plugins are on disk. Answers are asked in canonical order —
  // claude-code, codex, hermes — so this removes codex and keeps hermes.
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: {
      [HERMES_CFG]: `theirs\n${BLOCK.join('\n')}\n`,
      [CODEX_TOML]: `theirs\n${BLOCK.join('\n')}\n`,
    },
    present: () => true,
    answers: [false, true, false],
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);

  assert.deepEqual(e.recorder.wroteText.map(([p]) => p), [CODEX_TOML],
    'only the harness that was said yes to had its config touched');
  assert.ok(e.recorder.removed.includes(CODEX_SKILL));
  assert.ok(!e.recorder.removed.some((p) => String(p).includes('.hermes')),
    'nothing under the kept harness was deleted');
  const npm = e.recorder.ran.filter((c) => c[0] === 'npm').map((c) => c[c.length - 1]);
  assert.ok(npm.includes('@ours.network/codex'));
  assert.ok(!npm.includes('@ours.network/hermes'),
    'a kept plugin keeps its launcher — removing it would break a registration that is still there');
});

test('an unattended run removes no harness plugin unless one was named', async () => {
  // The regression this closes: v3 removed every plugin artefact it found in a
  // run with nobody watching, which leaving OURS_UNINSTALL unset used to prevent.
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [HERMES_CFG]: `theirs\n${BLOCK.join('\n')}\n` },
    present: () => true,
    env: { OURS_ASSUME_YES: '1' },
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);
  assert.deepEqual(e.recorder.wroteText, [], 'no plugin config rewritten');
  assert.deepEqual(e.recorder.removed, [], 'no skills directory deleted');
  assert.deepEqual(e.recorder.asked, [], 'and nobody was asked, because there was nobody to ask');
  const npm = e.recorder.ran.filter((c) => c[0] === 'npm').map((c) => c[c.length - 1]);
  assert.deepEqual(npm, ['@ours.network/cli', '@ours.network/mcp'],
    'the daemon still goes; only the harness plugins are left to the operator');
});

test('pressing Enter through the questions removes what v3 removes today', async () => {
  // The per-harness question DEFAULTS TO YES: the daemon these plugins talk to is
  // going away, so a plugin left behind advertises tools that no longer resolve.
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [HERMES_CFG]: `theirs\n${BLOCK.join('\n')}\n` },
    present: (p) => String(p).includes('.hermes'),
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);
  assert.equal(e.recorder.wroteText.length, 1);
  assert.ok(e.recorder.removed.includes(HERMES_SKILL));
  assert.ok(e.recorder.ran.some((c) => c.join(' ') === 'npm rm -g @ours.network/hermes'));
});

// ------- item 10.9 — the documented OURS_UNINSTALL_* contract, end to end ----

test('OURS_UNINSTALL="hermes" removes the hermes plugin and NOT the daemon', async () => {
  // The live escalation this closes. Before the OURS_UNINSTALL_DAEMON gate this
  // exact environment reached v3, which read none of it, and removed the daemon:
  // its boot service, its process, and @ours.network/cli + /mcp.
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG, [join(OURS, 'ours-cli-daemon.json')]: { pid: 1 } },
    text: { [HERMES_CFG]: `theirs\n${BLOCK.join('\n')}\n` },
    present: () => true,
    env: { OURS_UNINSTALL: 'hermes' },
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);

  const ran = e.recorder.ran.map((c) => c.join(' '));
  assert.ok(!ran.some((c) => c.includes('daemon uninstall-service')), 'the boot service stays');
  assert.ok(!ran.some((c) => c.includes('daemon stop')), 'the daemon is not stopped');
  assert.ok(!ran.some((c) => c.includes('@ours.network/cli') || c.includes('@ours.network/mcp')),
    'and the daemon packages are not removed');
  assert.deepEqual(e.recorder.removed, [
    join(HOME, '.hermes', 'skills', 'communication', 'ours'),
    join(HOME, '.hermes', 'skills', 'communication', 'writing-agent-bios'),
    join(HOME, '.hermes', 'ours-connector.env'),
    join(HOME, '.hermes', 'ours-connector.log'),
  ], 'exactly the hermes plugin, nothing else');
  assert.ok(ran.includes('npm rm -g @ours.network/hermes'));
  assert.deepEqual(e.recorder.asked, [], 'the contract is non-interactive, as it was in v2');
});

test('OURS_UNINSTALL_DAEMON=yes removes the daemon and, unset, no harness plugin', async () => {
  // v2 parity: OURS_UNINSTALL_DAEMON=yes on its own removed the daemon and left
  // every harness plugin alone, because OURS_UNINSTALL named none.
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [HERMES_CFG]: `theirs\n${BLOCK.join('\n')}\n` },
    present: () => true,
    env: { OURS_UNINSTALL_DAEMON: 'yes' },
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);
  const ran = e.recorder.ran.map((c) => c.join(' '));
  assert.ok(ran.some((c) => c.startsWith('ours-daemon uninstall-service ')));
  assert.deepEqual(e.recorder.wroteText, [], 'no plugin config touched');
  assert.deepEqual(e.recorder.removed, [], 'no plugin directory deleted');
  assert.ok(!ran.includes('npm rm -g @ours.network/hermes'));
});

test('OURS_UNINSTALL_DATA=yes refuses the whole run and removes NOTHING', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    env: { OURS_UNINSTALL: 'all', OURS_UNINSTALL_DAEMON: 'yes', OURS_UNINSTALL_DATA: 'yes' },
    present: () => true,
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, [], 'nothing stopped, uninstalled or npm-removed');
  assert.deepEqual(e.recorder.removed, [], 'and above all, no state directory deleted');
  assert.deepEqual(e.recorder.wroteText, []);
  assert.match(said(e), /OURS_UNINSTALL_DATA/, 'the refusal names the variable');
  assert.match(said(e), /--purge/, 'and names what to do instead');
});

test('OURS_UNINSTALL_TELEGRAM=detach gives the answer an unattended run cannot be asked for', async () => {
  // Without it this run refuses because tg points here and nobody can
  // confirm its removal. The documented value IS that confirmation.
  const attached = { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS, botToken: 'secret' };
  const refused = fx({
    json: { [join(OURS, 'config.json')]: CFG, [TG_CFG]: attached },
    env: { OURS_UNINSTALL_DAEMON: 'yes' },
  });
  assert.equal(await runUninstall(['--state-dir', OURS], refused), EXIT_REFUSED);

  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG, [TG_CFG]: attached },
    env: { OURS_UNINSTALL_DAEMON: 'yes', OURS_UNINSTALL_TELEGRAM: 'detach' },
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);
  const [, body] = e.recorder.wrote.find(([p]) => p === TG_CFG);
  assert.equal(JSON.parse(body).botToken, 'secret', 'detach keeps the file and the token');
  assert.ok(!('daemonUrl' in JSON.parse(body)));
  assert.deepEqual(e.recorder.asked, []);
});

test('OURS_UNINSTALL_TELEGRAM=reassign refuses on its OWN account, not step 1’s', async () => {
  // Deliberately with no connector pointing here, so the referenced-component refusal cannot
  // be what is happening: an unsupported value stops the run by itself. With a
  // connector attached both refusals coincide, and a test written that way would
  // pass against code that never read the variable at all.
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    env: { OURS_UNINSTALL_DAEMON: 'yes', OURS_UNINSTALL_TELEGRAM: 'reassign:default' },
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, [], 'the daemon it would otherwise have removed is untouched');
  assert.deepEqual(e.recorder.wrote, [], 'and the connector is not detached as a consolation prize');
  assert.match(said(e), /OURS_UNINSTALL_TELEGRAM/);
});

// ---------------------- the step-7 recomputation, and what it must carry -----

test('the recomputed package list still carries the confirmed connector', async () => {
  // Step 7 recomputes planGlobalPackages from what the plugin phase ACTUALLY
  // removed, because a kept harness keeps its launcher. That recomputation has a
  // second input it does not own — detachedComponents, which decides whether a
  // confirmed connector's package goes with it. Dropping it from the call is
  // textually clean, internally consistent, and silently reverts that behaviour.
  // Nothing but this test stops it being dropped again.
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG, [TG_CFG]: { daemonStateDir: OURS, botToken: 's' } },
    answers: [true],
    known: [OURS],
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);
  const npm = e.recorder.ran.filter((c) => c[0] === 'npm').map((c) => c[c.length - 1]);
  assert.deepEqual(npm, ['@ours.network/cli', '@ours.network/mcp', '@ours.network/tg-connector']);
});

test('a connector confirmed while ANOTHER daemon survives keeps its package through step 7', async () => {
  // The other half of the same rule, so the test above cannot be satisfied by
  // always appending the connector.
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG, [TG_CFG]: { daemonStateDir: OURS, botToken: 's' } },
    answers: [true],
    known: [OURS, resolve(HOME, '.ours-tg')],
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);
  assert.deepEqual(e.recorder.ran.filter((c) => c[0] === 'npm'), [], 'nothing global removed at all');
});

// --------------------------- macOS removes its service like anywhere else ----
//
// The shared CLI handles launchd as well as systemd.

test('every platform removes the boot service through the shared CLI', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG } });
  const onMac = { ...e, platform: { platform: 'darwin', release: '23.0.0' } };
  assert.equal(await runUninstall(['--state-dir', OURS], onMac), EXIT_OK);
  assert.ok(e.recorder.ran.some((c) => c.join(' ').startsWith('ours-daemon uninstall-service ')), 'attempted, not skipped');
  assert.doesNotMatch(said(e), /nothing of ours to remove here/);
});
