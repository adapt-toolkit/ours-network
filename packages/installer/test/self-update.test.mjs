import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { selfUpdateTag } from '../lib/self-update.mjs';

const installer = fileURLToPath(new URL('../install.mjs', import.meta.url));

test('only bare update and update --nightly launch the newest installer', () => {
  assert.equal(selfUpdateTag(['update']), 'latest');
  assert.equal(selfUpdateTag(['update', '--nightly']), 'nightly');
  for (const argv of [[], ['--nightly'], ['update', '--help'], ['update', '--mode', 'docker'], ['all', 'update'], ['--nightly', 'update'], ['update', '--nightly', '--dry-run']])
    assert.equal(selfUpdateTag(argv), null, argv.join(' '));
});

// Fake tools on an isolated PATH record their argv; nothing real is installed or updated.
function run(t, argv, { tools = [], childStatus = 0, npmInstallStatus = 0, stalePathInstaller = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ours-self-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const prefix = join(dir, 'prefix');
  mkdirSync(bin); mkdirSync(join(prefix, 'bin'), { recursive: true });
  const log = join(dir, 'log');
  const script = (path, body) => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o700); };
  const record = name => `[ "$1" = --version ] && exit 0\necho "${name} $*" >> ${JSON.stringify(log)}`;
  if (tools.includes('npx')) script(join(bin, 'npx'), `${record('npx')}\nexit ${childStatus}`);
  if (tools.includes('npm')) script(join(bin, 'npm'), `${record('npm')}\n[ "$1" = prefix ] && { echo ${JSON.stringify(prefix)}; exit 0; }\n[ "$1" = i ] && { /bin/cp ${JSON.stringify(join(dir, 'new-installer'))} ${JSON.stringify(join(prefix, 'bin', 'ours-install'))}; exit ${npmInstallStatus}; }\nexit 1`);
  script(join(dir, 'new-installer'), `echo "new-ours-install args=[$*]" >> ${JSON.stringify(log)}\nexit ${childStatus}`);
  if (stalePathInstaller) script(join(bin, 'ours-install'), `echo "stale-ours-install $*" >> ${JSON.stringify(log)}\nexit 99`);
  const result = spawnSync(process.execPath, [installer, ...argv], { encoding: 'utf8', input: '', env: { PATH: bin, HOME: dir } });
  return { ...result, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}

test('update runs npx --yes @latest and returns its exit status', t => {
  const result = run(t, ['update'], { tools: ['npx', 'npm'], childStatus: 7 });
  assert.deepEqual(result.calls, ['npx --yes @ours.network/install@latest']);
  assert.equal(result.status, 7);
});

test('update --nightly runs npx --yes @nightly without forwarding update', t => {
  const result = run(t, ['update', '--nightly'], { tools: ['npx'] });
  assert.deepEqual(result.calls, ['npx --yes @ours.network/install@nightly']);
  assert.equal(result.status, 0);
});

test('without npx, npm installs the tag globally and starts that new bin with no arguments', t => {
  const result = run(t, ['update', '--nightly'], { tools: ['npm'], childStatus: 5, stalePathInstaller: true });
  assert.deepEqual(result.calls, ['npm i -g @ours.network/install@nightly', 'npm prefix --global', 'new-ours-install args=[]']);
  assert.equal(result.status, 5);
});

test('a failed npm install does not start any installer', t => {
  const result = run(t, ['update'], { tools: ['npm'], npmInstallStatus: 3 });
  assert.deepEqual(result.calls, ['npm i -g @ours.network/install@latest']);
  assert.equal(result.status, 3);
});

test('without npx or npm, update explains what to install', t => {
  const result = run(t, ['update'], {});
  assert.deepEqual(result.calls, []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^ours-install: update needs npx or npm on PATH\. Install Node\.js with npm, then run: npx --yes @ours\.network\/install@latest\n$/);
});

test('a child killed by a signal is reported as that signal', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-self-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'npx'), '#!/bin/sh\n[ "$1" = --version ] && exit 0\nkill -TERM $$\n');
  chmodSync(join(dir, 'npx'), 0o700);
  const result = spawnSync(process.execPath, [installer, 'update'], { encoding: 'utf8', input: '', env: { PATH: dir, HOME: dir } });
  assert.equal(result.signal, 'SIGTERM');
});
