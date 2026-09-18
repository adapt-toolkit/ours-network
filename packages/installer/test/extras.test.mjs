// ours-install v3 — the four retained extras (Product contract 2026-08-17).
//
// Pure functions only: nothing here spawns, writes, probes or touches a
// terminal. The point of each test is a decision that is easy to get wrong in
// the direction of a SILENT half-pair — a harness or a fleet role attached to
// ~/.ours while the operator was told a different state directory was chosen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  planHarnessPlugins, planFleet, buildHandoffPromptV3,
  HARNESS_ENV_SUPPORT, CLAUDE_MARKET, CODEX_MARKET,
} from '../lib/extras.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const TG = resolve(HOME, '.ours-tg');
const TG_CFG = join(TG, 'config.json');
const PROFILE_CFG = '/home/me/private/profile.json';

const all = (status = 'ok') => [
  { name: 'claude-code', status },
  { name: 'codex', status },
  { name: 'hermes', status },
];
const by = (plans, name) => plans.find((p) => p.name === name);

// ------------------------------------------------------------ harness plugins --

test('the default state directory changes NOTHING about a harness install', () => {
  // The majority case. No env, no extra line to paste, and the pair guarantee
  // holds trivially because ~/.ours is what every registration already resolves.
  const plans = planHarnessPlugins({ harnesses: all(), stateDir: OURS, isDefaultStateDir: true });
  for (const p of plans) {
    assert.equal(p.action, 'drive');
    assert.equal(p.envSupport, 'none');
    assert.deepEqual(p.env, {});
    assert.equal(p.envLine, null);
    assert.equal(p.claimsPair, true);
  }
});

test('a non-default state directory: Hermes carries the pair, Claude and Codex only print it', () => {
  // The desired registration carries OURS_CONFIG. Two of the three
  // registrations cannot carry a value at all, so this pins WHICH one is real —
  // and pins that the other two never claim the guarantee.
  const plans = planHarnessPlugins({ harnesses: all(), stateDir: TG, isDefaultStateDir: false });

  const hermes = by(plans, 'hermes');
  assert.equal(hermes.envSupport, 'applied');
  assert.deepEqual(hermes.env, { OURS_CONFIG: TG_CFG });
  assert.equal(hermes.claimsPair, true);
  assert.equal(hermes.envLine, null, 'nothing to paste: it is applied');

  for (const name of ['claude-code', 'codex']) {
    const p = by(plans, name);
    assert.equal(p.envSupport, 'printed', `${name} cannot carry a value`);
    assert.deepEqual(p.env, {}, `${name} must never be handed an env it cannot apply`);
    assert.equal(p.envLine, `export OURS_CONFIG=${TG_CFG}`);
    assert.equal(p.claimsPair, false, `${name} must never claim automatic daemon selection`);
  }
});

test("Hermes' pair reaches the invocation that writes ~/.hermes/config.yaml", () => {
  // 'applied' is only honest if something carries the value to the writer. The
  // writer's own half is pinned in packages/hermes; this is the installer's
  // half — the env is on the plan, attached to the ours-hermes-install step.
  const hermes = by(planHarnessPlugins({ harnesses: all(), stateDir: TG, isDefaultStateDir: false }), 'hermes');
  assert.equal(hermes.envSupport, 'applied');
  assert.deepEqual(hermes.env, { OURS_CONFIG: TG_CFG });
  assert.ok(hermes.steps.some((s) => s[0] === 'ours-hermes-install'), 'and there is an invocation to carry it');
  assert.equal(HARNESS_ENV_SUPPORT['claude-code'], 'printed');
  assert.equal(HARNESS_ENV_SUPPORT.codex, 'printed');
});

test('a harness we cannot drive NEVER dead-ends — it always gets manual steps', () => {
  // v2's golden rule, kept verbatim: alias/unsafe means "do not call it", never
  // "you cannot have the plugin".
  for (const status of ['alias', 'unsafe']) {
    const plans = planHarnessPlugins({ harnesses: all(status), stateDir: OURS, isDefaultStateDir: true });
    for (const p of plans) {
      assert.equal(p.action, 'manual', `${p.name}/${status}`);
      assert.ok(p.manual.length > 0, `${p.name} must still say how to do it by hand`);
      assert.ok(p.reason, 'and say why it is not being driven');
    }
  }
  assert.ok(by(planHarnessPlugins({ harnesses: all('alias'), stateDir: OURS, isDefaultStateDir: true }), 'claude-code')
    .manual.some((s) => s.includes(CLAUDE_MARKET)));
  assert.ok(by(planHarnessPlugins({ harnesses: all('alias'), stateDir: OURS, isDefaultStateDir: true }), 'codex')
    .manual.some((s) => s.includes(CODEX_MARKET)));
});

test('an absent harness is skipped, and a declined one is offered again on re-run', () => {
  const absent = planHarnessPlugins({ harnesses: all('absent'), stateDir: OURS, isDefaultStateDir: true });
  for (const p of absent) assert.equal(p.action, 'skip');

  const declined = planHarnessPlugins({
    harnesses: all(), stateDir: OURS, isDefaultStateDir: true, answers: { codex: false },
  });
  assert.equal(by(declined, 'codex').action, 'skip');
  assert.equal(by(declined, 'codex').offerOnRerun, true);
  assert.equal(by(declined, 'claude-code').action, 'drive', 'declining one does not decline the others');
});

