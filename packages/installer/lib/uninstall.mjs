// ours-uninstall v3 — removing ONE daemon, and the non-interactive contract.
//
// Pure uninstall planning, like every other stage: the caller
// injects the file reads and this returns a plan.
//
//   ours-uninstall [--state-dir PATH] [--purge] [--dry-run]
//
// `--state-dir` selects WHICH daemon to remove and defaults to ~/.ours. The
// uninstaller only ever touches that daemon and the components pointing at it.
//
// THE BIAS OF THIS WHOLE FILE IS TOWARD KEEPING THINGS. State is kept by default,
// a component's config file is kept even when its daemon keys are removed, and
// global packages are kept while any other daemon still needs them. The one
// destructive operation, --purge, is separately gated because
// it deletes identity keys, and no other step here is irreversible.

import { join, resolve } from 'node:path';
import { unitNameForStateDir } from './plan.mjs';
import { tgConfigPath, coworkConfigPath } from './components.mjs';
import { canonHarnesses } from './logic.mjs';

/**
 * Does this directory even look like an ours state directory?
 *
 * Purge applies to any explicitly selected ours state directory, not only one
 * created by this installer. This does not add a provenance gate: it asks
 * "is this a state directory at all",
 * not "is it ours". With provenance gone, the typed path would otherwise be the
 * only thing between `ours-uninstall --state-dir ~ --purge` and a deleted home
 * directory, and a typed path is no protection against a path typed exactly as
 * intended but meant differently.
 *
 * A directory qualifies if it carries any of the artefacts only a daemon writes.
 * Absent all of them, purge refuses and says why — the operator can still delete
 * the directory themselves, which is the right place for that decision.
 */
export const STATE_DIR_EVIDENCE = ['config.json', 'daemon-token', 'ours-cli-daemon.json', 'root.json'];
export function looksLikeStateDir(stateDir, exists) {
  return STATE_DIR_EVIDENCE.some((name) => exists(join(resolve(stateDir), name)));
}

/**
 * A component config file, read so that ABSENT and CORRUPT are different answers.
 *
 * WHY THIS IS NOT `readJson`. `effects.readJson` swallows every failure into
 * `null` (lib/effects.mjs), which is the right shape for the installer — an
 * unreadable daemon config there means "nothing recorded", and the run proceeds
 * to write one. On the UNINSTALL side that same `null` is a fail-open:
 * `componentsPointingHere` reads it as "no connector points at this daemon",
 * step 1's refusal never fires, and the daemon is removed out from under a
 * connector that may still be using it. The nightly uninstaller refuses here
 * (`lib/nightly-uninstall.mjs:22,244`) and has a test pinning that it does.
 *
 * So this takes `readText` — already on the effects contract — and does the parse
 * itself, which keeps the whole decision pure and testable:
 *
 *   absent  — no file (readText returned null). Nothing to point anywhere.
 *   ok      — a JSON object.
 *   corrupt — the file exists and is not a readable JSON object. An EXISTING file
 *             we cannot parse is the case that must stop the run: we cannot prove
 *             it does not name this daemon, and "cannot prove" is not "does not".
 *
 * An empty existing file is CORRUPT, not absent — same as the nightly reader,
 * which parses whatever `existsSync` says is there.
 *
 * THIS DECIDES NOTHING ABOUT CONTENTS. `componentsPointingHere` still reads its
 * values through `readJson`, unchanged — deliberately, so this addition cannot
 * alter which components are found. The only new outcome is `corrupt`, and the
 * only thing that consumes it is a refusal.
 */
export function inspectComponentConfig(path, { readText } = {}) {
  if (typeof readText !== 'function') return { state: 'unknown', reason: 'no text reader injected' };
  const text = readText(path);
  if (text === null || text === undefined) return { state: 'absent' };
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (error) {
    return { state: 'corrupt', reason: error instanceof Error ? error.message : String(error) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'corrupt', reason: 'expected a JSON object' };
  }
  return { state: 'ok' };
}

/**
 * Refuse if a component still points at this daemon.
 *
 * Read the connector's and cowork's config files; if either names this daemon's
 * endpoint or its state directory, list them and stop. Exit 2, nothing removed.
 * The operator either repoints them or confirms their removal in the same run.
 *
 * Matching on EITHER the endpoint or the state directory is deliberate: a
 * half-written pair should still be caught, and the whole point of the pair is
 * that neither half alone is trustworthy.
 */
