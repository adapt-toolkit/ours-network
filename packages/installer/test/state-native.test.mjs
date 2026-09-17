import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('native state operations retain atomic publication and process exclusion', async () => {
  const url = new URL('../assets/scripts/maintenance/state-native.mjs', import.meta.url);
  const { exchange, publishNoReplace, tryLock } = await import(url);
  const root = mkdtempSync(join(tmpdir(), 'ours-native-state-'));
  try {
    const a = join(root, 'a'), b = join(root, 'b');
    mkdirSync(a); mkdirSync(b);
    writeFileSync(join(a, 'data'), 'A'); writeFileSync(join(b, 'data'), 'B');
    exchange(a, b);
    assert.equal(readFileSync(join(a, 'data'), 'utf8'), 'B');
    assert.equal(readFileSync(join(b, 'data'), 'utf8'), 'A');
    assert.throws(() => publishNoReplace(a, b), { code: 'EEXIST' });
    assert.equal(readFileSync(join(a, 'data'), 'utf8'), 'B');
    assert.equal(readFileSync(join(b, 'data'), 'utf8'), 'A');
    publishNoReplace(a, join(root, 'published'));
    assert.equal(readFileSync(join(root, 'published/data'), 'utf8'), 'B');
    const lock = join(root, 'operation.lock');
    const fd = openSync(lock, 'a+', 0o600);
    const child = `import {openSync} from 'node:fs';import {tryLock} from ${JSON.stringify(url.href)};process.exit(tryLock(openSync(process.argv[1],'a+'))?0:2);`;
    const compete = () => spawnSync(process.execPath, ['--input-type=module', '-e', child, lock]);
    try {
      assert.equal(tryLock(fd), true);
      assert.equal(compete().status, 2);
    } finally { closeSync(fd); }
    assert.equal(compete().status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
