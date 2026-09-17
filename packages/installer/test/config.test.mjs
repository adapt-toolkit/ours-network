import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWriteConfig, restoreConfig, snapshotConfig, transactionalConfigUpdate,
} from '../lib/config.mjs';

test('atomic config write enforces 0600 and rollback restores prior bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, '{"port":3050}\n', { mode: 0o644 });
  const before = snapshotConfig(path);

  atomicWriteConfig(path, '{"stt":{"apiKey":"placeholder-only"}}\n');
  assert.equal(readFileSync(path, 'utf8'), '{"stt":{"apiKey":"placeholder-only"}}\n');
  assert.equal(statSync(path).mode & 0o777, 0o600);

  restoreConfig(path, before);
  assert.equal(readFileSync(path, 'utf8'), '{"port":3050}\n');
  assert.equal(statSync(path).mode & 0o777, 0o644);
  rmSync(dir, { recursive: true, force: true });
});

test('atomic config rename failure leaves original intact and cleans the temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, '{"before":true}\n');
  assert.throws(() => atomicWriteConfig(path, '{"after":true}\n', {
    rename: () => { throw new Error('injected rename failure'); },
  }), /injected rename failure/);
  assert.equal(readFileSync(path, 'utf8'), '{"before":true}\n');
  assert.deepEqual(readdirSync(dir).sort(), ['config.json'], 'temporary file removed after failed replace');
  rmSync(dir, { recursive: true, force: true });
});

test('failed daemon apply restores prior config and reloads it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, '{"port":3050}\n');
  let calls = 0;
  const result = transactionalConfigUpdate(path, '{"stt":{"apiKey":"placeholder-only"}}\n', () => {
    calls += 1;
    return { ok: calls > 1, error: 'injected restart failure placeholder-only' };
  });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(calls, 2, 'one failed reload and one reload after rollback');
  assert.equal(readFileSync(path, 'utf8'), '{"port":3050}\n');
  rmSync(dir, { recursive: true, force: true });
});

test('thrown daemon apply still restores prior config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, '{"port":3050}\n');
  let calls = 0;
  const result = transactionalConfigUpdate(path, '{"stt":{"apiKey":"placeholder-only"}}\n', () => {
    calls += 1;
    if (calls === 1) throw new Error('injected apply exception');
    return { ok: true };
  });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(calls, 2);
  assert.equal(readFileSync(path, 'utf8'), '{"port":3050}\n');
  rmSync(dir, { recursive: true, force: true });
});
