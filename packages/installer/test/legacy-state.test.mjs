import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLegacyState, stageLegacyState, ensureLegacyLockSupport, withLegacyStateLock } from '../lib/legacy-state.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(join(tmpdir(), 'legacy-state-')); fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = join(base, 'legacy'), target = join(base, 'target'); fs.mkdirSync(source, { mode: 0o700 });
  const write = (name, value) => fs.writeFileSync(join(source, name), typeof value === 'object' ? JSON.stringify(value) : value, { mode: 0o600 });
  write('config.json', { stateDir: source, port: 3050, brokerUrl: 'wss://private.example', unknown: { retain: true } });
  write('root.json', { v: 1, name: 'Human' }); fs.mkdirSync(join(source, 'Human'), { mode: 0o700 });
  write('Human/identity.key', 'opaque-key'); write('Human/state_data.bin', 'opaque-state');
  return { base, source, target, write, inspect: () => inspectLegacyState(join(source, 'config.json'), target), record: { root: target, schema: 2, mode: 'packages', port: 3051, instanceId: '00000000-0000-4000-8000-000000000001' } };
}
test('inspection follows declared stateDir and retains root name without inventing CID', t => {
  const f = fixture(t); const external = join(f.base, 'selected.json');
  fs.copyFileSync(join(f.source, 'config.json'), external); fs.chmodSync(external, 0o600);
  const result = inspectLegacyState(external, f.target);
  assert.equal(result.stateDir, f.source); assert.equal(result.rootName, 'Human'); assert.equal(result.rootCid, null);
});
test('custom config missing stateDir refuses ambiguous selection', t => {
  const f = fixture(t); f.write('config.json', { port: 3050 }); assert.throws(f.inspect, /explicit stateDir/);
});
for (const name of ['overlap', 'symlink', 'unsafe config', 'missing key', 'bad root', 'postgres', 'external MCP', 'provenance']) test(`inspection refuses ${name} before copy`, t => {
  const f = fixture(t);
  if (name === 'overlap') f.target = join(f.source, 'target');
  if (name === 'symlink') { fs.symlinkSync(f.source, join(f.base, 'link')); f.target = join(f.base, 'link/target'); }
  if (name === 'unsafe config') fs.chmodSync(join(f.source, 'config.json'), 0o644);
  if (name === 'missing key') fs.unlinkSync(join(f.source, 'Human/identity.key'));
  if (name === 'bad root') f.write('root.json', { v: 1, name: '../Human' });
  if (name === 'provenance') fs.mkdirSync(join(f.source, '.ours-provenance'), { mode: 0o700 });
  if (name === 'postgres') f.write('config.json', { database: { provider: 'postgresql', url: 'postgresql://local/db' } });
  if (name === 'external MCP') f.write('config.json', { networkMcp: { applicationConfigPath: '/external/config.json' } });
  assert.throws(() => inspectLegacyState(join(f.source, 'config.json'), f.target));
  assert.equal(fs.existsSync(join(f.target, 'storage/state/daemon')), false);
});
for (const mode of ['packages', 'docker']) test(`staging preserves opaque files and source while binding ${mode}`, async t => {
  const f = fixture(t); f.record.mode = mode;
  for (const name of ['Human/history.sqlite3', 'Human/history.sqlite3-wal', 'Human/history.sqlite3-shm', 'unknown.data', 'daemon-token', 'api-master.key']) f.write(name, 'exact-' + name);
  for (const name of ['daemon.pid', 'ours-cli-daemon.json', 'startup-progress.json']) f.write(name, 'old');
  const before = fs.readFileSync(join(f.source, 'config.json'));
  fs.mkdirSync(join(f.target, 'storage/state'), { recursive: true, mode: 0o700 });
  await stageLegacyState(f.inspect(), f.record);
  const dest = join(f.target, 'storage/state/daemon');
  assert.equal(fs.readFileSync(join(dest, 'Human/history.sqlite3-wal'), 'utf8'), 'exact-Human/history.sqlite3-wal');
  assert.equal(fs.readFileSync(join(dest, 'unknown.data'), 'utf8'), 'exact-unknown.data');
  const cfg = JSON.parse(fs.readFileSync(join(dest, 'config.json')));
  assert.equal(cfg.stateDir, mode === 'docker' ? '/var/lib/ours' : dest); assert.equal(cfg.port, mode === 'docker' ? 3050 : 3051); assert.deepEqual(cfg.unknown, { retain: true });
  assert.deepEqual(fs.readFileSync(join(f.source, 'config.json')), before);
  assert.equal(fs.existsSync(join(dest, 'daemon.pid')), false); assert.equal(fs.existsSync(join(f.source, 'daemon.pid')), true);
  fs.writeFileSync(join(dest, 'new-live.data'), 'retained', { mode: 0o600 });
  assert.equal((await stageLegacyState(f.inspect(), f.record)).reused, true);
  assert.equal(fs.readFileSync(join(dest, 'new-live.data'), 'utf8'), 'retained');
});
test('source lock refuses a concurrent owner and releases after callback failure', async t => {
  const f = fixture(t); await ensureLegacyLockSupport();
  await withLegacyStateLock(f.source, async () => {
    await assert.rejects(withLegacyStateLock(f.source, () => assert.fail('entered locked state')), /owned|live/);
  });
  await assert.rejects(withLegacyStateLock(f.source, () => { throw new Error('callback failure'); }), /callback failure/);
  await withLegacyStateLock(f.source, () => {});
});

