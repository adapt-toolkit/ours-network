// ours-install v3 stage 4 — re-running, and a second daemon alongside the first
// Pure. The idempotence tests drive the REAL plan functions from
// the earlier stages and feed each run's output back in as the next run's
// existing state, so "a repeat run changes nothing" is measured rather than
// asserted about a mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { perDaemonArtefacts, daemonCollisions, componentCoexistence, summarizeRun, assertUpdateLeftDaemonAlone } from '../lib/rerun.mjs';
import { planDaemonConfig, planServiceInstall, CLI_UNIT_MARKER } from '../lib/plan.mjs';
import { planTgAttachment, planCoworkAttachment, planComponentSelection } from '../lib/components.mjs';
import { resolveTarget, CLI_PID_RECORD, DAEMON_CONFIG } from '../lib/target.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const TG = resolve(HOME, '.ours-tg');
const SRV_TG = '/srv/ours-tg';

// ------------------------------------------------------------------ two daemons ----

test('two daemons share NO per-daemon artefact', async () => {
  const a = perDaemonArtefacts(OURS, 3050);
  const b = perDaemonArtefacts(TG, 3051);
  assert.deepEqual(daemonCollisions(a, b), [], 'everything is derived from the state directory');
  assert.equal(a.unit, 'ours.service');
  assert.equal(b.unit, 'ours-tg.service');
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.pidRecord, b.pidRecord);
});

test('the ONE field that can collide is the unit name, and it is closed one layer down', async () => {
  // ~/.ours-tg and /srv/ours-tg both derive ours-tg.service. Not a bug in the
  // derivation — the price of a readable unit name — and the CLI refuses to
  // overwrite a CLI-managed unit whose baked OURS_STATE_DIR is another daemon's.
  const a = perDaemonArtefacts(TG, 3051);
  const b = perDaemonArtefacts(SRV_TG, 3052);
  assert.deepEqual(daemonCollisions(a, b), ['unit'], 'only the unit name, never state or token');
  assert.notEqual(a.stateDir, b.stateDir);
  assert.notEqual(a.token, b.token);
});

test('componentCoexistence never lets a screen imply two connectors', async () => {
  assert.equal(componentCoexistence('mcp').coexists, true);
  for (const key of ['tg', 'cowork']) {
    const c = componentCoexistence(key);
    assert.equal(c.coexists, false);
    assert.match(c.why, /moves it rather than adding a second/);
    assert.ok(c.outOfScope, 'the limitation is stated, not left to be discovered');
  }
});

// -------------------------------------------------------- a repeat run is a no-op --

