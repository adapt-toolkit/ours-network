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
const child = (marker, exitAfterMs, readyFor) => [process.execPath, '-e', `
  const fs = require('fs');
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { fs.writeFileSync(${JSON.stringify(marker)}, s); process.exit(0); });
  fs.writeFileSync(${JSON.stringify(marker + '.ready')}, 'ready');
  ${exitAfterMs === undefined ? 'setInterval(() => {}, 1000);' : `const tick=setInterval(()=>{if(!${JSON.stringify(readyFor ?? '')}||fs.existsSync(${JSON.stringify(readyFor ?? '')})){clearInterval(tick);setTimeout(()=>process.exit(7),${exitAfterMs});}},10);`}`];

function run(t, commands, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ours-supervise-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proc = spawn(process.execPath, [supervisor, JSON.stringify(commands(dir))], { stdio: ['ignore', 'ignore', 'pipe', 'ignore', 'ignore'], env: { ...process.env, ...env } });
  t.after(() => proc.kill('SIGKILL'));
  return { dir, proc };
}

test('a child that exits stops the other and the supervisor exits with its status', async t => {
  const { dir, proc } = run(t, dir => [child(join(dir, 'a')), child(join(dir, 'b'), 300, join(dir, 'a.ready'))]);
  const [code] = await once(proc, 'exit');
  assert.equal(code, 7);
  assert.equal(readFileSync(join(dir, 'a'), 'utf8'), 'SIGTERM');
  assert.equal(existsSync(join(dir, 'b')), false);
});

test('SIGTERM reaches every child and the supervisor exits cleanly', async t => {
  const { dir, proc } = run(t, dir => [child(join(dir, 'a')), child(join(dir, 'b'))]);
  const deadline = Date.now() + 10000;
  while (!existsSync(join(dir, 'a.ready')) || !existsSync(join(dir, 'b.ready'))) {
    assert(Date.now() < deadline, 'both children must register signal handlers');
    await sleep(10);
  }
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

// A child that ignores SIGTERM and records that it is still alive.
const stubborn = marker => [process.execPath, '-e', `process.on('SIGTERM', () => require('fs').writeFileSync(${JSON.stringify(marker)}, 'ignored')); require('fs').writeFileSync(${JSON.stringify(marker+'.ready')}, 'ready'); setInterval(() => {}, 1000);`];

test('a child ignoring SIGTERM is killed after the bounded grace period', async t => {
  const { dir, proc } = run(t, dir => [stubborn(join(dir, 'a')), child(join(dir, 'b'), 200, join(dir, 'a.ready'))], { OURS_SUPERVISE_KILL_AFTER_MS: '300' });
  const started = Date.now();
  const [code] = await once(proc, 'exit');
  assert.equal(code, 7);
  assert.equal(readFileSync(join(dir, 'a'), 'utf8'), 'ignored');
  assert.ok(Date.now() - started < 5000, 'supervisor must not wait for a stubborn child indefinitely');
});

test('a child that cannot start stops its sibling and fails the supervisor', async t => {
  // The supervisor exits only after every child has; the sibling would otherwise run forever.
  const { proc } = run(t, dir => [child(join(dir, 'a')), [join(dir, 'missing-executable')]]);
  const started = Date.now();
  const [code] = await once(proc, 'exit');
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 5000);
});
