// Removal execution against inert fake effects: nothing on this computer is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeRemoval, runRemoval } from '../lib/removal.mjs';
import { planRemoval, projectForRoot, tombstoneFor } from '../lib/removal-plan.mjs';
import { changedImages } from '../lib/ownership.mjs';
import { networkEffects } from '../lib/effects.mjs';

const home = '/home/u';
const A = '11111111-1111-1111-1111-111111111111';

/** A fake filesystem of { path: { type, uid, mode, text } } and a log of every mutation. */
function fakeEffects(files, extra = {}) {
  const log = [];
  const effects = {
    home, uid: 1, env: {}, interactive: true, out: () => {},
    stat: path => files[path] ? { type: files[path].type, uid: files[path].uid ?? 1, mode: files[path].mode ?? 0o700 } : null,
    realpath: path => path,
    readText: path => files[path]?.text ?? null,
    list: dir => Object.keys(files).filter(p => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/')).map(p => p.slice(dir.length + 1)),
    removeDir: path => { log.push(['removeDir', path]); for (const p of Object.keys(files)) if (p === path || p.startsWith(path + '/')) delete files[p]; },
    removeFile: path => { log.push(['removeFile', path]); delete files[path]; },
    renamePath: (from, to) => { log.push(['rename', from, to]); for (const p of Object.keys(files)) if (p === from || p.startsWith(from + '/')) { files[to + p.slice(from.length)] = files[p]; delete files[p]; } },
    writeText: (path, text) => { log.push(['write', path]); files[path] = { ...files[path], type: 'file', text }; },
    writeJson: (path, text) => { log.push(['journal', path]); files[path] = { type: 'file', text, mode: 0o600 }; },
    run: async (command, args) => { log.push(['run', command, ...args]); if (command === 'npm') return { stdout: '/home/u/.local\n' }; throw new Error(`${command} unavailable`); },
    holdInstallationLocks: async () => () => {},
    sleep: async () => {},
    ...extra,
  };
  return { effects, log };
}

test('F3: a root is deleted only while it still holds its own record, through a tombstone', async () => {
  const root = '/synthetic/home/unrelated-private-project';
  const step = { id: `root:${root}`, group: 'data', label: 'root', type: 'retire', path: root, recordFile: 'installation.json', recordField: 'instanceId', expectInstance: A, tombstone: tombstoneFor(root, A) };
  // Absent record: never reaches removeDir.
  const absent = fakeEffects({ [root]: { type: 'dir' }, [`${root}/precious`]: { type: 'file', text: 'x' } });
  const results = await executeRemoval({ steps: [step] }, absent.effects);
  assert.equal(results.get(step.id).state, 'failed');
  assert.deepEqual(absent.log.filter(([kind]) => kind !== 'run'), []);
  // A different or damaged record: also refused.
  for (const text of [JSON.stringify({ instanceId: '22222222-2222-2222-2222-222222222222' }), '{not json']) {
    const other = fakeEffects({ [root]: { type: 'dir' }, [`${root}/installation.json`]: { type: 'file', text } });
    assert.equal((await executeRemoval({ steps: [step] }, other.effects)).get(step.id).state, 'failed');
    assert.ok(!other.log.some(([kind]) => kind === 'removeDir' || kind === 'rename'));
  }
  // The matching record: renamed aside first, then deleted.
  const own = fakeEffects({ [root]: { type: 'dir' }, [`${root}/installation.json`]: { type: 'file', text: JSON.stringify({ instanceId: A }) } });
  assert.equal((await executeRemoval({ steps: [step] }, own.effects)).get(step.id).state, 'done');
  assert.deepEqual(own.log.filter(([kind]) => kind !== 'run'), [['rename', root, step.tombstone], ['removeDir', step.tombstone]]);
});

test('F3: a retry record naming an unrelated private folder is refused before anything happens', async () => {
  const journal = { schema: 1, startedAt: 'x', installations: [{ root: '/synthetic/home/unrelated-private-project', instanceId: A, project: 'ours-123', mode: 'docker', candidateProjects: [] }], clientInstanceIds: [], generations: [], fleet: false, legacy: false, installer: false };
  const { effects, log } = fakeEffects({ [`${home}/.ours-removal.json`]: { type: 'file', mode: 0o600, text: JSON.stringify(journal) }, '/synthetic/home/unrelated-private-project': { type: 'dir' } });
  assert.equal(await runRemoval([], effects), 2);
  assert.deepEqual(log, []);
});

test('F3: a retried root that lost its record is a residual, never a deletion', async () => {
  const root = '/home/u/.ours-install';
  const journal = { schema: 1, startedAt: 'x', installations: [{ root, instanceId: A, project: projectForRoot(root), mode: 'packages', candidateProjects: [] }], clientInstanceIds: [], generations: [], fleet: false, legacy: false, installer: false };
  const files = { [`${home}/.ours-removal.json`]: { type: 'file', mode: 0o600, text: JSON.stringify(journal) }, [root]: { type: 'dir' }, [`${root}/someone-elses`]: { type: 'file', text: 'x' } };
  const { effects, log } = fakeEffects(files, { askLine: async () => 'remove ours' });
  const code = await runRemoval([], effects);
  assert.ok(!log.some(([kind, path]) => (kind === 'removeDir' || kind === 'rename') && path.startsWith(root)), JSON.stringify(log));
  assert.ok(files[`${root}/someone-elses`]);
  assert.equal(code, 1, 'the run stays unfinished and says why');
});

test('F5: a legacy daemon that is still running blocks its data and packages; a verified stop does not', async () => {
  const dir = `${home}/.ours`;
  const service = { kind: 'daemon', label: 'stop', dir, port: 3050, cliStartedIt: true, unitPath: `${home}/.config/systemd/user/ours.service` };
  const found = { installations: [], otherInstallations: [], generations: [], legacy: { remove: true, services: [service], dirs: [dir], blocks: [], skillDirs: [] },
    npm: { bins: [], packages: [{ name: '@ours.network/daemon', link: false }] } };
  const plan = planRemoval(found, { home });
  const ids = plan.steps.map(s => s.id);
  assert.ok(ids.indexOf(`legacy-service:${dir}`) < ids.indexOf('npm:@ours.network/daemon'), 'stops come before the packages that provide them');
  const files = { [dir]: { type: 'dir', mode: 0o755 }, [service.unitPath]: { type: 'file' } };
  const running = fakeEffects({ ...files }, { probe: async () => ({ ok: true, stateDir: dir }), run: async (command, args) => { if (command === 'npm' && args[0] === 'root') return { stdout: '/x' }; throw new Error('stop failed'); } });
  const results = await executeRemoval(plan, running.effects);
  assert.equal(results.get(`legacy-service:${dir}`).state, 'failed');
  assert.match(results.get(`legacy-service:${dir}`).reason, /still running/);
  assert.equal(results.get(`legacy:${dir}`).state, 'failed', 'its data is kept');
  assert.equal(results.get('npm:@ours.network/daemon').state, 'failed', 'its package is kept');
  assert.ok(!running.log.some(([kind]) => kind === 'removeDir'));
  // Command errors with a verified stopped daemon and removed unit are not failures.
  const stoppedFiles = { [dir]: { type: 'dir', mode: 0o755 } };
  const stopped = fakeEffects(stoppedFiles, { probe: async () => ({ ok: false, reason: 'refused' }), run: async (command, args) => { if (command === 'npm') return { stdout: '/x' }; throw new Error('not running'); } });
  const done = await executeRemoval(plan, stopped.effects);
  assert.equal(done.get(`legacy-service:${dir}`).state, 'done');
  assert.equal(done.get(`legacy:${dir}`).state, 'done');
});

test('F4: only images this run created or replaced become proof; a foreign tag found unchanged is not adopted', async t => {
  const before = { 'ours-a:runtime': 'sha256:' + '1'.repeat(64), 'ours-a:gateway': 'sha256:' + 'f'.repeat(64) };
  const after = { 'ours-a:runtime': 'sha256:' + '2'.repeat(64), 'ours-a:gateway': 'sha256:' + 'f'.repeat(64), 'ours-a:maintenance': 'sha256:' + '3'.repeat(64) };
  assert.deepEqual(changedImages(before, after), { 'ours-a:runtime': after['ours-a:runtime'], 'ours-a:maintenance': after['ours-a:maintenance'] });
  // The real recorder writes exactly what it is given, even with a foreign :gateway present.
  const root = mkdtempSync(join(tmpdir(), 'ours-owned-images-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = async (command, args) => ({ code: 0, stdout: args.at(-1).endsWith(':gateway') ? 'sha256:' + 'f'.repeat(64) + '\n' : 'sha256:' + '2'.repeat(64) + '\n' });
  const net = networkEffects({ env: {}, home: root, run, out: () => {} });
  const record = { root, project: 'ours-a', mode: 'docker' };
  await net.recordOwnedImages(record, {});
  assert.equal(existsSync(join(root, 'owned-images.json')), false, 'nothing built, nothing recorded');
  await net.recordOwnedImages(record, changedImages(before, await net.imageIds(record, ['runtime', 'gateway'])));
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'owned-images.json'), 'utf8')).images, { 'ours-a:runtime': 'sha256:' + '2'.repeat(64) });
  writeFileSync(join(root, 'owned-images.json'), '{damaged');
  await net.recordOwnedImages(record, { 'ours-a:runtime': 'sha256:' + '4'.repeat(64) });
  assert.equal(readFileSync(join(root, 'owned-images.json'), 'utf8'), '{damaged', 'a damaged record is left for a person to look at');
});
