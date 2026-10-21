// ours-install v3 — which daemons are on this machine (C1, Product contract).
//
// Pure: the directory listing and the file reads are injected. Nothing here
// touches a filesystem, a socket or a terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  DAEMON_ARTEFACTS, looksLikeDaemonConfig, classifyStateDir, detectDaemons,
  deriveNewStateDir, planDaemonSelection, resolveSelection, SELECT_CREATE,
} from '../lib/detect.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const SECOND = resolve(HOME, '.ours-work');
const TG_DIR = resolve(HOME, '.ours-telegram');
const COWORK_DIR = resolve(HOME, '.ours-cowork');
const files = (map) => (path) => (Object.prototype.hasOwnProperty.call(map, path) ? map[path] : null);
const present = (list) => (path) => list.includes(path);

// ------------------------------------------- the ambiguous piece of evidence --

test('THE CONNECTORS ARE NOT DAEMONS, however much their config directories look like one', () => {
  // The trap this whole module exists to avoid. Both of these match a `~/.ours*`
  // scan and both have a config.json, and NEITHER is a daemon. Built on "has a
  // config.json", the selection screen would show three daemons on a machine with
  // one — and choosing the Telegram connector's directory would have the installer
  // create a daemon inside it.
  const readJson = files({
    [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS },
    [join(TG_DIR, 'config.json')]: { botToken: 'secret', daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS },
    [join(COWORK_DIR, 'config.json')]: { version: 1, stateDir: COWORK_DIR, daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: OURS } },
  });
  const found = detectDaemons({ candidates: [OURS, TG_DIR, COWORK_DIR], exists: () => false, readJson });
  assert.deepEqual(found.map((d) => d.stateDir), [OURS], 'exactly one daemon, not three');
});

test('a daemon-only artefact identifies a daemon even with no readable config', () => {
  // A stopped daemon whose config is missing or unreadable is still a daemon, and
  // the artefacts only a daemon writes are what say so.
  for (const artefact of DAEMON_ARTEFACTS) {
    const verdict = classifyStateDir(SECOND, { exists: present([join(SECOND, artefact)]), readJson: () => null });
    assert.equal(verdict.isDaemon, true, `${artefact} identifies a daemon`);
    assert.equal(verdict.evidence, artefact);
  }
});

test('config SHAPE decides when there is no artefact', () => {
  assert.equal(looksLikeDaemonConfig({ port: 3050 }), true);
  assert.equal(looksLikeDaemonConfig({ stateDir: OURS }), true);
  assert.equal(looksLikeDaemonConfig({ daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS }), false, "the connector's");
  assert.equal(looksLikeDaemonConfig({ daemon: { mode: 'external' } }), false, "cowork's");
  assert.equal(looksLikeDaemonConfig({ botToken: 'x', port: 3050 }), false, 'a token makes it the connector, whatever else it has');
  assert.equal(looksLikeDaemonConfig({}), false, 'an empty object claims nothing');
  assert.equal(looksLikeDaemonConfig(null), false);
  assert.equal(looksLikeDaemonConfig([]), false);
});

test('the default daemon is listed first, and the rest deterministically', () => {
  const readJson = files({
    [join(OURS, 'config.json')]: { port: 3050 },
    [join(SECOND, 'config.json')]: { port: 3060 },
  });
  const found = detectDaemons({ candidates: [SECOND, OURS], exists: () => false, readJson });
  assert.deepEqual(found.map((d) => d.stateDir), [OURS, SECOND], 'the one an operator means by "my daemon" comes first');
  assert.equal(found[1].port, 3060, 'and the recorded port travels with it');
});

test('the same directory offered twice is listed once', () => {
  const readJson = files({ [join(OURS, 'config.json')]: { port: 3050 } });
  const found = detectDaemons({ candidates: [OURS, OURS, `${OURS}/`], exists: () => false, readJson });
  assert.equal(found.length, 1);
});

// ------------------------------------------------------------ the five rules --