test('IDEMPOTENCE: feeding a run\'s own output back in changes nothing', async () => {
  const first = planDaemonConfig({ apiVisibility: 'shared' }, { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' });
  assert.equal(first.changed, true);
  const second = planDaemonConfig(first.config, { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' });
  assert.equal(second.changed, false, 'the second run must not rewrite the config');
  assert.deepEqual(second.changes, []);
  assert.equal(second.config.apiVisibility, 'shared', 'and still preserves what it never owned');
});

test('IDEMPOTENCE: the connector config is written once and then left alone', async () => {
  const args = { endpoint: 'http://127.0.0.1:3050', stateDir: OURS, brokerUrl: 'wss://b' };
  const first = planTgAttachment({ existing: { botToken: 'secret' }, ...args });
  assert.equal(first.action, 'attach');
  const second = planTgAttachment({ existing: first.config, ...args });
  assert.equal(second.action, 'unchanged');
  assert.equal(second.changed, false);
  assert.equal(second.config.botToken, 'secret');
});

test('IDEMPOTENCE: the cowork block is written once and then left alone', async () => {
  const args = { endpoint: 'http://127.0.0.1:3050', stateDir: OURS, installedVersion: '0.5.0' };
  const first = planCoworkAttachment({ existing: { theme: 'dark' }, ...args });
  assert.equal(first.action, 'attach');
  const second = planCoworkAttachment({ existing: first.config, ...args });
  assert.equal(second.action, 'unchanged');
});

test('IDEMPOTENCE: a re-run finds its own daemon on its own port and updates', async () => {
  // A re-run with the same state dir can never reach the
  // foreign-daemon refusal, because the directory is looked up first.
  const readJson = (p) => (p === join(OURS, DAEMON_CONFIG) ? { port: 3050, stateDir: OURS } : null);
  const probe = (port) => (port === 3050 ? { ok: true, stateDir: OURS } : { ok: false });
  for (let run = 0; run < 3; run += 1) {
    const r = await resolveTarget({ stateDir: OURS, probe, readJson, isTaken: () => false });
    assert.equal(r.action, 'update', `run ${run + 1} must not create a second daemon`);
    assert.equal(r.port, 3050, 'and must never move the port');
  }
});

test('IDEMPOTENCE: an unchanged CLI-managed unit is still just an install plan', async () => {
  // The CLI itself owns the byte-comparison no-op; the installer must not
  // second-guess it or skip calling it.
  const unit = `${CLI_UNIT_MARKER}\n[Unit]\nDescription=ours shared daemon\n`;
  const p = planServiceInstall({ stateDir: OURS, home: HOME, readText: () => unit });
  assert.equal(p.action, 'install');
});

test('a repeat run reports nothing changed, and every no-op says why', async () => {
  const summary = summarizeRun([
    { id: 'cli', changed: true, packageRefresh: true },
    { id: 'config', changed: false, reason: 'already correct' },
    { id: 'service', changed: false, reason: 'unit unchanged' },
    { id: 'tg-config', changed: false, reason: 'already points here' },
  ]);
  assert.equal(summary.changedAnything, false, 'a repeated run changes nothing but refreshed packages');
  assert.deepEqual(summary.refreshedPackages, ['cli']);
  assert.equal(summary.allNoopsExplained, true, 'a silent "nothing happened" is indistinguishable from an accidental skip');
});

test('a run that did something reports it', async () => {
  const summary = summarizeRun([{ id: 'config', changed: true }, { id: 'service', changed: false, reason: 'unit unchanged' }]);
  assert.equal(summary.changedAnything, true);
  assert.deepEqual(summary.changed, ['config']);
});

test('an unexplained no-op is caught', async () => {
  const summary = summarizeRun([{ id: 'service', changed: false, reason: '' }]);
  assert.equal(summary.allNoopsExplained, false);
});

// -------------------------------------------------- adding a component later ---

test('a later run can ADD a component without disturbing the installed ones', async () => {
  const chosen = planComponentSelection({ answers: { tg: true }, installed: { mcp: true } });
  assert.equal(chosen.find((c) => c.key === 'mcp').action, 'keep');
  assert.equal(chosen.find((c) => c.key === 'tg').action, 'install');
  assert.equal(chosen.find((c) => c.key === 'cowork').action, 'install', 'a re-run completes a missing default component');
});

test('update never deletes state, moves a port, or creates a second daemon', async () => {
  const before = { stateDir: OURS, port: 3050 };
  assert.deepEqual(assertUpdateLeftDaemonAlone({ before, after: { ...before, created: false } }), { ok: true, problems: [] });
  assert.deepEqual(
    assertUpdateLeftDaemonAlone({ before, after: { stateDir: OURS, port: 3060, created: false } }).problems,
    ['port moved'],
  );
  assert.deepEqual(
    assertUpdateLeftDaemonAlone({ before, after: { ...before, created: true } }).problems,
    ['a second daemon was created'],
  );
});

test('a second daemon is found by its PID record on a re-run even with no recorded port', async () => {
  // Belt and braces on the corruption case: a second daemon created by hand must
  // still be seen as present on every subsequent run.
  const readJson = (p) => (p === join(TG, CLI_PID_RECORD) ? { port: 3060 } : null);
  const probe = (port) => (port === 3060 ? { ok: true, stateDir: TG } : { ok: false });
  const r = await resolveTarget({ stateDir: TG, probe, readJson, isTaken: () => false });
  assert.equal(r.action, 'update');
  assert.equal(r.port, 3060);
});
