// ours-uninstall v3 stage 5 — removing one daemon and handling non-interactive
// requests. Pure: file reads are injected. Nothing is removed,
// stopped or deleted by any test here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  STATE_DIR_EVIDENCE, looksLikeStateDir, componentsPointingHere,
  planComponentDetach, planDaemonRemoval, planStatePurge, planGlobalPackages,
  planUninstall, NON_INTERACTIVE_ANSWERS, refusalSurvivesAssumeYes,
  stripManagedBlock, planPluginRemoval, YAML_BLOCK,
  inspectComponentConfig, unreadableComponentConfigs,
  planHarnessSelection, selectHarnesses, HARNESS_ORDER,
  parseUninstallEnv, uninstallEnvEngaged, UNINSTALL_ENV_VARS,
} from '../lib/uninstall.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const TG = resolve(HOME, '.ours-tg');
const TG_CFG = join(HOME, '.ours-telegram', 'config.json');
const COWORK_CFG = join(HOME, '.ours-cowork', 'config.json');
const files = (map) => (path) => (Object.prototype.hasOwnProperty.call(map, path) ? map[path] : null);
const isStateDir = () => true;   // every purge test targets a real state dir unless it says otherwise
const notStateDir = () => false;

// ------------------------------------------------ referenced components — the refusal ----

test('a component still pointing here stops the run before anything is removed', () => {
  const readJson = files({ [TG_CFG]: { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS, botToken: 's' } });
  const p = planUninstall({ home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, readJson });
  assert.equal(p.action, 'refuse');
  assert.equal(p.exitCode, 2);
  assert.equal(p.reason, 'component-still-points-here');
  assert.deepEqual(p.removed, [], 'nothing removed');
  assert.match(p.message, /Nothing was removed/);
});

test('EITHER half of the pair is enough to catch a component', () => {
  // A half-written pair should still be caught: the whole point of the pair is
  // that neither half alone is trustworthy.
  const byStateDir = componentsPointingHere({ home: HOME, endpoint: 'http://127.0.0.1:9999', stateDir: OURS, readJson: files({ [TG_CFG]: { daemonStateDir: OURS } }) });
  assert.equal(byStateDir.length, 1);
  const byEndpoint = componentsPointingHere({ home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, readJson: files({ [TG_CFG]: { daemonUrl: 'http://127.0.0.1:3050' } }) });
  assert.equal(byEndpoint.length, 1);
});

test('cowork is caught through its daemon block', () => {
  const found = componentsPointingHere({
    home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS,
    readJson: files({ [COWORK_CFG]: { stateDir: '/home/me/.ours-cowork', daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: OURS } } }),
  });
  assert.deepEqual(found.map((f) => f.key), ['cowork']);
});

test("a component pointing at a DIFFERENT daemon does not block this uninstall", () => {
  const readJson = files({ [TG_CFG]: { daemonUrl: 'http://127.0.0.1:3051', daemonStateDir: TG } });
  const p = planUninstall({ home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, readJson });
  assert.equal(p.action, 'uninstall');
});

test('confirming a component in the same run lets the uninstall proceed', () => {
  const readJson = files({ [TG_CFG]: { daemonStateDir: OURS } });
  const p = planUninstall({ home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, readJson, confirmedComponents: ['tg'] });
  assert.equal(p.action, 'uninstall');
  assert.deepEqual(p.detach.map((d) => d.key), ['tg']);
});

// ---------------------------------------------------------- detach, keep file --

test('detaching the connector removes only the daemon keys and KEEPS the file', () => {
  const p = planComponentDetach('tg', { daemonUrl: 'http://x', daemonStateDir: OURS, botToken: 'secret', stt: { provider: 'x' } });
  assert.deepEqual(p.removed.sort(), ['daemonStateDir', 'daemonUrl']);
  assert.equal(p.keepsFile, true, 'the file also holds the operator bot token and settings');
  assert.equal(p.config.botToken, 'secret');
  assert.deepEqual(p.config.stt, { provider: 'x' });
  assert.ok(!('daemonUrl' in p.config));
});

