// Removal execution against inert fake effects: nothing on this computer is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeRemoval, runRemoval } from '../lib/removal.mjs';
import { planRemoval, projectForRoot, tombstoneFor } from '../lib/removal-plan.mjs';
import { changedImages } from '../lib/ownership.mjs';
import { networkEffects, __testables } from '../lib/effects.mjs';
import { createServer } from 'node:http';

const home = '/home/u';
const A = '11111111-1111-1111-1111-111111111111';

/** A fake filesystem of { path: { type, uid, mode, text } } and a log of every mutation. */
function fakeEffects(files, extra = {}) {
  const log = [];
  const effects = {
    home, uid: 1, env: {}, interactive: true, out: () => {},
    stat: path => files[path] ? { type: files[path].type, uid: files[path].uid ?? 1, mode: files[path].mode ?? 0o700, id: files[path].id ?? `1:${path}` } : null,
    realpath: path => path,
    readText: path => files[path]?.text ?? null,
    list: dir => Object.keys(files).filter(p => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/')).map(p => p.slice(dir.length + 1)),
    removeDir: path => { log.push(['removeDir', path]); for (const p of Object.keys(files)) if (p === path || p.startsWith(path + '/')) delete files[p]; },
    removeFile: path => { log.push(['removeFile', path]); delete files[path]; },
    // A rename keeps the folder's identity, as on a real filesystem.
    renamePath: (from, to) => { log.push(['rename', from, to]); const id = files[from]?.id ?? `1:${from}`; for (const p of Object.keys(files)) if (p === from || p.startsWith(from + '/')) { files[to + p.slice(from.length)] = p === from ? { ...files[p], id } : files[p]; delete files[p]; } },
    writeText: (path, text) => { log.push(['write', path]); files[path] = { ...files[path], type: 'file', text }; },
    writeJson: (path, text) => { log.push(['journal', path]); files[path] = { type: 'file', text, mode: 0o600 }; },
    run: async (command, args) => { log.push(['run', command, ...args]); if (command === 'npm') return { stdout: '/home/u/.local\n' }; throw new Error(`${command} unavailable`); },
    holdInstallationLocks: async () => () => {},
    sleep: async () => {},
    portState: async () => 'refused',
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
  assert.equal((await executeRemoval({ steps: [{ ...step, kind: 'root' }] }, own.effects)).get(step.id).state, 'done');
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
  const running = fakeEffects({ ...files }, { portState: async () => 'open', probe: async () => ({ ok: true, stateDir: dir }), run: async (command, args) => { if (command === 'npm' && args[0] === 'root') return { stdout: '/x' }; throw new Error('stop failed'); } });
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

test('F3: an occupied tombstone name is never cleared without this removal\'s own record of it', async () => {
  const root = '/home/u/.ours-install';
  const tomb = tombstoneFor(root, A);
  const step = { id: `root:${root}`, group: 'data', label: 'root', type: 'retire', kind: 'root', path: root, recordFile: 'installation.json', recordField: 'instanceId', expectInstance: A, tombstone: tomb };
  const files = () => ({ [root]: { type: 'dir', id: '7:100' }, [`${root}/installation.json`]: { type: 'file', text: JSON.stringify({ instanceId: A }) }, [tomb]: { type: 'dir', id: '7:999' }, [`${tomb}/sentinel`]: { type: 'file', text: 'not ours' } });
  // Unrecorded occupant: refused, nothing moved or deleted.
  const foreign = fakeEffects(files());
  const result = await executeRemoval({ steps: [step] }, foreign.effects, { journal: { tombstones: [] } });
  assert.equal(result.get(step.id).state, 'failed');
  assert.match(result.get(step.id).reason, /was not put there by this removal/);
  assert.deepEqual(foreign.log.filter(([kind]) => kind !== 'run'), []);
  // Recorded with a different identity (substituted folder): refused.
  const swapped = fakeEffects(files());
  assert.equal((await executeRemoval({ steps: [step] }, swapped.effects, { journal: { tombstones: [{ kind: 'root', instanceId: A, id: '7:555' }] } })).get(step.id).state, 'failed');
  assert.ok(!swapped.log.some(([kind]) => kind === 'removeDir'));
  // The journal records the identity before the move, so an interrupted deletion can be proven later.
  const journal = { tombstones: [] };
  const saved = [];
  const clean = fakeEffects({ [root]: { type: 'dir', id: '7:100' }, [`${root}/installation.json`]: { type: 'file', text: JSON.stringify({ instanceId: A }) } }, { removeDir: path => { throw new Error(`interrupted while deleting ${path}`); } });
  await executeRemoval({ steps: [step] }, clean.effects, { journal, saveJournal: () => saved.push(JSON.stringify(journal.tombstones)) });
  assert.deepEqual(journal.tombstones, [{ kind: 'root', instanceId: A, id: '7:100' }]);
  assert.equal(saved.length, 1, 'saved before the rename');
});

test('F3: a retry finishes a partly deleted tombstone it recorded, and reports an unrecorded one', async () => {
  const root = '/home/u/.ours-install';
  const tomb = tombstoneFor(root, A);
  const journal = { schema: 1, startedAt: 'x', installations: [{ root, instanceId: A, project: projectForRoot(root), mode: 'packages', candidateProjects: [] }], clientInstanceIds: [], generations: [], fleet: false, legacy: false, installer: false,
    tombstones: [{ kind: 'root', instanceId: A, id: '7:100' }] };
  // Partly deleted: the record file inside is already gone, the folder identity remains.
  const proven = { [`${home}/.ours-removal.json`]: { type: 'file', mode: 0o600, text: JSON.stringify(journal) }, [tomb]: { type: 'dir', id: '7:100' }, [`${tomb}/runtime`]: { type: 'dir' } };
  const a = fakeEffects(proven, { askLine: async () => 'remove ours' });
  assert.equal(await runRemoval([], a.effects), 0);
  assert.ok(a.log.some(([kind, path]) => kind === 'removeDir' && path === tomb));
  // Same name, different folder: kept, reported, journal kept, exit 1.
  const swapped = { [`${home}/.ours-removal.json`]: { type: 'file', mode: 0o600, text: JSON.stringify(journal) }, [tomb]: { type: 'dir', id: '7:999' }, [`${tomb}/sentinel`]: { type: 'file', text: 'x' } };
  const b = fakeEffects(swapped, { askLine: async () => 'remove ours' });
  assert.equal(await runRemoval([], b.effects), 1);
  assert.ok(!b.log.some(([kind]) => kind === 'removeDir' || kind === 'removeFile'), JSON.stringify(b.log));
  assert.ok(swapped[`${tomb}/sentinel`] && swapped[`${home}/.ours-removal.json`]);
});

test('F5: an earlier daemon port that answers with an error or times out is not proof that it stopped', async () => {
  const dir = `${home}/.ours`;
  const service = { kind: 'daemon', label: 'stop', dir, port: 3999, cliStartedIt: true, unitPath: null };
  const plan = planRemoval({ installations: [], otherInstallations: [], generations: [], legacy: { remove: true, services: [service], dirs: [dir], blocks: [], skillDirs: [] } }, { home });
  const cases = [
    ['open', { ok: false, reason: 'HTTP 503' }, 'failed'],
    ['open', { ok: false, reason: 'no stateDir in reply' }, 'failed'],
    ['unknown', null, 'failed'],
    ['open', { ok: true, stateDir: `${home}/.other-ours` }, 'done'],
    ['refused', null, 'done'],
  ];
  for (const [port, probe, expected] of cases) {
    const files = { [dir]: { type: 'dir', mode: 0o755 } };
    const f = fakeEffects(files, { portState: async () => port, probe: async () => probe, run: async (command) => { if (command === 'npm') return { stdout: '/x' }; throw new Error('stop failed'); } });
    const results = await executeRemoval(plan, f.effects);
    assert.equal(results.get(`legacy-service:${dir}`).state, expected, `${port} ${JSON.stringify(probe)}`);
    assert.equal(Boolean(files[dir]), expected === 'failed', 'its data is kept unless the stop is proven');
  }
});

test('F6: damaged known Ours records keep the removal unfinished and its retry record', async () => {
  const root = '/home/u/.ours-install';
  const journal = { schema: 1, startedAt: 'x', installations: [{ root, instanceId: A, project: projectForRoot(root), mode: 'packages', candidateProjects: [] }], clientInstanceIds: [], generations: [], fleet: false, legacy: false, installer: false };
  const files = { [`${home}/.ours-removal.json`]: { type: 'file', mode: 0o600, text: JSON.stringify(journal) }, [root]: { type: 'dir' }, [`${root}/installation.json`]: { type: 'file', text: '{damaged' } };
  const f = fakeEffects(files, { askLine: async () => 'remove ours' });
  assert.equal(await runRemoval([], f.effects), 1);
  assert.ok(files[`${home}/.ours-removal.json`], 'the retry record is kept');
  assert.ok(files[`${root}/installation.json`]);
  // A damaged download owner record, without any retry record: also unfinished, nothing deleted.
  const gen = `${home}/.ours-client-install/aaaaaaaaaaaaaaaa`;
  const other = { [`${home}/.ours-client-install`]: { type: 'dir' }, [gen]: { type: 'dir' }, [`${gen}/owners.json`]: { type: 'file', text: 'garbage' } };
  const g = fakeEffects(other, { askLine: async () => 'remove ours' });
  assert.equal(await runRemoval([], g.effects), 1);
  assert.ok(!g.log.some(([kind]) => kind === 'removeDir'));
});

test('F5: with the real port checks, a live listener answering HTTP 503 keeps the earlier daemon\'s data; a closed port does not', async () => {
  const server = createServer((req, res) => { res.writeHead(503); res.end('busy'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  try {
    assert.equal(await __testables.portState(port), 'open');
    const dir = `${home}/.ours`;
    const plan = planRemoval({ installations: [], otherInstallations: [], generations: [], legacy: { remove: true, services: [{ kind: 'daemon', label: 'stop', dir, port, cliStartedIt: true, unitPath: null }], dirs: [dir], blocks: [], skillDirs: [] } }, { home });
    const files = { [dir]: { type: 'dir', mode: 0o755 } };
    const f = fakeEffects(files, { portState: port_ => __testables.portState(port_), probe: port_ => __testables.probePort(port_), run: async (command) => { if (command === 'npm') return { stdout: '/x' }; throw new Error('stop failed'); } });
    const results = await executeRemoval(plan, f.effects);
    assert.equal(results.get(`legacy-service:${dir}`).state, 'failed');
    assert.match(results.get(`legacy-service:${dir}`).reason, /could not be confirmed/);
    assert.ok(files[dir], 'the data is kept while the listener is alive');
  } finally { server.close(); }
  await new Promise(done => setTimeout(done, 50));
  assert.equal(await __testables.portState(port), 'refused');
});