export function componentsPointingHere({ home, env = {}, endpoint, stateDir, readJson }) {
  const dir = resolve(stateDir);
  const found = [];
  const tg = readJson(tgConfigPath(home, env));
  if (tg && (tg.daemonUrl === endpoint || (typeof tg.daemonStateDir === 'string' && resolve(tg.daemonStateDir) === dir))) {
    found.push({ key: 'tg', config: tgConfigPath(home, env), endpoint: tg.daemonUrl ?? null, stateDir: tg.daemonStateDir ?? null });
  }
  const cowork = readJson(coworkConfigPath(home, env));
  const block = cowork && typeof cowork.daemon === 'object' && cowork.daemon !== null ? cowork.daemon : null;
  if (block && (block.endpoint === endpoint || (typeof block.stateDir === 'string' && resolve(block.stateDir) === dir))) {
    found.push({ key: 'cowork', config: coworkConfigPath(home, env), endpoint: block.endpoint ?? null, stateDir: block.stateDir ?? null });
  }
  return found;
}

/**
 * The other half of step 1, and the reason it is a SEPARATE question.
 *
 * `componentsPointingHere` answers "does a component point here?". This answers
 * "is there a component config I cannot read at all?" — and the two must not be
 * collapsed, because they have opposite resolutions. A component that points here
 * can be confirmed for removal in the same run; a config that will not parse
 * cannot be confirmed away by anybody, because nothing about its contents is
 * known. The operator has to fix or move the file first.
 *
 * Returns [] when no reader capable of telling absent from corrupt was injected.
 * That is not a silent pass: planUninstall reports the limit in the plan itself.
 */
export function unreadableComponentConfigs({ home, env = {}, readText }) {
  if (typeof readText !== 'function') return [];
  const out = [];
  for (const [key, path] of [['tg', tgConfigPath(home, env)], ['cowork', coworkConfigPath(home, env)]]) {
    const read = inspectComponentConfig(path, { readText });
    if (read.state === 'corrupt') out.push({ key, config: path, reason: read.reason });
  }
  return out;
}

/**
 * Strip a component's daemon keys while KEEPING the file. It also holds the
 * operator's bot token and settings, and those are not ours to delete.
 *
 * For cowork, removing the `daemon` block returns it to embedded mode. That is a
 * real behaviour change, not a cleanup, so the plan carries `behaviourChange` for
 * the screen to state BEFORE it happens.
 */
export function planComponentDetach(key, existing) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  if (key === 'tg') {
    const removed = ['daemonUrl', 'daemonStateDir'].filter((k) => k in base);
    for (const k of removed) delete base[k];
    return { key, removed, config: base, keepsFile: true, behaviourChange: null };
  }
  const had = 'daemon' in base;
  delete base.daemon;
  return {
    key,
    removed: had ? ['daemon'] : [],
    config: base,
    keepsFile: true,
    behaviourChange: had ? 'cowork returns to embedded mode' : null,
  };
}

/**
 * Stop the boot service, then the daemon itself.
 *
 * Both delegate their refusals rather than reimplementing them: `ours daemon
 * uninstall-service` refuses to remove a unit not marked as CLI-managed, and
 * `ours daemon stop` refuses to signal a daemon it did not start. In the second
 * case the screen names the external launcher and the run CONTINUES — a daemon
 * someone else supervises is not a failure of this uninstall.
 */
export function planDaemonRemoval({ stateDir, cliStartedIt }) {
  const dir = resolve(stateDir);
  const unit = unitNameForStateDir(dir);
  const service = {
    id: 'service',
    unit: unit.ok ? unit.unit : null,
    command: ['ours', 'daemon', 'uninstall-service', '--yes', '--state-dir', dir, '--config', join(dir, 'config.json')],
    note: 'removes the unit managed by the ours CLI',
  };
  return [
    service,
    cliStartedIt
      ? { id: 'stop', command: ['ours', 'daemon', 'stop', '--state-dir', dir, '--config', join(dir, 'config.json')] }
      : { id: 'stop-external', command: null, continues: true, note: 'this daemon was not started by the CLI; naming its launcher and continuing' },
  ];
}