test('detaching cowork is a BEHAVIOUR CHANGE and says so before it happens', () => {
  const p = planComponentDetach('cowork', { stateDir: '/home/me/.ours-cowork', daemon: { mode: 'external' }, theme: 'dark' });
  assert.equal(p.behaviourChange, 'cowork returns to embedded mode');
  assert.equal(p.config.stateDir, '/home/me/.ours-cowork', "cowork's own state key is not the daemon's");
  assert.equal(p.config.theme, 'dark');
  assert.equal(planComponentDetach('cowork', { theme: 'dark' }).behaviourChange, null, 'no block, no change to announce');
});

// --------------------------------------------------------- service, daemon --

test('the boot service and the daemon delegate their refusals rather than reimplementing them', () => {
  const [service, stop] = planDaemonRemoval({ stateDir: TG, cliStartedIt: true });
  assert.equal(service.unit, 'ours-tg.service', 'this daemon\'s unit, not the default one');
  assert.deepEqual(service.command, [
    'ours', 'daemon', 'uninstall-service', '--yes', '--state-dir', TG,
    '--config', join(TG, 'config.json'),
  ]);
  assert.deepEqual(stop.command, [
    'ours', 'daemon', 'stop', '--state-dir', TG,
    '--config', join(TG, 'config.json'),
  ]);
});

test('a daemon the CLI did not start is named, not signalled, and the run continues', () => {
  const [, stop] = planDaemonRemoval({ stateDir: OURS, cliStartedIt: false });
  assert.equal(stop.id, 'stop-external');
  assert.equal(stop.command, null, 'ours daemon stop refuses to signal a daemon it did not start');
  assert.equal(stop.continues, true, 'someone else supervising it is not a failure of this uninstall');
});

// ----------------------------------------------------------- state, purged --

test('state is KEPT by default, with the hint', () => {
  const p = planStatePurge({ stateDir: OURS, exists: isStateDir });
  assert.equal(p.action, 'keep');
  assert.match(p.hint, /--purge/);
});

test('PURGE MEANS PURGE: provenance is not a gate — any state directory qualifies', () => {
  // A hand-made or pre-existing ~/.ours is purged like any
  // other; the installer does not ask whether it made the directory.
  const p = planStatePurge({ stateDir: OURS, purge: true, exists: isStateDir, typedConfirmation: OURS });
  assert.equal(p.action, 'purge');
});

test('but a directory that is not a state directory at all is refused', () => {
  // This is NOT provenance re-entering by the back door: it asks "is this a state
  // directory", not "is it ours". With provenance gone, the typed path would
  // otherwise be the only thing between `--state-dir ~ --purge` and a deleted
  // home directory — and a typed path is no protection against a path typed
  // exactly as intended but meant differently.
  const p = planStatePurge({ stateDir: '/home/me', purge: true, exists: notStateDir, typedConfirmation: '/home/me' });
  assert.equal(p.action, 'keep');
  assert.match(p.reason, /does not look like an ours state directory/);
  assert.deepEqual(STATE_DIR_EVIDENCE, ['config.json', 'daemon-token', 'ours-cli-daemon.json', 'root.json']);
  assert.equal(looksLikeStateDir(OURS, (f) => f.endsWith('daemon-token')), true, 'any one artefact is enough');
  assert.equal(looksLikeStateDir(OURS, () => false), false);
});

test('--purge is never taken non-interactively', () => {
  const p = planStatePurge({ stateDir: OURS, purge: true, assumeYes: true, exists: isStateDir, typedConfirmation: OURS });
  assert.equal(p.action, 'keep');
  assert.match(p.reason, /never deleted non-interactively/);
  assert.equal(NON_INTERACTIVE_ANSWERS.purge, false);
});

test('--purge demands the full path TYPED, not a y/N', () => {
  const asked = planStatePurge({ stateDir: OURS, purge: true, exists: isStateDir });
  assert.equal(asked.action, 'confirm-typed');
  assert.equal(asked.expected, OURS);
  assert.match(asked.prompt, new RegExp(OURS.replace(/[.]/g, '\\.')), 'the prompt names the directory it will destroy');
  assert.match(asked.prompt, /identity keys and message history/);
  assert.match(asked.prompt, /exist nowhere else and no peer can give them back/);
  for (const wrong of ['y', 'yes', '', '/home/me/.our', `${OURS}/`]) {
    assert.equal(planStatePurge({ stateDir: OURS, purge: true, exists: isStateDir, typedConfirmation: wrong }).action, 'confirm-typed', `${JSON.stringify(wrong)} must not pass`);
  }
});

