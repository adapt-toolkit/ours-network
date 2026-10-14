import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realEffects } from '../lib/effects.mjs';

const record = { mode: 'docker', root: '/private/new installation', project: 'ours-fixture' };

function assertRecovery(error) {
  assert.match(error.message, /install.*Docker/i);
  assert.match(error.message, /--mode packages/);
  assert.match(error.message, /Docker is recommended for macOS and Windows/);
  assert.doesNotMatch(error.message, /exited null/);
  return true;
}

test('missing Docker executable explains installation and native alternatives', async t => {
  const emptyPath = mkdtempSync(join(tmpdir(), 'ours-no-docker-'));
  t.after(() => rmSync(emptyPath, { recursive: true, force: true }));
  const effects = realEffects({ env: { PATH: emptyPath } });
  await assert.rejects(effects.serverPreflight(record, 'install', { existing: false }), error => {
    assert.match(error.message, /Docker command was not found/);
    assert.equal(error.cause.code, 'ENOENT');
    return assertRecovery(error);
  });
});

test('process launch failure preserves ENOENT rather than an empty exit status', async t => {
  const emptyPath = mkdtempSync(join(tmpdir(), 'ours-missing-command-'));
  t.after(() => rmSync(emptyPath, { recursive: true, force: true }));
  const effects = realEffects({ env: { PATH: emptyPath } });
  await assert.rejects(effects.run('ours-nonexistent-command', []), error => {
    assert.equal(error.code, 'ENOENT');
    assert.equal(error.cause.code, 'ENOENT');
    assert.doesNotMatch(error.message, /exited null/);
    return true;
  });
});

test('inaccessible Docker Engine is distinguished from a missing executable', async () => {
  const effects = realEffects();
  effects.run = async () => { throw new Error('permission denied connecting to Docker socket'); };
  await assert.rejects(effects.serverPreflight(record, 'install', { existing: false }), error => {
    assert.match(error.message, /Docker Engine is not reachable/);
    assert.match(error.message, /start.*Docker|Start.*Docker/);
    assert.match(error.message, /permission denied/);
    assert.doesNotMatch(error.message, /command was not found/);
    return assertRecovery(error);
  });
});

test('missing Compose explains the required plugin and recovery', async () => {
  const effects = realEffects();
  effects.run = async (_cmd, args) => {
    if (args[0] === 'info') return { stdout: '28.0.0' };
    throw new Error("docker: compose is not a docker command");
  };
  await assert.rejects(effects.serverPreflight(record, 'install', { existing: false }), error => {
    assert.match(error.message, /Docker Compose 2.35 or newer/);
    return assertRecovery(error);
  });
});

test('old or malformed Compose versions provide actionable guidance', async () => {
  for (const version of ['2.34.0', 'unknown']) {
    const effects = realEffects();
    effects.run = async (_cmd, args) => ({ stdout: args[0] === 'info' ? '28.0.0' : version });
    await assert.rejects(effects.serverPreflight(record, 'install', { existing: false }), error => {
      assert.match(error.message, /Docker Compose 2.35 or newer/);
      return assertRecovery(error);
    });
  }
});

test('supported Compose proceeds without changing the selected runtime', async () => {
  for (const version of ['v2.35.0', '2.40.1', '3.0.0']) {
    const effects = realEffects();
    const calls = [];
    effects.run = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: args[0] === 'compose' ? version : args[0] === 'info' ? '28.0.0' : '' }; };
    await effects.serverPreflight(record, 'install', { existing: false });
    assert.deepEqual(calls.map(call => call.slice(0, 2)), [['docker', 'info'], ['docker', 'compose'], ['docker', 'ps']]);
    assert.equal(record.mode, 'docker');
  }
});