/**
 * State is kept unless every purge gate opens.
 *
 *   --purge given      — never the default; deleting identity keys is opt-in.
 *   interactive        — an unattended run never deletes state.
 *   looks like a state directory — see looksLikeStateDir.
 *   typed confirmation — the full path, not a y/N. Without a provenance
 *                        condition, this is the last thing standing between
 *                        a mistyped command and someone's identity keys.
 *
 * Returns the exact directory, never a glob or a parent, and only when every gate
 * is satisfied.
 */
export function planStatePurge({ stateDir, purge = false, assumeYes = false, exists = () => true, typedConfirmation = null }) {
  const dir = resolve(stateDir);
  const keep = (reason) => ({ action: 'keep', stateDir: dir, reason, hint: 're-run with --purge to delete identities and history' });
  if (!purge) return keep('state is kept by default');
  if (assumeYes) return keep('state is never deleted non-interactively');
  if (!looksLikeStateDir(dir, exists)) {
    return keep(`${dir} does not look like an ours state directory (none of ${STATE_DIR_EVIDENCE.join(', ')}); refusing to delete it`);
  }
  if (typedConfirmation !== dir) {
    return {
      action: 'confirm-typed',
      stateDir: dir,
      expected: dir,
      prompt: `This permanently deletes ${dir} and everything in it, including the identity keys and message history of every identity there. Those keys exist nowhere else and no peer can give them back.\nType the full path to confirm:`,
    };
  }
  return { action: 'purge', stateDir: dir, paths: [dir] };
}

/**
 * Global packages are shared. Remove them only when no other state
 * directory on this machine still has a daemon config; otherwise keep them and
 * say which daemon still needs them.
 */
export const CONNECTOR_PACKAGES = { tg: '@ours.network/tg-connector', cowork: '@ours.network/cowork' };

export function planGlobalPackages({ stateDir, otherStateDirsWithConfig = [], pluginPackages = [], detachedComponents = [] }) {
  const dir = resolve(stateDir);
  const others = otherStateDirsWithConfig.map((d) => resolve(d)).filter((d) => d !== dir);
  if (others.length > 0) {
    return { action: 'keep', packages: [], stillNeededBy: others, reason: `still used by the daemon at ${others[0]}` };
  }
  // The harness-plugin launchers follow the SAME rule, not a second one: they
  // speak to a daemon through ours-mcp, so a second daemon still on the machine
  // still needs them, and the one condition above already decides that.
  // A connector's package goes only when BOTH conditions hold: the operator
  // confirmed removing its attachment in THIS run, and this was the last daemon —
  // the same condition already decided once above.
  //
  // WHY NOT NIGHTLY'S THREE-WAY CHOICE. The nightly uninstaller asks per connector
  // for detach / uninstall / reassign:<profile> and removes the package only on
  // `uninstall`. v3 has no such lifecycle question and inventing one here would be
  // deciding scope in a patch. What v3 DOES have is the operator's explicit yes to
  // "remove its attachment too", which is a narrower thing than nightly's
  // `uninstall` — so this stays behind the last-daemon condition rather than
  // standing on the confirmation alone. A connector detached while another daemon
  // survives keeps its package, because that daemon may still be using it.
  const connectors = detachedComponents
    .map((key) => CONNECTOR_PACKAGES[key])
    .filter(Boolean);
  return {
    action: 'remove',
    packages: ['@ours.network/cli', '@ours.network/mcp', ...pluginPackages, ...connectors],
    stillNeededBy: [],
  };
}

// -----------------------------------------------------------------------------
// Harness plugins written by the installer
// -----------------------------------------------------------------------------

/**
 * The sentinels the plugin installers stamp around everything they write. They
 * are the ONLY thing that makes a block removable: without them we would be
 * editing a config file on a guess.
 */
export const YAML_BLOCK = { start: '# >>> ours.network plugin (managed block)', end: '# <<< ours.network plugin' };
export const MD_BLOCK = { start: '<!-- >>> ours.network plugin (managed block) -->', end: '<!-- <<< ours.network plugin -->' };

