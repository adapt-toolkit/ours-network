import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readinessFaultShim, startCandidateRegistry, assertRetained, INSTALLER } from './nightly-qualification.mjs';

const run = promisify(execFile);
const selfUpdate = fileURLToPath(new URL('../packages/installer/lib/self-update.mjs', import.meta.url));

function temp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('readiness fault fails only the gateway readiness wait, after the real command ran', async t => {
  const dir = temp(t, 'qualification-shim-');
  const real = join(dir, 'real'), marker = join(dir, 'marker'), shim = join(dir, 'docker');
  writeFileSync(real, `#!/bin/sh\necho "REAL $*" >> '${join(dir, 'calls')}'\nexit \${REAL_STATUS:-0}\n`, { mode: 0o700 });
  writeFileSync(shim, readinessFaultShim(real, marker), { mode: 0o700 });
  const call = async (args, env = {}) => { try { await run(shim, args, { env: { ...process.env, ...env } }); return 0; } catch (error) { return error.code; } };
  const gateway = ['compose', '--project-directory', '/x', '--file', '/x/a.yaml', '--project-name', 'ours-1', 'up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', 'gateway'];
  assert.equal(await call(gateway), 1);
  assert.equal(await call(['compose', '--project-name', 'ours-1', 'up', '-d', '--no-build', '--no-deps', '--wait', 'messenger']), 0);
  assert.equal(await call(['compose', '--project-name', 'ours-1', 'logs', '--tail', '50', 'gateway']), 0);
  assert.equal(await call(['image', 'inspect', 'gateway']), 0);
  assert.equal(await call(gateway, { REAL_STATUS: '3' }), 3, 'a real failure is reported as itself');
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').length, 5, 'every call reached the real Docker');
  assert.equal(readFileSync(marker, 'utf8').trim(), gateway.join(' '));
  assert.throws(() => readinessFaultShim("/bin/it's", marker));
});

/** A fake upstream registry and a fake candidate whose bin records how it was started. */
async function fixture(t) {
  const dir = temp(t, 'qualification-registry-');
  const pkg = join(dir, 'pkg'); mkdirSync(pkg);
  const version = '9.9.9-nightly.4';
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: INSTALLER, version, type: 'module', bin: { 'ours-install': 'install.mjs' } }));
  writeFileSync(join(pkg, 'install.mjs'), `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.QUALIFICATION_MARKER, JSON.stringify({ version: '${version}', args: process.argv.slice(2) }) + '\\n');\n`);
  chmodSync(join(pkg, 'install.mjs'), 0o755);
  const env = { ...process.env, HOME: dir, npm_config_cache: join(dir, 'cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  // A separate cache: npm pack stores the archive by integrity, and npx must download it from the registry.
  const [packed] = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', dir], { cwd: pkg, env: { ...env, npm_config_cache: join(dir, 'pack-cache') } })).stdout);
  const upstreamRequests = [];
  const upstream = createServer((req, res) => {
    upstreamRequests.push(`${req.method} ${req.url}`);
    if (decodeURIComponent(req.url).toLowerCase() === `/${INSTALLER}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: INSTALLER, 'dist-tags': { latest: '2.1.0', nightly: '2.1.1-nightly.1' }, versions: { '2.1.0': { name: INSTALLER, version: '2.1.0' } }, time: { '2.1.0': '2026-01-01T00:00:00.000Z' } }));
    } else if (req.url === '/other') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('upstream body'); }
    else { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const registry = await startCandidateRegistry({ tarball: join(dir, packed.filename), manifest: JSON.parse(readFileSync(join(pkg, 'package.json'))), integrity: packed.integrity, shasum: packed.shasum,
    upstream: `http://127.0.0.1:${upstream.address().port}` });
  t.after(registry.close);
  return { dir, version, env: { ...env, npm_config_registry: registry.url }, registry, upstreamRequests };
}

test('the candidate registry moves only nightly, proxies reads and refuses writes', async t => {
  const f = await fixture(t);
  const document = await (await fetch(`${f.registry.url}@ours.network%2finstall`)).json();
  assert.deepEqual(document['dist-tags'], { latest: '2.1.0', nightly: f.version });
  assert.deepEqual(Object.keys(document.versions).sort(), ['2.1.0', f.version]);
  assert.match(document.versions[f.version].dist.tarball, /^http:\/\/127\.0\.0\.1:\d+\/-\/qualification-candidate\//);
  assert.equal(await (await fetch(`${f.registry.url}other`)).text(), 'upstream body');
  for (const method of ['PUT', 'POST', 'DELETE']) assert.equal((await fetch(`${f.registry.url}@ours.network%2finstall`, { method, body: method === 'DELETE' ? undefined : '{}' })).status, 405);
  assert.ok(f.upstreamRequests.every(line => line.startsWith('GET ')), 'nothing but reads reached upstream');
  assert.equal((await run('npm', ['view', `${INSTALLER}@nightly`, 'version'], { env: f.env })).stdout.trim(), f.version);
  assert.equal((await run('npm', ['view', `${INSTALLER}@latest`, 'version'], { env: f.env })).stdout.trim(), '2.1.0');
});

test('the installer launcher\'s `update --nightly` starts the served candidate through npx, with no arguments', async t => {
  const f = await fixture(t);
  const marker = join(f.dir, 'started');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { runSelfUpdate } from ${JSON.stringify(selfUpdate)}; process.exitCode = runSelfUpdate('nightly');`],
    { env: { ...f.env, QUALIFICATION_MARKER: marker }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0, output);
  assert.ok(existsSync(marker), output);
  assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [{ version: f.version, args: [] }]);
  assert.ok(f.registry.requests.includes(`GET ${f.registry.tarballPath}`), 'npx downloaded the served candidate archive: ' + f.registry.requests.join(', '));
});

test('retention comparison allows only the version and the unread filter to change', () => {
  const baseline = { version: '1.0.1', unreadFilter: { filter: null, ids: ['a', 'b'] }, stateSha256: 'x', inbox: { items: [{ id: 'a', readAt: null }, { id: 'b', readAt: 't' }] }, credentials: { owner: 'o' } };
  const current = { ...structuredClone(baseline), version: '1.0.3-nightly.1', unreadFilter: { filter: 'unread', ids: ['a'] } };
  assertRetained(baseline, current, '1.0.3-nightly.1', 'fixture');
  assert.throws(() => assertRetained(baseline, { ...current, stateSha256: 'y' }, '1.0.3-nightly.1', 'fixture'), /retained exactly/);
  assert.throws(() => assertRetained(baseline, { ...current, credentials: { owner: 'p' } }, '1.0.3-nightly.1', 'fixture'), /retained exactly/);
  assert.throws(() => assertRetained(baseline, { ...current, unreadFilter: { filter: null, ids: ['a', 'b'] } }, '1.0.3-nightly.1', 'fixture'), /unread filter/);
  assert.throws(() => assertRetained(baseline, current, '1.0.2', 'fixture'), /candidate Notifications is running/);
});
