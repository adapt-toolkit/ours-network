import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import * as runtime from './runtime.mjs';

const parentWithBytes = (base, bytes) => {
  const parent = join(base, 'x'.repeat(bytes - Buffer.byteLength(base) - 1));
  mkdirSync(parent, { mode: 0o700 });
  return parent;
};

test('layout scratch under a 54-byte task root can bind Cowork and Fleet private sockets', async () => {
  assert.equal(typeof runtime.createLayoutScratch, 'function', 'fixture needs a portable owned scratch allocator');
  const base = mkdtempSync(join(realpathSync('/tmp'), 'lp-'));
  try {
    const parent = parentWithBytes(base, 54);
    const root = runtime.createLayoutScratch(parent);
    assert(root.startsWith(parent + '/'));
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
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('unsupported physical root fails before starting resources and removes only its empty scratch', () => {
  assert.equal(typeof runtime.createLayoutScratch, 'function', 'fixture needs a portable owned scratch allocator');
  const base = mkdtempSync(join(realpathSync('/tmp'), 'lp-'));
  try {
    const parent = parentWithBytes(base, 70);
    const before = readdirSync(parent);
    assert.throws(() => runtime.createLayoutScratch(parent), /Cowork.*socket.*103.*shorter.*TMPDIR/i);
    assert.deepEqual(readdirSync(parent), before);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