/**
 * Remove OUR block from a config file, or refuse.
 *
 * SAME IDENTIFICATION DISCIPLINE AS THE SYSTEMD UNIT, and for the same reason.
 * The installer refuses to overwrite a unit it cannot positively identify rather
 * than guessing; this refuses to edit a config it cannot positively identify.
 * Three outcomes, and the third is the one that matters:
 *
 *   absent  — no start sentinel. The file is not ours to edit; left untouched.
 *   strip   — both sentinels present. Exactly the delimited span is removed.
 *   refuse  — a start sentinel with NO end. v2 deleted to end-of-file here,
 *             which would take everything the user added after our block with
 *             it. An unterminated block is damage we cannot bound, so it is
 *             reported and left alone.
 */
export function stripManagedBlock(text, markers) {
  if (typeof text !== 'string' || !text.includes(markers.start)) {
    return { action: 'absent', reason: 'no ours managed block in this file' };
  }
  const lines = text.split('\n');
  const out = [];
  let inside = false;
  let closed = false;
  for (const line of lines) {
    if (!inside && line.includes(markers.start)) { inside = true; continue; }
    if (inside) {
      if (line.includes(markers.end)) { inside = false; closed = true; }
      continue;
    }
    out.push(line);
  }
  if (!closed) {
    return {
      action: 'refuse',
      reason: 'the ours managed block has no closing marker; refusing to guess where it ends',
    };
  }
  return { action: 'strip', text: out.join('\n') };
}

/**
 * The three harnesses this uninstaller knows, in the order they are offered.
 * Same names and same order as the nightly picker and as `canonHarnesses`, so a
 * selection written for one is a selection for the other.
 */
export const HARNESS_ORDER = ['claude-code', 'codex', 'hermes'];

/**
 * What the harness-plugin half of an uninstall removes.
 *
 * `lastDaemon` is the same condition planGlobalPackages decides on, passed in
 * rather than recomputed: while another daemon is still on this machine its
 * harnesses still need their plugins, so nothing here is touched at all.
 *
 * `explicitSelection` OVERRIDES that keep, and only that. The keep is a guess
 * made on the operator's behalf — "another daemon is here, so you probably still
 * want these". When the operator has named the harnesses themselves (the picker,
 * or OURS_UNINSTALL), the guess has been answered and must not outrank the
 * answer. Nothing else about the plan changes: WHICH of the discovered harnesses
 * are then acted on is decided by the caller, not here, so this stays the single
 * description of what exists on disk.
 *
 * Claude Code is deliberately manual-only. Its plugin lives in the in-app
 * marketplace, and there is no file on disk we own — so this prints the two
 * commands and claims nothing, which is the same never-dead-end contract the
 * installer applies to a harness it cannot drive.
 *
 * Every path is EXACT — the precise file or directory the plugin installer
 * writes. Nothing here is a glob, and nothing walks a tree looking for matches.
 */
export function planPluginRemoval({ home, env = {}, exists = () => false, lastDaemon = true, explicitSelection = false } = {}) {
  const hermesDir = env.HERMES_DIR || join(home, '.hermes');
  const codexDir = env.CODEX_DIR || join(home, '.codex');
  const skillsDir = env.SKILLS_DIR || join(home, '.agents', 'skills');

  const manual = {
    key: 'claude-code',
    label: 'Claude Code plugin',
    action: 'manual',
    reason: "its plugin lives in Claude Code's in-app marketplace, so nothing on disk is ours to remove",
    steps: ['/plugin uninstall ours', '/plugin marketplace remove adapt-toolkit/ours-claude-marketplace'],
  };
  if (!lastDaemon && !explicitSelection) {
    return {
      action: 'keep',
      reason: 'another daemon on this machine still uses these plugins',
      harnesses: [],
      manual: [manual],
      packages: [],
    };
  }

  const harnesses = [];
  const hermesConfig = join(hermesDir, 'config.yaml');
  if (exists(hermesConfig) || exists(hermesDir)) {
    harnesses.push({
      key: 'hermes',
      label: 'Hermes plugin',
      blocks: [{ path: hermesConfig, markers: YAML_BLOCK }],
      dirs: [
        join(hermesDir, 'skills', 'communication', 'ours'),
        join(hermesDir, 'skills', 'communication', 'writing-agent-bios'),
      ],
      files: [join(hermesDir, 'ours-connector.env'), join(hermesDir, 'ours-connector.log')],
      pkg: '@ours.network/hermes',
    });
  }
  if (exists(join(codexDir, 'config.toml')) || exists(codexDir)) {
    harnesses.push({
      key: 'codex',
      label: 'Codex plugin',
      blocks: [
        { path: join(codexDir, 'config.toml'), markers: YAML_BLOCK },
        { path: join(codexDir, 'AGENTS.md'), markers: MD_BLOCK },
      ],
      dirs: [join(skillsDir, 'ours'), join(skillsDir, 'writing-agent-bios')],
      files: [],
      pkg: '@ours.network/codex',
    });
  }
  return {
    action: 'remove',
    harnesses,
    manual: [manual],
    packages: harnesses.map((h) => h.pkg),
  };
}