test('staging refuses existing data without migration receipt', async t => {
  const f = fixture(t), dest = join(f.target, 'storage/state/daemon');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 }); fs.writeFileSync(join(dest, 'config.json'), '{}', { mode: 0o600 });
  assert.throws(() => stageLegacyState(f.inspect(), f.record), /destination/);
  assert.equal(fs.readFileSync(join(dest, 'config.json'), 'utf8'), '{}');
});
test('empty skeleton accepts migration but foreign receipt does not', async t => {
  const f = fixture(t), dest = join(f.target, 'storage/state/daemon');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  assert.equal((await stageLegacyState(f.inspect(), f.record)).reused, false);
  fs.writeFileSync(join(dest, '.ours-legacy-import.json'), '{}', { mode: 0o600 });
  assert.throws(() => stageLegacyState(f.inspect(), f.record), /receipt/);
});

test('lock handle overload retains ownership until close', async t => {
  const f = fixture(t); const lock = await withLegacyStateLock(f.source);
  try { await assert.rejects(withLegacyStateLock(f.source), /owned|live/); }
  finally { await lock.close(); }
  await lock.close();
  const next = await withLegacyStateLock(f.source); await next.close();
});
for (const mode of ['packages', 'docker']) test(`embedded MCP data is published in managed sibling for ${mode}`, t => {
  const f = fixture(t); f.record.mode = mode; fs.mkdirSync(join(f.source, '.mcp'), { mode: 0o700 });
  f.write('.mcp/config.json', { opaque: 'retain' }); f.write('.mcp/profile.json', {});
  f.write('config.json', { stateDir: f.source, apiToken: 'legacy-secret', unknown: 'retain', networkMcp: { applicationConfigPath: join(f.source, '.mcp/config.json'), profile: { credentialPath: join(f.source, 'daemon-token'), expectedInstanceId: 'old', endpoint: 'http://127.0.0.1:3050' } } });
  fs.mkdirSync(join(f.target, 'storage/state'), { recursive: true, mode: 0o700 });
  const { destination } = stageLegacyState(f.inspect(), f.record);
  const config = JSON.parse(fs.readFileSync(join(destination, 'config.json')));
  const mcp = join(f.target, 'storage/state/mcp');
  assert.deepEqual(config.networkMcp, {
    applicationConfigPath: mode === 'docker' ? '/var/lib/ours-mcp/config.json' : join(mcp, 'config.json'),
    profile: { endpoint: mode === 'docker' ? 'http://127.0.0.1:3050' : 'http://127.0.0.1:3051', expectedInstanceId: f.record.instanceId, credentialPath: mode === 'docker' ? '/var/lib/ours/daemon-token' : join(destination, 'daemon-token') },
  });
  assert.equal(config.apiToken, undefined); assert.equal(config.unknown, 'retain');
  assert.equal(JSON.parse(fs.readFileSync(join(f.source, 'config.json'))).apiToken, 'legacy-secret');
  assert.deepEqual(JSON.parse(fs.readFileSync(join(mcp, 'profile.json'))), config.networkMcp.profile);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(mcp, 'config.json'))), { opaque: 'retain' });
  fs.writeFileSync(join(mcp, 'live-state'), 'keep', { mode: 0o600 });
  assert.equal(stageLegacyState(f.inspect(), f.record).reused, true);
  assert.equal(fs.readFileSync(join(mcp, 'live-state'), 'utf8'), 'keep');
  assert.deepEqual(JSON.parse(fs.readFileSync(join(destination, '.mcp/config.json'))), { opaque: 'retain' });
});

test('MCP receipt supports interrupted daemon publication without recopying MCP state', t => {
  const f = fixture(t); fs.mkdirSync(join(f.target, 'storage/state'), { recursive: true, mode: 0o700 });
  const first = stageLegacyState(f.inspect(), f.record);
  fs.renameSync(first.destination, join(f.target, 'storage/state/unpublished-daemon'));
  const live = join(f.target, 'storage/state/mcp/new-state'); fs.writeFileSync(live, 'retain', { mode: 0o600 });
  assert.equal(stageLegacyState(f.inspect(), f.record).reused, false);
  assert.equal(fs.readFileSync(live, 'utf8'), 'retain');
});
test('nonempty MCP destination without receipt is not overwritten', t => {
  const f = fixture(t), mcp = join(f.target, 'storage/state/mcp');
  fs.mkdirSync(mcp, { recursive: true, mode: 0o700 }); fs.writeFileSync(join(mcp, 'existing'), 'retain', { mode: 0o600 });
  assert.throws(() => stageLegacyState(f.inspect(), f.record), /MCP destination/);
  assert.equal(fs.existsSync(join(f.target, 'storage/state/daemon')), false);
  assert.equal(fs.readFileSync(join(mcp, 'existing'), 'utf8'), 'retain');
});