const ONE = [{ stateDir: OURS, port: 3050 }];
const TWO = [{ stateDir: OURS, port: 3050 }, { stateDir: SECOND, port: 3060 }];

test('flags outrank everything detected — no screen at all', () => {
  assert.equal(planDaemonSelection({ candidates: TWO, stateDirExplicit: true, home: HOME }).action, 'flags');
  assert.equal(planDaemonSelection({ candidates: TWO, portExplicit: true, home: HOME }).action, 'flags');
});

test('a non-interactive run never sees a screen', () => {
  const p = planDaemonSelection({ candidates: TWO, assumeYes: true, home: HOME });
  assert.equal(p.action, 'flags');
  assert.match(p.reason, /non-interactive/);
});

test('exactly one daemon is used without a question, and announced', () => {
  // A question with one answer is not a choice, it is a keystroke tax — but the
  // operator still has to be told which daemon the run is about.
  const p = planDaemonSelection({ candidates: ONE, home: HOME });
  assert.equal(p.action, 'use');
  assert.equal(p.stateDir, OURS);
  assert.equal(p.announce, true);
});

test('none detected creates, exactly as before', () => {
  const p = planDaemonSelection({ candidates: [], home: HOME });
  assert.equal(p.action, 'create');
  assert.equal(p.stateDir, OURS);
});

test('several detected are shown, with "create a new one" as the last option', () => {
  const p = planDaemonSelection({ candidates: TWO, home: HOME });
  assert.equal(p.action, 'choose');
  assert.deepEqual(p.candidates.map((c) => c.stateDir), [OURS, SECOND]);
  assert.equal(p.createOption.id, SELECT_CREATE);
  assert.equal(p.createOption.stateDir, resolve(HOME, '.ours-2'), 'derived, never typed — ~/.ours is taken');
});

// -------------------------------------------------------- deriving, not asking --

test('a new state directory is DERIVED without asking for a path', () => {
  assert.equal(deriveNewStateDir(HOME, []), OURS);
  assert.equal(deriveNewStateDir(HOME, [OURS]), resolve(HOME, '.ours-2'));
  assert.equal(deriveNewStateDir(HOME, [OURS, resolve(HOME, '.ours-2')]), resolve(HOME, '.ours-3'));
  assert.equal(deriveNewStateDir(HOME, [OURS], { limit: 2 }), null, 'exhausted is null, never a reused path');
});

// ------------------------------------------------------- reading the answer ---

test('an answer that is not one of the numbers offered is REFUSED, never interpreted', () => {
  // Accepting free text here would reintroduce the forbidden "type a state
  // directory" prompt through the back door.
  const plan = planDaemonSelection({ candidates: TWO, home: HOME });
  for (const answer of ['/etc/passwd', '~/.ours-other', 'yes', '', '0', '9', '1.5']) {
    assert.equal(resolveSelection(answer, plan).action, 'invalid', `${JSON.stringify(answer)} is not a choice`);
  }
});

test('a number picks that daemon, and the last option or "n" creates', () => {
  const plan = planDaemonSelection({ candidates: TWO, home: HOME });
  assert.deepEqual(resolveSelection('1', plan), { action: 'use', stateDir: OURS });
  assert.deepEqual(resolveSelection('2', plan), { action: 'use', stateDir: SECOND });
  assert.deepEqual(resolveSelection('3', plan), { action: 'create', stateDir: resolve(HOME, '.ours-2') });
  assert.deepEqual(resolveSelection('n', plan), { action: 'create', stateDir: resolve(HOME, '.ours-2') });
  assert.deepEqual(resolveSelection('NEW', plan), { action: 'create', stateDir: resolve(HOME, '.ours-2') });
});

test('create is refused rather than guessed when no free directory could be derived', () => {
  const plan = { candidates: TWO, createOption: { id: SELECT_CREATE, stateDir: null } };
  assert.equal(resolveSelection('n', plan).action, 'invalid');
});