/**
 * Decide which harnesses to detach using the documented environment contract.
 *
 * The nightly uninstaller let the operator choose: a `checkboxSelect` picker on a
 * terminal, `OURS_UNINSTALL` without one, and NOTHING removed when it had
 * neither. v3 had no choice at all — it removed every plugin artefact it found
 * whenever this was the last daemon. A user who wanted to detach one harness had
 * no way to say so, and an unattended run removed plugins that leaving
 * `OURS_UNINSTALL` unset used to protect.
 *
 * This decides the three cases; the orchestrator only does the asking, so the
 * rule and the terminal I/O stay apart.
 *
 *   explicit — a selection was given (OURS_UNINSTALL, or the answers to the
 *              per-harness questions). Exactly those, intersected with what is
 *              actually there. A name for a harness that is not installed is
 *              reported as `ignored`, not silently dropped.
 *   keep     — unattended with no selection. Nothing is removed, and the caller
 *              says how to select. This is the conservative side: an uninstall
 *              nobody is watching does not decide on its own that a harness
 *              should lose its plugin.
 *   ask      — a terminal and no selection. One question per harness, DEFAULTING
 *              TO YES, because the daemon these plugins talk to is going away
 *              and a plugin left behind advertises tools that no longer resolve.
 *              An operator who just presses Enter gets exactly what v3 does
 *              today; the only new thing is that they can now say no.
 *
 * A checkbox picker would match nightly's chrome more closely, but the effects
 * contract this uninstaller runs on has `ask`, not `checkboxSelect` — and the
 * question here is which harnesses, not which widget.
 */
export function planHarnessSelection(plugins, { selection = null, assumeYes = false } = {}) {
  const offered = [...(plugins.manual ?? []), ...(plugins.harnesses ?? [])]
    .map((h) => ({ key: h.key, label: h.label }))
    .sort((a, b) => HARNESS_ORDER.indexOf(a.key) - HARNESS_ORDER.indexOf(b.key));
  if (selection !== null) {
    const keys = offered.map((o) => o.key);
    return {
      mode: 'explicit',
      offered,
      chosen: keys.filter((k) => selection.includes(k)),
      ignored: selection.filter((k) => !keys.includes(k)),
    };
  }
  if (assumeYes) {
    return {
      mode: 'keep',
      offered,
      chosen: [],
      ignored: [],
      reason: 'no OURS_UNINSTALL was set and there is nobody to ask',
      hint: `set OURS_UNINSTALL="${HARNESS_ORDER.join(' ')}" (or a subset, or "all") to remove harness plugins unattended`,
    };
  }
  return { mode: 'ask', offered, chosen: null, ignored: [] };
}

/**
 * Narrow a plugin plan to the chosen harnesses. Pure, so the orchestrator never
 * decides what "chosen" means to a plan — it only supplies the answers.
 *
 * `packages` follows the harnesses it narrows to: a plugin package belongs to
 * the harness that was removed, so a harness that was kept keeps its package.
 */
export function selectHarnesses(plugins, chosen) {
  const keep = (h) => chosen.includes(h.key);
  const harnesses = (plugins.harnesses ?? []).filter(keep);
  return {
    ...plugins,
    harnesses,
    manual: (plugins.manual ?? []).filter(keep),
    packages: harnesses.map((h) => h.pkg),
  };
}

/**
 * Preserve the full uninstall order, refusing before any mutation rather than stopping
 * half-way.
 */
