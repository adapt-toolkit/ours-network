// THE SCAN ITSELF, against a real directory layout — which is the hole this
// defect fell through.
//
// Every other test injects `knownStateDirs` as a literal array, so the function
// that actually walks the filesystem was never exercised. It counted any
// `~/.ours*` directory with a config.json as a daemon, and on a normal machine two
// of those are the CONNECTORS' configs. The uninstaller then reported
// "@ours.network/cli kept — still used by the daemon at ~/.ours-telegram", kept
// every global package forever, and — silently — skipped the whole harness plugin
// removal phase because `lastDaemon` was false for a reason that was not true.
//
// So these build a realistic HOME on disk and run the real scan. No network, no
// subprocess, nothing outside mkdtemp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __testables } from '../lib/effects.mjs';

const { knownStateDirsIn } = __testables;

function realisticHome({ daemonDirs = {}, otherDirs = {}, files = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ours-home-'));
  for (const [name, contents] of Object.entries({ ...daemonDirs, ...otherDirs })) {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, body] of Object.entries(contents)) {
      writeFileSync(join(dir, file), typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
    }
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(home, name), body);
  return home;
}

test('THE CONNECTORS ARE NOT DAEMONS, on a realistic machine, through the real scan', () => {
  // The exact layout that produced "still used by the daemon at ~/.ours-telegram".
  const home = realisticHome({
    daemonDirs: {
      '.ours': { 'config.json': { port: 3050, stateDir: '/home/x/.ours' } },
    },
    otherDirs: {
      '.ours-telegram': { 'config.json': { botToken: 'secret', daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: '/home/x/.ours' } },
      '.ours-cowork': { 'config.json': { version: 1, stateDir: '/home/x/.ours-cowork', daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: '/home/x/.ours' } } },
    },
  });
  try {
    assert.deepEqual(knownStateDirsIn(home), [join(home, '.ours')], 'one daemon, not three');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a second REAL daemon is found, so global packages are still kept for it', () => {
  const home = realisticHome({
    daemonDirs: {
      '.ours': { 'config.json': { port: 3050 } },
      '.ours-work': { 'config.json': { port: 3060 } },
    },
    otherDirs: { '.ours-telegram': { 'config.json': { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: '/x' } } },
  });
  try {
    assert.deepEqual(knownStateDirsIn(home).sort(), [join(home, '.ours'), join(home, '.ours-work')].sort());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a daemon identified by its ARTEFACTS is found even with no config at all', () => {
  // The old scan required a config.json, so a daemon that had been started by hand
  // and never wrote one was invisible — and being wrong in that direction removes
  // the CLI out from under a running daemon.
  for (const artefact of ['daemon-token', 'ours-cli-daemon.json', 'root.json']) {
    const home = realisticHome({ daemonDirs: { '.ours-hand': { [artefact]: 'x' } } });
    try {
      assert.deepEqual(knownStateDirsIn(home), [join(home, '.ours-hand')], `${artefact} identifies a daemon`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('unrelated dotfiles and non-ours directories are ignored', () => {
  const home = realisticHome({
    daemonDirs: { '.ours': { 'config.json': { port: 3050 } } },
    otherDirs: {
      '.oursomething-else': { 'config.json': { port: 9999 } },  // starts with .ours but is not one of ours
      '.config': { 'config.json': { port: 1 } },
      projects: { 'config.json': { port: 2 } },
    },
    files: { '.ours-not-a-dir': 'a file, not a directory' },
  });
  try {
    const found = knownStateDirsIn(home);
    assert.ok(found.includes(join(home, '.ours')));
    assert.ok(!found.includes(join(home, '.config')));
    assert.ok(!found.includes(join(home, 'projects')));
    assert.ok(!found.some((d) => d.endsWith('.ours-not-a-dir')), 'a plain file is not a state directory');
    // NOTE: `.oursomething-else` DOES match the ~/.ours* prefix scan, and it has a
    // daemon-shaped config, so it IS reported. That is the scan's known shape — the
    // prefix is the search space, and the predicate decides within it. Recorded
    // rather than asserted away, because narrowing the prefix is a separate
    // decision from fixing the predicate.
    assert.ok(found.includes(join(home, '.oursomething-else')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an empty home, and an unreadable one, both answer without throwing', () => {
  const home = realisticHome();
  try {
    assert.deepEqual(knownStateDirsIn(home), []);
    assert.deepEqual(knownStateDirsIn(join(home, 'does-not-exist')), [], 'unreadable is not a crash');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