test('all four gates open → the exact directory, never a parent or a glob', () => {
  const p = planStatePurge({ stateDir: OURS, purge: true, exists: isStateDir, typedConfirmation: OURS });
  assert.equal(p.action, 'purge');
  assert.deepEqual(p.paths, [OURS]);
  assert.ok(!p.paths.some((x) => x.includes('*')), 'no globs');
  assert.ok(!p.paths.includes(HOME), 'never the parent');
});

// ---------------------------------------------------------- global packages --

test('global packages are kept while another daemon still needs them', () => {
  const p = planGlobalPackages({ stateDir: OURS, otherStateDirsWithConfig: [OURS, TG] });
  assert.equal(p.action, 'keep');
  assert.deepEqual(p.stillNeededBy, [TG]);
  assert.match(p.reason, /still used by the daemon at/);
});

test('global packages are removed only when this was the last daemon', () => {
  const p = planGlobalPackages({ stateDir: OURS, otherStateDirsWithConfig: [OURS] });
  assert.equal(p.action, 'remove');
  assert.deepEqual(p.packages, ['@ours.network/cli', '@ours.network/mcp']);
});

// ---------------------------------------------------------- non-interactive behavior ------

test('assume-yes never turns a component on, never moves one, never deletes state', () => {
  assert.deepEqual(NON_INTERACTIVE_ANSWERS, {
    daemon: true, mcp: true, tg: false, cowork: false, repointExistingConnector: false, plugins: false, purge: false,
  });
});

test('assume-yes suppresses questions, never a refusal', () => {
  const refusal = { action: 'refuse', reason: 'component-still-points-here' };
  assert.equal(refusalSurvivesAssumeYes(refusal).exitCode, 2);
  assert.equal(refusalSurvivesAssumeYes({ action: 'uninstall' }).exitCode, undefined);
});

// -------------------------------------------- the harness plugins we wrote ---

test('a managed block is removed only when BOTH sentinels are found', () => {
  const file = `keep me\n${YAML_BLOCK.start}\nours: stuff\n${YAML_BLOCK.end}\nkeep me too\n`;
  const r = stripManagedBlock(file, YAML_BLOCK);
  assert.equal(r.action, 'strip');
  assert.equal(r.text, 'keep me\nkeep me too\n');
});

test('a file with no ours block is left completely alone', () => {
  const r = stripManagedBlock('somebody else’s config\n', YAML_BLOCK);
  assert.equal(r.action, 'absent');
});

test('an UNTERMINATED ours block is refused, not truncated to end of file', () => {
  // v2 deleted to EOF here, which takes everything the user wrote after our
  // block with it. Damage we cannot bound is damage we do not do.
  const file = `keep me\n${YAML_BLOCK.start}\nours: stuff\ntheir own settings\n`;
  const r = stripManagedBlock(file, YAML_BLOCK);
  assert.equal(r.action, 'refuse');
  assert.match(r.reason, /no closing marker/);
});

test('plugin removal is skipped entirely while another daemon still needs the plugins', () => {
  const plan = planPluginRemoval({ home: HOME, exists: () => true, lastDaemon: false });
  assert.equal(plan.action, 'keep');
  assert.deepEqual(plan.harnesses, []);
  assert.deepEqual(plan.packages, []);
  assert.equal(plan.manual.length, 1, 'Claude Code is still told how to remove its own plugin');
});

test('plugin removal names exact paths, never a glob or a parent', () => {
  const plan = planPluginRemoval({ home: HOME, exists: () => true, lastDaemon: true });
  const all = plan.harnesses.flatMap((h) => [...h.dirs, ...h.files, ...h.blocks.map((b) => b.path)]);
  assert.ok(all.length > 0);
  for (const p of all) {
    assert.ok(!p.includes('*'), `never a glob: ${p}`);
    assert.ok(p.startsWith(HOME) && p !== HOME, `never the home directory itself: ${p}`);
  }
  assert.deepEqual(plan.packages.sort(), ['@ours.network/codex', '@ours.network/hermes']);
});

