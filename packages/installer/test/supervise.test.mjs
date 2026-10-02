import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const supervisor = new URL('../assets/scripts/runtime/supervise.mjs', import.meta.url).pathname;
// A child records the signal it received, then exits.
const child = (marker, exitAfterMs) => [process.execPath, '-e', `
  const fs = require('fs');
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { fs.writeFileSync(${JSON.stringify(marker)}, s); process.exit(0); });
  ${exitAfterMs === undefined ? 'setInterval(() => {}, 1000);' : `setTimeout(() => process.exit(7), ${exitAfterMs});`}`];

function run(t, commands) {
  const dir = mkdtempSync(join(tmpdir(), 'ours-supervise-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proc = spawn(process.execPath, [supervisor, JSON.stringify(commands(dir))], { stdio: ['ignore', 'ignore', 'pipe', 'ignore', 'ignore'] });
  return { dir, proc };
}

test('a child that exits stops the other and the supervisor exits with its status', async t => {
  const { dir, proc } = run(t, dir => [child(join(dir, 'a')), child(join(dir, 'b'), 300)]);
  const [code] = await once(proc, 'exit');
  assert.equal(code, 7);
  assert.equal(readFileSync(join(dir, 'a'), 'utf8'), 'SIGTERM');
  assert.equal(existsSync(join(dir, 'b')), false);
});

test('SIGTERM reaches every child and the supervisor exits cleanly', async t => {
  const { dir, proc } = run(t, dir => [child(join(dir, 'a')), child(join(dir, 'b'))]);
  await sleep(300);
  proc.kill('SIGTERM');
  const [code] = await once(proc, 'exit');
  assert.equal(code, 0);
  assert.equal(readFileSync(join(dir, 'a'), 'utf8'), 'SIGTERM');
  assert.equal(readFileSync(join(dir, 'b'), 'utf8'), 'SIGTERM');
});

test('refuses a malformed command list', async () => {
  const proc = spawn(process.execPath, [supervisor, '{"not":"a list"}'], { stdio: 'ignore' });
  const [code] = await once(proc, 'exit');
  assert.equal(code, 2);
});
