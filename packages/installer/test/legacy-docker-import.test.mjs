import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importLegacyVolume } from '../assets/scripts/runtime/legacy-import.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'legacy-volume-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'input'), storageRoot = join(root, 'volume'), targetRoot = '/selected/installation';
  fs.mkdirSync(sourceRoot, { mode: 0o700 }); fs.mkdirSync(storageRoot, { mode: 0o700 });
  const receipt = { sourceStateDir: '/legacy/state', sourceConfigPath: '/legacy/state/config.json', targetRoot, rootName: 'Human' };
  for (const component of ['daemon', 'mcp']) {
    const dir = join(sourceRoot, component); fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(join(dir, '.ours-legacy-import.json'), JSON.stringify(receipt), { mode: 0o600 });
    fs.writeFileSync(join(dir, 'opaque-state'), component + '-bytes', { mode: 0o600 });
  }
  const options = { sourceRoot, storageRoot, targetRoot, uid: process.getuid(), gid: process.getgid() };
  return { sourceRoot, storageRoot, receipt, options };
}
test('imports daemon and MCP bytes with selected ownership without touching source', t => {
  const f = fixture(t); importLegacyVolume(f.options);
  for (const component of ['daemon', 'mcp']) {
    const target = join(f.storageRoot, 'state', component, 'opaque-state');
    assert.equal(fs.readFileSync(target, 'utf8'), component + '-bytes');
    assert.equal(fs.statSync(target).uid, process.getuid());
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(join(f.sourceRoot, component, 'opaque-state'), 'utf8'), component + '-bytes');
  }
});
test('matching retries preserve changed live state and can finish a partial pair', t => {
  const f = fixture(t); importLegacyVolume(f.options);
  const live = join(f.storageRoot, 'state/mcp/opaque-state'); fs.writeFileSync(live, 'live');
  fs.rmSync(join(f.storageRoot, 'state/daemon'), { recursive: true });
  importLegacyVolume(f.options); assert.equal(fs.readFileSync(live, 'utf8'), 'live');
});
for (const invalid of ['different target', 'mismatched pair', 'symlink', 'hardlink', 'unsafe mode']) test(`refuses ${invalid} before volume mutation`, t => {
  const f = fixture(t), input = join(f.sourceRoot, 'mcp');
  if (invalid === 'different target') f.options.targetRoot = '/another/target';
  if (invalid === 'mismatched pair') fs.writeFileSync(join(input, '.ours-legacy-import.json'), JSON.stringify({ ...f.receipt, rootName: 'Other' }));
  if (invalid === 'symlink') fs.symlinkSync('/etc/passwd', join(input, 'link'));
  if (invalid === 'hardlink') fs.linkSync(join(input, 'opaque-state'), join(input, 'link'));
  if (invalid === 'unsafe mode') fs.chmodSync(join(input, 'opaque-state'), 0o644);
  assert.throws(() => importLegacyVolume(f.options)); assert.deepEqual(fs.readdirSync(f.storageRoot), []);
});
test('existing nonempty destination without receipt is retained', t => {
  const f = fixture(t); fs.mkdirSync(join(f.storageRoot, 'state/daemon'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(f.storageRoot, 'state/daemon/existing'), 'retained', { mode: 0o600 });
  assert.throws(() => importLegacyVolume(f.options), /destination/);
  assert.equal(fs.readFileSync(join(f.storageRoot, 'state/daemon/existing'), 'utf8'), 'retained');
});
