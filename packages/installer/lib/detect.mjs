// ours-install v3 — which daemons are already on this machine, and which one this
// run is for.
//
// Never ask for a state directory or port to be typed. When several
// daemons are DETECTED, show them and let one be picked: selecting from what was
// found is not prompting for a path.
//
// Pure, like target.mjs and plan.mjs: the caller injects the directory listing and
// the file reads, so the whole decision is testable without a filesystem.
//
// DETECTION, NOT A REGISTRY. This is built from what is on disk rather than from a
// persisted list: a stored list is a second source of truth that goes stale against
// the daemons that really exist, which is how an installer ends up confidently
// offering a daemon that is gone.

import { basename, join, resolve } from 'node:path';

// Artefacts ONLY a daemon writes. A directory carrying any of these is a daemon's
// state directory, whatever else is in it.
export const DAEMON_ARTEFACTS = ['daemon-token', 'ours-cli-daemon.json', 'root.json'];

/**
 * CONFIG.JSON IS THE ONE PIECE OF EVIDENCE THAT IS AMBIGUOUS, SO IT CANNOT BE THE
 * TEST. This is the trap this function exists to avoid, and it is worth stating
 * plainly because the obvious implementation walks straight into it:
 *
 * `~/.ours-telegram/config.json` and `~/.ours-cowork/config.json` both exist on a
 * normal machine, both match a `~/.ours*` scan, and NEITHER is a daemon — they are
 * the connectors' own configs. A selection screen built on "has a config.json"
 * shows three daemons on a machine with one, and choosing the Telegram connector's
 * directory would have the installer create a daemon inside it.
 *
 * So a config.json counts only when its SHAPE is a daemon's: it records a `port`
 * or a `stateDir`, and it carries none of the keys that identify it as somebody
 * else's. `daemonUrl`/`daemonStateDir` are the Telegram connector's; a `daemon`
 * block is cowork's; `botToken` is the connector's too.
 */
export function looksLikeDaemonConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  if (typeof config.daemonUrl === 'string' || typeof config.daemonStateDir === 'string') return false;
  if (config.daemon !== undefined) return false;
  if (typeof config.botToken === 'string') return false;
  return typeof config.port === 'number' || typeof config.stateDir === 'string';
}

/**
 * Is this directory a daemon's state directory? Returns the evidence, so a screen
 * or a test can say WHY rather than just yes.
 */
export function classifyStateDir(dir, { exists, readJson }) {
  const target = resolve(dir);
  const artefact = DAEMON_ARTEFACTS.find((name) => exists(join(target, name)));
  if (artefact) return { isDaemon: true, evidence: artefact, config: readJson(join(target, 'config.json')) };
  const config = readJson(join(target, 'config.json'));
  if (looksLikeDaemonConfig(config)) return { isDaemon: true, evidence: 'config.json', config };
  return { isDaemon: false, evidence: null, config: null };
}

/**
 * Every daemon state directory this machine can be seen to have.
 *
 * KNOWN LIMIT, inherited from effects.knownStateDirs and stated rather than
 * implied: only `~/.ours` and its `~/.ours*` siblings are looked at. A state
 * directory somewhere else entirely is not found, and the failure is that it is not
 * offered — never that the wrong one is chosen, because `--state-dir` still names
 * anything and overrides all of this.
 */
export function detectDaemons({ candidates = [], exists, readJson }) {
  const found = [];
  for (const dir of candidates) {
    const target = resolve(dir);
    if (found.some((d) => d.stateDir === target)) continue;
    const verdict = classifyStateDir(target, { exists, readJson });
    if (!verdict.isDaemon) continue;
    found.push({
      stateDir: target,
      port: typeof verdict.config?.port === 'number' ? verdict.config.port : null,
      evidence: verdict.evidence,
      label: basename(target),
    });
  }
  // Deterministic, and the default daemon first when it is one of them — it is the
  // one an operator means by "my daemon".
  return found.sort((a, b) => {
    if (basename(a.stateDir) === '.ours') return -1;
    if (basename(b.stateDir) === '.ours') return 1;
    return a.stateDir.localeCompare(b.stateDir);
  });
}

/**
 * A state directory for a daemon this run would CREATE, derived and never typed.
 *
 * The UI does not ask for a path, so "create a new one" has to derive somewhere
 * to put it: `~/.ours` when free, else the first free `~/.ours-2`, `~/.ours-3`…
 * An operator who wants a specific path still has `--state-dir`, which bypasses
 * this screen entirely.
 */
export function deriveNewStateDir(home, taken = [], { limit = 64 } = {}) {
  const used = new Set(taken.map((d) => resolve(d)));
  const first = resolve(join(home, '.ours'));
  if (!used.has(first)) return first;
  for (let n = 2; n < limit; n += 1) {
    const candidate = resolve(join(home, `.ours-${n}`));
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

export const SELECT_CREATE = '__create__';

/**
 * What this run should do about choosing a daemon (C1's five rules, in one place
 * so they can be read together and tested without a terminal):
 *
 *   flags given          → no screen at all. `--state-dir` or `--port` is an
 *                          explicit target and outranks anything detected.
 *   non-interactive      → no screen. Flags only, and every existing refusal still
 *                          applies — OURS_ASSUME_YES suppresses questions, never a
 *                          refusal.
 *   none detected        → create, exactly as before.
 *   exactly one detected → no prompt, use it, and SAY which one. A question with
 *                          one answer is not a choice, it is a keystroke tax.
 *   several detected     → show them and pick, with "create a new one" as the last
 *                          option.
 */
export function planDaemonSelection({
  candidates = [],
  stateDirExplicit = false,
  portExplicit = false,
  assumeYes = false,
  home,
} = {}) {
  if (stateDirExplicit || portExplicit) {
    return { action: 'flags', reason: stateDirExplicit ? '--state-dir names the target' : '--port names the target' };
  }
  if (assumeYes) return { action: 'flags', reason: 'non-interactive: flags only, no screen' };
  if (candidates.length === 0) return { action: 'create', stateDir: deriveNewStateDir(home, []) };
  if (candidates.length === 1) {
    return { action: 'use', stateDir: candidates[0].stateDir, only: candidates[0], announce: true };
  }
  return {
    action: 'choose',
    candidates,
    createOption: { id: SELECT_CREATE, stateDir: deriveNewStateDir(home, candidates.map((c) => c.stateDir)) },
  };
}

/**
 * Resolve a typed answer against the offered list.
 *
 * Deliberately strict: an answer that is not a number in range, or the create
 * option, is NOT a state directory to be interpreted. Accepting free text here
 * would reintroduce the forbidden "type a path" prompt through the
 * back door.
 */
export function resolveSelection(answer, { candidates = [], createOption = null } = {}) {
  const value = String(answer ?? '').trim().toLowerCase();
  if (!value) return { action: 'invalid', reason: 'no answer' };
  if (value === 'n' || value === 'new' || value === String(candidates.length + 1)) {
    return createOption?.stateDir
      ? { action: 'create', stateDir: createOption.stateDir }
      : { action: 'invalid', reason: 'no free state directory could be derived' };
  }
  if (!/^\d+$/.test(value)) return { action: 'invalid', reason: 'that is not one of the numbers offered' };
  const index = Number(value) - 1;
  if (!Number.isInteger(index) || !candidates[index]) return { action: 'invalid', reason: 'that is not one of the numbers offered' };
  return { action: 'use', stateDir: candidates[index].stateDir };
}