test('Claude Code is manual-only, and the run says so rather than pretending', () => {
  const plan = planPluginRemoval({ home: HOME, exists: () => false, lastDaemon: true });
  assert.deepEqual(plan.harnesses, [], 'nothing on disk, nothing removed');
  assert.equal(plan.manual[0].key, 'claude-code');
  assert.deepEqual(plan.manual[0].steps, ['/plugin uninstall ours', '/plugin marketplace remove adapt-toolkit/ours-claude-marketplace']);
});

test('the plugin packages follow the SAME rule as the daemon packages, not a second one', () => {
  const kept = planGlobalPackages({ stateDir: OURS, otherStateDirsWithConfig: [TG], pluginPackages: ['@ours.network/hermes'] });
  assert.equal(kept.action, 'keep');
  assert.deepEqual(kept.packages, [], 'one condition decides all of them');

  const removed = planGlobalPackages({ stateDir: OURS, otherStateDirsWithConfig: [], pluginPackages: ['@ours.network/hermes'] });
  assert.deepEqual(removed.packages, ['@ours.network/cli', '@ours.network/mcp', '@ours.network/hermes']);
});

// ----------------------------------------------- the config we CANNOT read -------
//
// THE DEFECT THESE PIN. effects.readJson swallows every failure into `null`, so a
// corrupt ~/.ours-telegram/config.json read as "no connector points at this
// daemon": step 1's refusal never fired and the daemon was removed out from under
// a connector that may still have been using it. The nightly uninstaller refuses
// here (lib/nightly-uninstall.mjs:22,244) and has a test pinning that it does.
// Fail closed: "cannot prove it does not point here" is not "does not point here".

test('a corrupt component config REFUSES the uninstall instead of reading as absent', () => {
  const readText = files({ [TG_CFG]: '{ "daemonStateDir": "/home/me/.ours"' });   // truncated
  const readJson = files({});                                                     // exactly what readJson does with it
  const p = planUninstall({ home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, readJson, readText });
  assert.equal(p.action, 'refuse');
  assert.equal(p.exitCode, 2);
  assert.equal(p.reason, 'component-config-unreadable');
  assert.deepEqual(p.removed, []);
  assert.deepEqual(p.components.map((c) => c.key), ['tg']);
  assert.match(p.message, /corrupt or unsafe to inspect/);
  assert.match(p.message, /Nothing was removed/);
});

test('the unreadable refusal cannot be resolved by confirming the component', () => {
  // A component that points here can be confirmed for removal in the same run. A
  // config that will not parse cannot be confirmed away by anyone — nothing about
  // its contents is known. The operator has to fix or move the file first.
  const readText = files({ [COWORK_CFG]: 'not json at all' });
  const p = planUninstall({
    home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS,
    readJson: files({}), readText, confirmedComponents: ['tg', 'cowork'],
  });
  assert.equal(p.reason, 'component-config-unreadable');
  assert.deepEqual(p.components.map((c) => c.key), ['cowork']);
});

test('a corrupt config refuses even when it plainly names ANOTHER daemon', () => {
  // Fail closed on the file, not on its contents: we cannot read the contents.
  const readText = files({ [TG_CFG]: '{"daemonStateDir": "/somewhere/else",' });
  const p = planUninstall({ home: HOME, endpoint: 'http://127.0.0.1:9999', stateDir: TG, readJson: files({}), readText });
  assert.equal(p.reason, 'component-config-unreadable');
});

test('an ABSENT component config is not corrupt, and an unattended run still proceeds', () => {
  const p = planUninstall({
    home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS,
    readJson: files({}), readText: files({}), assumeYes: true, exists: isStateDir,
  });
  assert.equal(p.action, 'uninstall', 'no file is not the same as an unreadable file');
});