export function planUninstall({ home, env = {}, endpoint, stateDir, purge = false, assumeYes = false, confirmedComponents = [], readJson, readText, exists = () => true, cliStartedIt = true, otherStateDirsWithConfig = [], typedConfirmation = null, explicitHarnessSelection = false, platform = 'linux' }) {
  const dir = resolve(stateDir);
  const lastDaemon = otherStateDirsWithConfig.map((d) => resolve(d)).filter((d) => d !== dir).length === 0;
  const plugins = planPluginRemoval({ home, env, exists, lastDaemon, explicitSelection: explicitHarnessSelection });

  // BEFORE the pointing question, and not resolvable by confirming anything: a
  // component config that will not parse cannot be proven not to name this
  // daemon. Fail closed, name the file, remove nothing. This mirrors the nightly
  // uninstaller's refusal (lib/nightly-uninstall.mjs:244) rather than inventing a
  // second wording for the same event.
  const unreadable = unreadableComponentConfigs({ home, env, readText });
  if (unreadable.length > 0) {
    return {
      action: 'refuse',
      exitCode: 2,
      reason: 'component-config-unreadable',
      components: unreadable,
      removed: [],
      message: `${unreadable.map((c) => `${c.config} is corrupt or unsafe to inspect${c.reason ? `: ${c.reason}` : ''}`).join('; ')}. Refusing to uninstall: a component config that cannot be read cannot be shown not to point at this daemon. Repair or move it, then re-run. Nothing was removed.`,
    };
  }

  const pointing = componentsPointingHere({ home, env, endpoint, stateDir: dir, readJson });
  const unconfirmed = pointing.filter((p) => !confirmedComponents.includes(p.key));
  if (unconfirmed.length > 0) {
    return {
      action: 'refuse',
      exitCode: 2,
      reason: 'component-still-points-here',
      components: unconfirmed,
      removed: [],
      message: `${unconfirmed.map((p) => p.key).join(' and ')} still point at this daemon. Repoint them, or confirm their removal in the same run. Nothing was removed.`,
    };
  }
  return {
    action: 'uninstall',
    stateDir: dir,
    detach: pointing.map((p) => ({ key: p.key, service: [`ours-${p.key === 'tg' ? 'tg-connector' : 'cowork'}`, 'uninstall-service'] })),
    daemon: planDaemonRemoval({ stateDir: dir, cliStartedIt }),
    state: planStatePurge({ stateDir: dir, purge, assumeYes, exists, typedConfirmation }),
    plugins,
    packages: planGlobalPackages({
      stateDir: dir,
      otherStateDirsWithConfig,
      pluginPackages: plugins.packages,
      // Only the components the operator explicitly confirmed removing — never
      // every component that merely happens to point here.
      detachedComponents: pointing.map((p) => p.key).filter((key) => confirmedComponents.includes(key)),
    }),
  };
}

// -----------------------------------------------------------------------------
// Non-interactive behavior
// -----------------------------------------------------------------------------

/**
 * What each question answers to under OURS_ASSUME_YES.
 *
 * The `false` entries are the point of the table: assume-yes never turns a
 * component on that was off, never MOVES one that already exists, never removes
 * a harness's plugin, and never deletes state. It suppresses questions; it does
 * not consent on the operator's behalf to anything irreversible or to anything
 * that changes where an existing component is pointing.
 *
 * `plugins: false` is the one that answers a question this uninstaller used to
 * answer the other way. A harness plugin is not this daemon's to give away
 * unasked, and the operator has a way to ask for it by name — OURS_UNINSTALL —
 * which is precisely the interface an unattended run should have to go through.
 */
export const NON_INTERACTIVE_ANSWERS = {
  daemon: true,
  mcp: true,
  tg: false,
  cowork: false,
  repointExistingConnector: false,
  plugins: false,
  purge: false,
};

/**
 * OURS_ASSUME_YES suppresses questions; it NEVER suppresses a refusal. Every
 * refusal in this specification applies unchanged in non-interactive mode and
 * exits 2 without writing anything.
 */
export function refusalSurvivesAssumeYes(refusal) {
  return refusal && refusal.action === 'refuse' ? { ...refusal, exitCode: 2 } : refusal;
}

// -----------------------------------------------------------------------------
// Documented OURS_UNINSTALL_* environment contract
// -----------------------------------------------------------------------------

