import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const script = new URL('../assets/scripts/runtime/start-messenger.sh', import.meta.url).pathname;
const flockAvailable = spawnSync('flock', ['--version']).status === 0;
// Each stub records that it ran; the real script decides which of them runs.
const recorder = name => `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.RECORD, JSON.stringify({ name: ${JSON.stringify(name)}, argv: process.argv.slice(2), origin: process.env.OURS_NOTIFICATIONS_ORIGIN ?? null, token: process.env.OURS_NOTIFICATIONS_PRODUCER_TOKEN ?? null }) + '\\n');`;

function fixture(t, { notifications = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ours-start-messenger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, 'runtime'), state = join(root, 'messenger'), notes = join(root, 'notifications');
  for (const dir of [join(runtime, 'docker'), join(runtime, 'node_modules/@ours.network/messenger-server/dist'), state, notes]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(runtime, 'docker/check-client.mjs'), recorder('check'));
  writeFileSync(join(runtime, 'docker/supervise.mjs'), recorder('supervise'));
  writeFileSync(join(runtime, 'node_modules/@ours.network/messenger-server/dist/cli.js'), recorder('messenger'));
  if (notifications) {
    mkdirSync(join(runtime, 'node_modules/@ours.network/notifications'), { recursive: true });
    writeFileSync(join(runtime, 'node_modules/@ours.network/notifications/package.json'), '{}');
  }
  writeFileSync(join(notes, 'config.json'), '{}', { mode: 0o600 });
  writeFileSync(join(notes, 'state.json.lock'), 'stale', { mode: 0o600 });
  writeFileSync(join(root, 'producer'), 'p'.repeat(43), { mode: 0o600 });
  const record = join(root, 'record.jsonl');
  const env = { PATH: process.env.PATH, RECORD: record, OURS_RUNTIME_ROOT: runtime, OURS_MESSENGER_STATE_DIR: state,
    OURS_NOTIFICATIONS_CONFIG: join(notes, 'config.json'), OURS_NOTIFICATIONS_PRODUCER_FILE: join(root, 'producer') };
  const run = () => spawnSync('/bin/sh', [script], { env, encoding: 'utf8', timeout: 10000 });
  const records = () => existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const hold = async dir => {
    const holder = spawn('flock', ['-n', dir, 'sleep', '30'], { stdio: 'ignore' });
    t.after(() => holder.kill());
    await sleep(200);
    assert.equal(holder.exitCode, null, 'test holder must own the lock');
  };
  return { state, notes, run, records, hold };
}

test('a competing Messenger writer stops the script before anything starts', { skip: !flockAvailable }, async t => {
  const f = fixture(t);
  await f.hold(f.state);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Messenger state is in use/);
  assert.deepEqual(f.records(), []);
  assert.equal(readFileSync(join(f.notes, 'state.json.lock'), 'utf8'), 'stale');
});

test('a competing notification writer keeps its lock file and nothing is supervised', { skip: !flockAvailable }, async t => {
  const f = fixture(t);
  await f.hold(f.notes);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /notification state is in use/);
  assert.deepEqual(f.records().map(r => r.name), ['check']);
  assert.equal(readFileSync(join(f.notes, 'state.json.lock'), 'utf8'), 'stale');
});

test('with both locks held, the stale lock is cleared and Messenger runs beside the service', { skip: !flockAvailable }, t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.notes, 'state.json.lock')), false);
  const [check, supervise] = f.records();
  assert.equal(check.name, 'check');
  assert.equal(supervise.name, 'supervise');
  assert.equal(supervise.origin, 'http://127.0.0.1:49677');
  assert.equal(supervise.token, 'p'.repeat(43));
  const [messenger, service] = JSON.parse(supervise.argv[0]);
  assert.match(messenger.join(' '), /messenger-server\/dist\/cli\.js serve$/);
  assert.deepEqual(service.slice(0, 3), ['env', '-u', 'OURS_NOTIFICATIONS_PRODUCER_TOKEN']);
  assert.match(service.at(-1), /docker\/notifications-gateway\.mjs$/);
});

test('a runtime without the service starts Messenger alone and leaves notification state untouched', { skip: !flockAvailable }, t => {
  const f = fixture(t, { notifications: false });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.records().map(r => [r.name, r.origin, r.token]), [['check', null, null], ['messenger', null, null]]);
  assert.equal(readFileSync(join(f.notes, 'state.json.lock'), 'utf8'), 'stale');
});