test('nothing a harness plan drives ever calls the `hermes` binary', () => {
  // Hermes has no driven CLI; its install is npm + ours-hermes-install. Calling
  // a `hermes` command is the mistake this pins shut.
  const hermes = by(planHarnessPlugins({ harnesses: all(), stateDir: OURS, isDefaultStateDir: true }), 'hermes');
  for (const step of hermes.steps) assert.notEqual(step[0], 'hermes');
  assert.ok(hermes.steps.some((s) => s[0] === 'ours-hermes-install' && s.includes('--skip-daemon')));
});

test('an explicit host profile reaches driven clients and remains in native launch instructions', () => {
  const plans = planHarnessPlugins({ harnesses: all(), configPath: PROFILE_CFG, isDefaultStateDir: false });
  for (const name of ['claude-code', 'codex']) {
    assert.deepEqual(by(plans, name).env, { OURS_CONFIG: PROFILE_CFG });
    assert.equal(by(plans, name).envLine, `export OURS_CONFIG=${PROFILE_CFG}`);
    assert.equal(by(plans, name).claimsPair, false, 'marketplace metadata cannot persist the value');
  }
  const hermes = by(plans, 'hermes');
  assert.equal(hermes.action, 'skip');
  assert.equal(hermes.reason, 'not selected for host-profile setup');
  assert.deepEqual(hermes.env, {});
});

// -------------------------------------------------------------------- fleet --

test('ours-fleet delegates configuration to its wizard at the selected path', () => {
  const plan = planFleet({ stateDir: TG, isDefaultStateDir: false });
  assert.equal(plan.action, 'install');
  assert.deepEqual(plan.init, ['ours-fleet', 'init', '--configuration', join(HOME, 'fleet.yaml')]);
  assert.equal('writes' in plan, false);
  assert.equal('config' in plan, false);
  assert.equal('roleEnv' in plan, false);
  assert.match(plan.instruction, /fleet\.yaml/);
});

test('the default state directory uses the same Fleet-owned wizard', () => {
  const plan = planFleet({ stateDir: OURS, isDefaultStateDir: true });
  assert.match(plan.instruction, /ours-fleet doctor/);
  assert.deepEqual(plan.init, ['ours-fleet', 'init', '--configuration', join(HOME, 'fleet.yaml')]);
});

test('Fleet plan retains the owner configuration path for an explicit host profile', () => {
  const settingsPath = join(HOME, 'private', 'fleet-settings.json');
  const plan = planFleet({ home: HOME, configPath: PROFILE_CFG, settingsPath, isDefaultStateDir: false });
  assert.equal(plan.configPath, join(HOME, 'fleet.yaml'));
  assert.deepEqual(plan.init, ['ours-fleet', 'init', '--configuration', join(HOME, 'fleet.yaml'), '--settings', settingsPath]);
});

test('ours-fleet FOLLOWS the channel, so a nightly stack does not get stable fleet', () => {
  // This test asserted the opposite until the v3 work moved onto prerelease.
  // fleet DOES publish a nightly dist-tag, and the nightly stack needs the fleet
  // build carrying the SDK integration; installing stable fleet beside a nightly
  // daemon is the split-brain deployment the channel exists to prevent. The
  // mapping lives in lib/logic.mjs and this asserts we defer to it.
  assert.deepEqual(planFleet({ stateDir: OURS, isDefaultStateDir: true, channel: 'nightly' }).install,
    ['npm', 'i', '-g', '@ours.network/fleet@nightly']);
  assert.deepEqual(planFleet({ stateDir: OURS, isDefaultStateDir: true, channel: 'latest' }).install,
    ['npm', 'i', '-g', '@ours.network/fleet@latest'], 'and a stable stack still gets stable fleet');
});

// ---------------------------------------------------------------- hand-off --

test('the hand-off explains the staged Fleet and Telegram state', () => {
  const result = buildHandoffPromptV3({ fleet: true, telegram: true, stateDir: OURS, isDefaultStateDir: true });
  assert.match(result.text, /Review the Fleet wizard output in ~\/fleet\.yaml/);
  assert.match(result.text, /selected.*models.*roles.*templates.*permissions/s);
  assert.match(result.text, /connector service that ours-install already started/);
});

test('a non-default state directory adds ONE preamble that names the config path', () => {
  const v3 = buildHandoffPromptV3({ fleet: true, telegram: true, stateDir: TG, isDefaultStateDir: false });
  assert.ok(v3.text.startsWith('My ours daemon uses the state directory '));
  assert.ok(v3.text.includes(TG_CFG));
  assert.ok(v3.text.includes('OURS_CONFIG'));
  assert.equal(v3.empty, false);
});

test('nothing to finish means no prompt, on either state directory', () => {
  assert.deepEqual(buildHandoffPromptV3({ stateDir: TG, isDefaultStateDir: false }), { text: '', empty: true });
  assert.deepEqual(buildHandoffPromptV3({}), { text: '', empty: true });
});