/**
 * The seven variables. THIS IS A DOCUMENTED PUBLIC INTERFACE, not an internal
 * detail: all seven are in packages/installer/README.md, two of them are in
 * uninstall.sh's header as well, and somebody's unattended uninstall script is
 * written against them. v3 honoured none of them and said nothing, which is the
 * worst of the three available behaviours — a documented variable that quietly
 * does nothing is worse than one that errors, because the operator believes it
 * worked.
 *
 * Each is in exactly one of two categories, and which one is not a matter of
 * taste. A variable is HONOURED when v3 can deliver what it documents. A
 * variable is REFUSED — exit 2, nothing removed, naming the variable and naming
 * the replacement — when what it documents depends on something v3 does not
 * have. Nothing is silently ignored and nothing is silently obeyed.
 *
 * HONOURED
 *   OURS_UNINSTALL          which harness plugins to remove. Parsed by the same
 *                           canonHarnesses the nightly picker used, so names,
 *                           numbers, "all" and "none" all still mean what they
 *                           meant. Feeds item 9.5's selection.
 *   OURS_UNINSTALL_DAEMON   whether the daemon goes. See below — this is the one
 *                           that matters most.
 *   OURS_UNINSTALL_TELEGRAM
 *   OURS_UNINSTALL_ROOMS    at the value `detach`, which is exactly the
 *                           confirmation that the interactive flow asks a human for and which an
 *                           unattended run otherwise cannot give, so today the
 *                           run refuses instead of detaching.
 *
 * REFUSED
 *   OURS_UNINSTALL_DATA=yes         v3 never deletes state without a human
 *                                   present; that rule protects private
 *                                   keys that exist nowhere else.
 *   OURS_UNINSTALL_PROFILE          names an entry in the daemon registry. v3
 *                                   has no registry; the selector is --state-dir.
 *   OURS_UNINSTALL_FORGET_PROFILE   asks to forget a daemon as metadata while it
 *                                   keeps running. v3 has no metadata to forget.
 *   OURS_UNINSTALL_TELEGRAM/_ROOMS  at `uninstall` (v3 detaches, it does not
 *                                   remove connector packages) or
 *                                   `reassign:<profile-id>` (again the registry).
 *
 * WHY THE WHOLE CONTRACT ENGAGES OR NONE OF IT DOES. v2 gated on
 * `OURS_UNINSTALL != null || OURS_UNINSTALL_DATA || OURS_UNINSTALL_DAEMON` and
 * then asked nothing at all. That gate is kept exactly: with none of the seven
 * set, `ours-uninstall` behaves precisely as it does today, so the blast radius
 * of this whole change is "an operator who set one of the documented variables".
 *
 * AND THE ESCALATION THIS CLOSES. Before this, `OURS_UNINSTALL="hermes"` — a
 * script that asked for ONE HARNESS PLUGIN to be removed — reached v3, which
 * read none of it, and removed THE DAEMON: its service, its process, and the
 * global packages. Honouring OURS_UNINSTALL_DAEMON is what makes a request to
 * detach a plugin stay a request to detach a plugin.
 */
export const UNINSTALL_ENV_VARS = [
  'OURS_UNINSTALL',
  'OURS_UNINSTALL_PROFILE',
  'OURS_UNINSTALL_FORGET_PROFILE',
  'OURS_UNINSTALL_DAEMON',
  'OURS_UNINSTALL_DATA',
  'OURS_UNINSTALL_TELEGRAM',
  'OURS_UNINSTALL_ROOMS',
];

/**
 * Is the contract engaged at all? PRESENCE, not truth — `OURS_UNINSTALL=""` is a
 * deliberate "no harnesses", exactly as v2's `!= null` read it, and is not the
 * same as never having set it.
 */
export function uninstallEnvEngaged(env = {}) {
  return UNINSTALL_ENV_VARS.some((name) => env[name] !== undefined && env[name] !== null);
}

const CONNECTOR_VARS = [
  { name: 'OURS_UNINSTALL_TELEGRAM', key: 'tg', pkg: '@ours.network/tg-connector' },
  { name: 'OURS_UNINSTALL_ROOMS', key: 'cowork', pkg: '@ours.network/cowork' },
];

