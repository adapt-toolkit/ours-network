// Test process helpers reused from ours-cowork ceab465, tests/fixtures/v1-runtime.mjs.
// Bounded versions of the process/port helpers in external-e2e.test.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdirSync, realpathSync, rmdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function waitFor(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; }
    catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}: ${last?.message ?? 'not ready'}`);
}
export const waitForPort = port => waitFor(() => new Promise(resolve => {
  const socket = connect({host: '127.0.0.1', port});
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => { socket.destroy(); resolve(false); });
}), `local broker ${port}`);

export function startProcess(args, env, cwd) {
  const child = spawn(process.execPath, args, {env, cwd, stdio: ['ignore', 'pipe', 'pipe']});
  const result = {child, stdout: '', stderr: ''};
  child.stdout.on('data', data => { result.stdout = (result.stdout + data).slice(-24000); });
  child.stderr.on('data', data => { result.stderr = (result.stderr + data).slice(-24000); });
  result.exited = new Promise(resolve => {
    child.once('error', error => resolve({error}));
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  return result;
}
export async function stopProcess(process, signal = 'SIGTERM', timeout = 8000) {
  if (!process || process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill(signal);
  let timer;
  const outcome = await Promise.race([
    process.exited,
    new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); }),
  ]);
  clearTimeout(timer);
  if (outcome === null) {
    process.child.kill('SIGKILL');
    await bounded(() => process.exited, timeout, 'process SIGKILL');
    if (signal !== 'SIGKILL') throw new Error('Fixture process exceeded graceful shutdown bound');
  }
}
async function commandResult(process, args, timeout) {
  let timer;
  const outcome = await Promise.race([
    process.exited,
    new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); }),
  ]);
  clearTimeout(timer);
  if (outcome === null) {
    await stopProcess(process, 'SIGKILL');
    throw new Error(`Command timed out: ${args.join(' ')}\n${process.stderr}`);
  }
  if (outcome.error) throw outcome.error;
  assert.equal(outcome.code, 0, `Command ${args.join(' ')}\n${process.stdout}\n${process.stderr}`);
  return process.stdout;
}
export function command(args, env, cwd, timeout = 45000) {
  return commandResult(startProcess(args, env, cwd), args, timeout);
}

async function bounded(action, timeout, name) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Each resource is attempted even when an earlier stop fails. Concurrent callers share teardown.
export function createCleanup(actions, timeout = 10000) {
  let pending;
  return () => pending ??= (async () => {
    const errors = [];
    for (const [name, action, limit = timeout] of actions) {
      try { await bounded(action, limit, name); }
      catch (error) { errors.push(new Error(`${name}: ${error.message}`, { cause: error })); }
    }
    return errors;
  })();
}

export function createCommandScope({ shutdownTimeout = 8000 } = {}) {
  const running = new Set();
  let closed = false, cancellation;
  return {
    async command(args, env, cwd, timeout = 45000) {
      if (closed) throw new Error('Fixture command scope closed');
      const child = startProcess(args, env, cwd);
      running.add(child);
      try { return await commandResult(child, args, timeout); }
      finally { running.delete(child); }
    },
    cancel() {
      closed = true;
      return cancellation ??= (async () => {
        const results = await Promise.allSettled([...running].map(child => stopProcess(child, 'SIGTERM', shutdownTimeout)));
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Fixture command shutdown failed');
      })();
    },
  };
}

// Cowork binds a private name before publishing management.sock. Fleet's
// supported override hashes logical names to 24 hex characters plus .sock.
export function layoutSocketPaths(root) {
  return socketPaths(realpathSync(root));
}

function socketPaths(physical) {
  const coworkState = join(physical, 'c'), socketRoot = join(physical, 's');
  for (const [owner, path] of [
    ['Cowork', join(coworkState, 'management.sock.private-' + '0'.repeat(12))],
    ['Fleet', join(socketRoot, '0'.repeat(24) + '.sock')],
  ]) {
    const bytes = Buffer.byteLength(path);
    if (bytes > 103) throw new Error(`${owner} private socket path is ${bytes} bytes (portable limit 103): ${path}; select a shorter task-owned --scratch-dir or TMPDIR`);
  }
  return { coworkState, socketRoot };
}

export function createLayoutScratch(parent) {
  const physical = realpathSync(parent);
  // Two base64url characters leave room for Cowork's private publication
  // suffix under a 61-byte task root. mkdir is exclusive, including symlinks.
  socketPaths(join(physical, '00'));
  for (let attempt = 0; attempt < 64; attempt++) {
    const root = join(physical, randomBytes(2).toString('base64url').slice(0, 2));
    try { mkdirSync(root, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try { layoutSocketPaths(root); return root; }
    catch (error) { rmdirSync(root); throw error; }
  }
  throw new Error('Could not allocate a unique private layout directory after 64 attempts');
}
