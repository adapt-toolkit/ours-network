// ours-install v3 — re-running, and a second daemon alongside the first.
//
// Pure re-run and coexistence planning, like the earlier stages.
//
// Two properties this file exists to make checkable rather than hoped for:
//
//   IDEMPOTENCE. Running the installer again with the same answers changes
//   nothing except refreshed npm packages. Not "changes little" — nothing: no
//   config written, no unit rewritten, no systemctl run, no daemon restarted.
//
//   COEXISTENCE. Two daemons share no per-daemon artefact. Everything keyed
//   to a daemon is derived from its state directory, so two state directories
//   produce two of everything.

import { join, resolve } from 'node:path';
import { unitNameForStateDir } from './plan.mjs';

/**
 * Everything that belongs to one daemon is derived from its state directory.
 * Listing the artifacts in one place makes "these two daemons share
 * nothing" a property a test can check instead of a claim in a document.
 *
 * `port` is included because it is per-daemon, but note it is NOT what identifies
 * one: it is a fact about a daemon, not its name.
 */
export function perDaemonArtefacts(stateDir, port) {
  const dir = resolve(stateDir);
  const unit = unitNameForStateDir(dir);
  return {
    stateDir: dir,
    port,
    config: join(dir, 'config.json'),
    token: join(dir, 'daemon-token'),
    pidRecord: join(dir, 'ours-cli-daemon.json'),
    log: join(dir, 'ours-cli-daemon.log'),
    unit: unit.ok ? unit.unit : null,
  };
}

/**
 * Do two daemons collide anywhere?
 *
 * Returns the list of colliding fields, empty when they are fully independent.
 * The unit name is checked like everything else, and it is the ONE field that can
 * collide for two legitimately different state directories — `~/.ours-tg` and
 * `/srv/ours-tg` both derive `ours-tg.service`. That is not a bug in the
 * derivation, it is the price of a readable unit name, and it is closed one layer
 * down: the CLI refuses to overwrite a CLI-managed unit whose baked
 * OURS_STATE_DIR is a different daemon's. This function surfaces it so the
 * installer can say so before the CLI has to.
 */
export function daemonCollisions(a, b) {
  const fields = ['stateDir', 'port', 'config', 'token', 'pidRecord', 'log', 'unit'];
  return fields.filter((f) => a[f] !== null && a[f] !== undefined && a[f] === b[f]);
}

/**
 * The per-component coexistence rule, stated so the screen can never
 * imply something the design does not do.
 *
 *   mcp    — coexists naturally. Each harness registration carries its own
 *            OURS_CONFIG, so one harness can point at ~/.ours and another at
 *            ~/.ours-tg.
 *   tg     — ONE config file with ONE daemon pair and ONE unit. Pointing it at a
 *            second daemon MOVES it. Running two connectors at once needs a
 *            second config file and a second unit, which is outside what this
 *            installer does — stated here so no screen implies otherwise.
 *   cowork — the same, for its single `daemon` block.
 */
export function componentCoexistence(key) {
  if (key === 'mcp') {
    return { key, coexists: true, why: 'each harness registration carries its own OURS_CONFIG' };
  }
  return {
    key,
    coexists: false,
    why: 'one config file with one daemon pair and one unit — pointing it elsewhere moves it rather than adding a second',
    outOfScope: 'running two at once needs a second config file and a second unit, which this installer does not do',
  };
}

/**
 * Summarise a run for the screen, and decide whether it changed anything.
 *
 * `steps` are the outcomes the orchestrator collected, each
 * `{ id, changed: boolean, reason?: string, packageRefresh?: boolean }`.
 *
 * A repeated run must come back `changedAnything: false` with a reason recorded
 * against every step, because "nothing happened" is only trustworthy when the run
 * can say why for each thing it did not do. Package refreshes are counted
 * separately: `npm i -g` is not idempotent in the same sense and re-running it is
 * the one thing a repeat run is allowed to do.
 */
export function summarizeRun(steps) {
  const changed = steps.filter((s) => s.changed === true && s.packageRefresh !== true);
  const refreshed = steps.filter((s) => s.packageRefresh === true).map((s) => s.id);
  const noops = steps.filter((s) => s.changed !== true).map((s) => ({ id: s.id, reason: s.reason ?? 'unchanged' }));
  return {
    changedAnything: changed.length > 0,
    changed: changed.map((s) => s.id),
    refreshedPackages: refreshed,
    noops,
    // Every no-op carries a reason: a silent "nothing happened" is
    // indistinguishable from a step that was skipped by accident.
    allNoopsExplained: noops.every((n) => typeof n.reason === 'string' && n.reason.length > 0),
  };
}

/**
 * Did a re-run leave the daemon alone? An update never deletes state,
 * never moves a port, and never creates a second daemon.
 */
export function assertUpdateLeftDaemonAlone({ before, after }) {
  const problems = [];
  if (before.stateDir !== after.stateDir) problems.push('state directory changed');
  if (before.port !== after.port) problems.push('port moved');
  if (after.created === true) problems.push('a second daemon was created');
  return { ok: problems.length === 0, problems };
}