function connectorRefusal(name, value, pkg) {
  if (value === 'uninstall') {
    return `${name}=uninstall asks for the connector's global package to be removed as well; this uninstaller detaches a connector, it does not uninstall one. Use ${name}=detach, then 'npm rm -g ${pkg}' yourself.`;
  }
  if (value.startsWith('reassign:')) {
    return `${name}=${value} asks for the connector to be pointed at another daemon by profile id. This uninstaller has no profile registry, so there is no id it could resolve. Point the connector at the daemon you want first — 'ours-install --state-dir <path>' — and then re-run this uninstall.`;
  }
  return `${name}=${value} is not a value this uninstaller understands. The only supported value is 'detach'.`;
}

/**
 * Read the contract, or refuse it. Pure: the caller passes the environment in.
 *
 * A refusal is returned rather than thrown, in the same shape planUninstall uses
 * for its own refusals, so the orchestrator has one thing to print and one exit
 * code to return — and so a test can assert the whole set of refusals at once
 * instead of catching them one at a time.
 */
export function parseUninstallEnv(env = {}) {
  const engaged = uninstallEnvEngaged(env);
  const value = (name) => (typeof env[name] === 'string' ? env[name].trim() : '');
  const refusals = [];

  if (value('OURS_UNINSTALL_DATA') === 'yes') {
    refusals.push({
      variable: 'OURS_UNINSTALL_DATA',
      value: 'yes',
      message: "OURS_UNINSTALL_DATA=yes asks this uninstaller to delete a state directory with nobody present. It will not: that directory holds identity private keys that exist nowhere else and that no peer can give back, and state is never deleted in an unattended run. To delete it, run 'ours-uninstall --state-dir <dir> --purge' from a terminal and type the full path when it asks.",
    });
  }
  const profile = value('OURS_UNINSTALL_PROFILE');
  if (profile) {
    refusals.push({
      variable: 'OURS_UNINSTALL_PROFILE',
      value: profile,
      message: `OURS_UNINSTALL_PROFILE=${profile} names an entry in the daemon profile registry, which this uninstaller does not have — there is no profile to select. Choose the daemon by its state directory instead: 'ours-uninstall --state-dir <path>'.`,
    });
  }
  if (value('OURS_UNINSTALL_FORGET_PROFILE') === 'yes') {
    refusals.push({
      variable: 'OURS_UNINSTALL_FORGET_PROFILE',
      value: 'yes',
      message: 'OURS_UNINSTALL_FORGET_PROFILE=yes asks for a daemon to be forgotten as metadata while it keeps running. This uninstaller keeps no registry of daemons, so there is nothing to forget and nothing it could do that would match that request — a daemon it is not pointed at is already left entirely alone.',
    });
  }

  const components = {};
  for (const connector of CONNECTOR_VARS) {
    const raw = value(connector.name);
    if (!raw) continue;
    if (raw === 'detach') { components[connector.key] = 'detach'; continue; }
    refusals.push({
      variable: connector.name,
      value: raw,
      message: connectorRefusal(connector.name, raw, connector.pkg),
    });
  }

  const canon = engaged ? canonHarnesses(env.OURS_UNINSTALL ?? '') : null;
  // A token we cannot map is a request we cannot deliver. The nightly picker
  // reported these and carried on, which under an unattended run means
  // OURS_UNINSTALL="hermez" removes nothing and says so into a log nobody reads.
  // Same rule as the rest of this contract: name it, refuse, remove nothing.
  for (const token of canon?.unknown ?? []) {
    refusals.push({
      variable: 'OURS_UNINSTALL',
      value: token,
      message: `OURS_UNINSTALL names "${token}", which is not a harness this uninstaller knows. Use ${HARNESS_ORDER.join(', ')}, or "all", or "none".`,
    });
  }

  const contract = {
    engaged,
    // Not engaged means "decide this the way you always did": null selection, and
    // the daemon removal that IS this command.
    harnesses: canon ? canon.names : null,
    unknownHarnessTokens: canon ? canon.unknown : [],
    daemon: engaged ? value('OURS_UNINSTALL_DAEMON') === 'yes' : true,
    confirmedComponents: Object.keys(components),
  };
  if (refusals.length === 0) return contract;
  return {
    ...contract,
    action: 'refuse',
    exitCode: 2,
    reason: 'uninstall-env-unsupported',
    refusals,
    message: `${refusals.map((r) => r.message).join('\n')}\nNothing was removed.`,
  };
}