test('inspectComponentConfig tells absent, ok and corrupt apart', () => {
  const readText = files({
    [TG_CFG]: '{"daemonUrl": "http://127.0.0.1:3050"}',
    [COWORK_CFG]: '',
  });
  assert.equal(inspectComponentConfig(TG_CFG, { readText }).state, 'ok');
  assert.equal(inspectComponentConfig(COWORK_CFG, { readText }).state, 'corrupt',
    'an EMPTY existing file is corrupt, not absent — the nightly reader parses whatever exists');
  assert.equal(inspectComponentConfig(join(HOME, 'nope.json'), { readText }).state, 'absent');
  assert.equal(inspectComponentConfig(TG_CFG, {}).state, 'unknown',
    'with no text reader the answer is unknown, never a silent "fine"');
});

test('a JSON array or scalar in a component config is corrupt, not a config', () => {
  const readText = files({ [TG_CFG]: '[1,2,3]', [COWORK_CFG]: '"a string"' });
  assert.deepEqual(
    unreadableComponentConfigs({ home: HOME, readText }).map((c) => c.key),
    ['tg', 'cowork'],
  );
});

test('without a text reader the unreadable check reports nothing rather than guessing', () => {
  assert.deepEqual(unreadableComponentConfigs({ home: HOME }), []);
});

// -------------------------- the connector packages (10.5) --------------------

test("a confirmed connector's global package goes with it, when this was the last daemon", () => {
  const p = planGlobalPackages({ stateDir: OURS, otherStateDirsWithConfig: [], detachedComponents: ['tg'] });
  assert.deepEqual(p.packages, ['@ours.network/cli', '@ours.network/mcp', '@ours.network/tg-connector']);
});

test('a connector detached while ANOTHER daemon survives keeps its package', () => {
  // That daemon may still be using it. One condition decides every package here,
  // not a second rule for connectors.
  const p = planGlobalPackages({ stateDir: OURS, otherStateDirsWithConfig: [TG], detachedComponents: ['tg', 'cowork'] });
  assert.equal(p.action, 'keep');
  assert.deepEqual(p.packages, []);
});

test('a connector that was never confirmed keeps its package even on the last daemon', () => {
  const p = planGlobalPackages({ stateDir: OURS, otherStateDirsWithConfig: [], detachedComponents: [] });
  assert.deepEqual(p.packages, ['@ours.network/cli', '@ours.network/mcp']);
});

test('confirmed connectors reach the package list through the whole plan', () => {
  const readJson = files({
    [TG_CFG]: { daemonStateDir: OURS },
    [COWORK_CFG]: { daemon: { endpoint: 'http://127.0.0.1:3050', stateDir: OURS } },
  });
  const p = planUninstall({
    home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, readJson,
    confirmedComponents: ['tg', 'cowork'], otherStateDirsWithConfig: [], exists: isStateDir,
  });
  assert.equal(p.action, 'uninstall');
  assert.ok(p.packages.packages.includes('@ours.network/tg-connector'));
  assert.ok(p.packages.packages.includes('@ours.network/cowork'));
});

test('a component pointing here that was NOT confirmed refuses before packages are considered', () => {
  // Which is why "confirmed but only pointing" is unreachable through the whole
  // plan: step 1 stops the run first. The discrimination is still pinned directly
  // on planGlobalPackages above, where it is reachable.
  const readJson = files({
    [TG_CFG]: { daemonStateDir: OURS },
    [COWORK_CFG]: { daemon: { endpoint: 'http://127.0.0.1:3050', stateDir: OURS } },
  });
  const p = planUninstall({
    home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, readJson,
    confirmedComponents: ['tg'], otherStateDirsWithConfig: [], exists: isStateDir,
  });
  assert.equal(p.action, 'refuse');
  assert.deepEqual(p.components.map((c) => c.key), ['cowork']);
});

// ------------------------ item 9.5 — choosing which harnesses to detach ------

test('a named selection removes exactly those harnesses, and their packages follow them', () => {
  const found = planPluginRemoval({ home: HOME, exists: () => true, lastDaemon: true });
  const choice = planHarnessSelection(found, { selection: ['codex'] });
  assert.equal(choice.mode, 'explicit');
  assert.deepEqual(choice.chosen, ['codex']);

  const narrowed = selectHarnesses(found, choice.chosen);
  assert.deepEqual(narrowed.harnesses.map((h) => h.key), ['codex']);
  assert.deepEqual(narrowed.packages, ['@ours.network/codex'],
    'the kept harness keeps its launcher — removing it would break a plugin that is still registered');
  assert.deepEqual(narrowed.manual, [], 'Claude Code was not named, so its removal is not announced');
});

