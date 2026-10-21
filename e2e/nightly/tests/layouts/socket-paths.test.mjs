import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, rmSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import * as runtime from './runtime.mjs';

const parent = realpathSync(process.env.OURS_LAYOUT_SCRATCH_DIR ?? tmpdir());
// Run directly at an upstream 61-byte task root, or create an owned padded
// child when the caller supplied a shorter private test root.
function taskRoot() {
  const bytes = Buffer.byteLength(parent);
  assert(bytes <= 61, 'Set OURS_LAYOUT_SCRATCH_DIR to a task-owned path of at most 61 UTF-8 bytes');
  if (bytes >= 60) return { path: parent, remove() {} };
  for (let attempt = 0; attempt < 128; attempt++) {
    const path = join(parent, randomBytes(48).toString('hex').slice(0, 60 - bytes));
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    return { path, remove() { rmSync(path, { recursive: true }); } };
  }
  throw new Error('Could not allocate a private layout test task root after 128 attempts');
}

test('layout scratch under a task root of up to 61 bytes can bind Cowork and Fleet private sockets', async () => {
  const task = taskRoot();
  let root;
  try {
    root = runtime.createLayoutScratch(task.path);
    assert(root.startsWith(task.path + '/'));
    assert.equal(statSync(root).mode & 0o777, 0o700);
    const { coworkState, socketRoot } = runtime.layoutSocketPaths(root);
    for (const directory of [coworkState, socketRoot]) mkdirSync(directory, { mode: 0o700 });
    const paths = [join(coworkState, 'management.sock.private-0123456789ab'), join(socketRoot, '0123456789abcdef01234567.sock')];
    for (const path of paths) {
      assert(Buffer.byteLength(path) <= 103, path);
      const server = createServer();
      try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); }); }
      finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
    }
  } finally { if (root) rmSync(root, { recursive: true }); task.remove(); }
});

test('unsupported physical root fails before starting resources without changing its directory', () => {
  const task = taskRoot();
  let longParent;
  try {
    longParent = runtime.createLayoutScratch(task.path);
    const before = readdirSync(longParent);
    assert.throws(() => runtime.createLayoutScratch(longParent), /Cowork.*socket.*103.*shorter.*TMPDIR/i);
    assert.deepEqual(readdirSync(longParent), before);
  } finally { if (longParent) rmSync(longParent, { recursive: true }); task.remove(); }
});
