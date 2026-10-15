import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runtime from './runtime.mjs';

test('cleanup attempts later resources after rejection and timeout, once for concurrent callers', async () => {
  assert.equal(typeof runtime.createCleanup, 'function');
  const attempted = [];
  const cleanup = runtime.createCleanup([
    ['first', () => { attempted.push('first'); throw new Error('stop failed'); }],
    ['hung', () => { attempted.push('hung'); return new Promise(() => {}); }],
    ['last', () => { attempted.push('last'); }],
  ], 20);
  const [a, b] = await Promise.all([cleanup(), cleanup()]);
  assert.deepEqual(attempted, ['first', 'hung', 'last']);
  assert.equal(a, b);
  assert.equal(a.length, 2);
  assert.match(a[0].message, /first.*stop failed/);
  assert.match(a[1].message, /hung.*timed out/);
});

test('command cancellation reaps a child ignoring SIGTERM before later cleanup and rejects new commands', async () => {
  assert.equal(typeof runtime.createCommandScope, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'layout-runtime-'));
  const ready = join(dir, 'ready');
  const scope = runtime.createCommandScope({ shutdownTimeout: 50 });
  let pid;
  try {
    const running = scope.command(['-e', `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`], process.env, dir);
    const outcome = running.catch(error => error);
    await runtime.waitFor(() => existsSync(ready), 'child readiness', 3000);
    pid = Number(readFileSync(ready, 'utf8'));
    let laterRan = false;
    const cleanup = runtime.createCleanup([
      ['commands', () => scope.cancel()],
      ['supervisors', () => { assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); laterRan = true; }],
    ], 3000);
    const errors = await cleanup();
    assert(laterRan);
    assert.equal(errors.length, 1, 'forced shutdown remains a reported failure');
    assert(await outcome instanceof Error);
    await assert.rejects(scope.command(['-e', 'process.exit(0)'], process.env, dir), /closed/);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
});