test('a harness named for removal that is not installed is REPORTED, not silently dropped', () => {
  // exists() false everywhere: no Hermes or Codex files on this machine.
  const found = planPluginRemoval({ home: HOME, exists: () => false, lastDaemon: true });
  const choice = planHarnessSelection(found, { selection: ['hermes', 'claude-code'] });
  assert.deepEqual(choice.chosen, ['claude-code']);
  assert.deepEqual(choice.ignored, ['hermes']);
});

test('unattended with no selection keeps every plugin, and says how to select one', () => {
  const found = planPluginRemoval({ home: HOME, exists: () => true, lastDaemon: true });
  const choice = planHarnessSelection(found, { selection: null, assumeYes: true });
  assert.equal(choice.mode, 'keep');
  assert.deepEqual(choice.chosen, [], 'a run nobody is watching does not decide this on its own');
  assert.match(choice.hint, /OURS_UNINSTALL=/);
});

test('a terminal with no selection is ASKED, one question per harness, in a stable order', () => {
  const found = planPluginRemoval({ home: HOME, exists: () => true, lastDaemon: true });
  const choice = planHarnessSelection(found, { selection: null, assumeYes: false });
  assert.equal(choice.mode, 'ask');
  assert.equal(choice.chosen, null, 'nothing is chosen until the operator answers');
  assert.deepEqual(choice.offered.map((h) => h.key), HARNESS_ORDER);
});

test('an explicit selection outranks the another-daemon keep, which was a guess on the operator’s behalf', () => {
  const guessed = planPluginRemoval({ home: HOME, exists: () => true, lastDaemon: false });
  assert.equal(guessed.action, 'keep', 'unasked, a second daemon keeps the plugins');

  const answered = planPluginRemoval({ home: HOME, exists: () => true, lastDaemon: false, explicitSelection: true });
  assert.equal(answered.action, 'remove');
  assert.deepEqual(answered.harnesses.map((h) => h.key).sort(), ['codex', 'hermes'],
    'the operator named them, so the guess does not get to answer over them');
});

// ---------- item 10.9 — the seven documented OURS_UNINSTALL_* variables ------

test('all seven documented variables are accounted for, none quietly dropped', () => {
  assert.deepEqual(UNINSTALL_ENV_VARS, [
    'OURS_UNINSTALL', 'OURS_UNINSTALL_PROFILE', 'OURS_UNINSTALL_FORGET_PROFILE',
    'OURS_UNINSTALL_DAEMON', 'OURS_UNINSTALL_DATA', 'OURS_UNINSTALL_TELEGRAM',
    'OURS_UNINSTALL_ROOMS',
  ]);
  for (const name of UNINSTALL_ENV_VARS) {
    assert.equal(uninstallEnvEngaged({ [name]: 'x' }), true, `${name} engages the contract`);
  }
  assert.equal(uninstallEnvEngaged({}), false);
  assert.equal(uninstallEnvEngaged({ OURS_UNINSTALL: '' }), true,
    'an empty OURS_UNINSTALL is a deliberate "no harnesses", not an unset variable');
});

test('with none of the seven set, nothing about the run changes', () => {
  const c = parseUninstallEnv({ OURS_ASSUME_YES: '1', HOME: '/home/me' });
  assert.equal(c.engaged, false);
  assert.equal(c.daemon, true, 'ours-uninstall still removes the daemon it is pointed at');
  assert.equal(c.harnesses, null, 'and still decides the harnesses the way it always did');
  assert.equal(c.action, undefined);
});

test('OURS_UNINSTALL is parsed the way the nightly picker parsed it', () => {
  assert.deepEqual(parseUninstallEnv({ OURS_UNINSTALL: 'hermes,codex' }).harnesses, ['hermes', 'codex']);
  assert.deepEqual(parseUninstallEnv({ OURS_UNINSTALL: 'all' }).harnesses, ['claude-code', 'codex', 'hermes']);
  assert.deepEqual(parseUninstallEnv({ OURS_UNINSTALL: '1 3' }).harnesses, ['claude-code', 'hermes']);
  assert.deepEqual(parseUninstallEnv({ OURS_UNINSTALL: 'none' }).harnesses, []);
});

test('OURS_UNINSTALL alone does NOT remove the daemon — that needs OURS_UNINSTALL_DAEMON', () => {
  // The escalation this closes: a script asking for one harness plugin used to
  // reach v3, which read none of these, and tore down the daemon instead.
  assert.equal(parseUninstallEnv({ OURS_UNINSTALL: 'hermes' }).daemon, false);
  assert.equal(parseUninstallEnv({ OURS_UNINSTALL: 'hermes', OURS_UNINSTALL_DAEMON: 'yes' }).daemon, true);
  assert.equal(parseUninstallEnv({ OURS_UNINSTALL_DAEMON: 'no' }).daemon, false);
});

test('OURS_UNINSTALL_DATA=yes is REFUSED by name, and told where to go instead', () => {
  const c = parseUninstallEnv({ OURS_UNINSTALL_DATA: 'yes' });
  assert.equal(c.action, 'refuse');
  assert.equal(c.exitCode, 2);
  assert.equal(c.reason, 'uninstall-env-unsupported');
  assert.deepEqual(c.refusals.map((r) => r.variable), ['OURS_UNINSTALL_DATA']);
  assert.match(c.message, /--purge/, 'names the replacement, not just the problem');
  assert.match(c.message, /Nothing was removed/);
});

test('OURS_UNINSTALL_DATA=no is not a refusal — it asks for what already happens', () => {
  assert.equal(parseUninstallEnv({ OURS_UNINSTALL_DATA: 'no' }).action, undefined);
});

test('the registry variables are refused, because there is no registry', () => {
  const profile = parseUninstallEnv({ OURS_UNINSTALL_PROFILE: 'blue' });
  assert.equal(profile.action, 'refuse');
  assert.match(profile.message, /--state-dir/, 'the state directory is what selects a daemon now');

  const forget = parseUninstallEnv({ OURS_UNINSTALL_FORGET_PROFILE: 'yes' });
  assert.equal(forget.action, 'refuse');
});

test('a connector lifecycle of detach is honoured; uninstall and reassign are refused', () => {
  const detach = parseUninstallEnv({ OURS_UNINSTALL_TELEGRAM: 'detach', OURS_UNINSTALL_ROOMS: 'detach' });
  assert.equal(detach.action, undefined);
  assert.deepEqual(detach.confirmedComponents, ['tg', 'cowork']);

  const pkg = parseUninstallEnv({ OURS_UNINSTALL_TELEGRAM: 'uninstall' });
  assert.equal(pkg.action, 'refuse');
  assert.match(pkg.message, /npm rm -g @ours\.network\/tg-connector/, 'says how to get the effect it cannot give');

  const reassign = parseUninstallEnv({ OURS_UNINSTALL_ROOMS: 'reassign:default' });
  assert.equal(reassign.action, 'refuse');
  assert.deepEqual(reassign.confirmedComponents, [], 'and it is not half-honoured as a detach');
});

test('a harness name that is not a harness is refused, not shrugged off', () => {
  const c = parseUninstallEnv({ OURS_UNINSTALL: 'hermez' });
  assert.equal(c.action, 'refuse');
  assert.deepEqual(c.refusals.map((r) => r.value), ['hermez']);
});

test('every unsupported variable in one run is reported at once', () => {
  const c = parseUninstallEnv({
    OURS_UNINSTALL_DATA: 'yes',
    OURS_UNINSTALL_PROFILE: 'blue',
    OURS_UNINSTALL_FORGET_PROFILE: 'yes',
    OURS_UNINSTALL_ROOMS: 'reassign:default',
  });
  assert.deepEqual(c.refusals.map((r) => r.variable), [
    'OURS_UNINSTALL_DATA', 'OURS_UNINSTALL_PROFILE', 'OURS_UNINSTALL_FORGET_PROFILE', 'OURS_UNINSTALL_ROOMS',
  ], 'one run, one list — not four re-runs to discover them one at a time');
});
