import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PACKAGE_NAMES } from './release-manifest.mjs';
import { DEGRADING_CAPABILITIES, REQUIRED_CAPABILITIES } from './release-capabilities.mjs';

const fleet = '@ours.network/fleet';
function fixture(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'release-select-fixture-'));
  for (const p of ['scripts', 'releases', 'packages/installer/assets', 'bin', 'archive/package/dist']) mkdirSync(join(dir, p), { recursive: true });
  for (const file of ['release-manifest.mjs', 'release-capabilities.mjs', 'select-release-package.mjs']) cpSync(new URL(file, import.meta.url), join(dir, 'scripts', file));
  const capabilities = mode === 'effort-bug' ? [...REQUIRED_CAPABILITIES[fleet].filter(token => token !== 'managed-cli.codex-reasoning-effort-v1'), ...DEGRADING_CAPABILITIES[fleet]] : mode === 'old-fleet' ? REQUIRED_CAPABILITIES[fleet] : [...REQUIRED_CAPABILITIES[fleet], ...DEGRADING_CAPABILITIES[fleet]];
  writeFileSync(join(dir, 'archive/package/dist/build-info.json'), JSON.stringify({ capabilities }));
  assert.equal(spawnSync('tar', ['-czf', join(dir, 'published.tgz'), '-C', join(dir, 'archive'), 'package']).status, 0);
  const published = `sha512-${createHash('sha512').update(readFileSync(join(dir, 'published.tgz'))).digest('base64')}`;
  const old = `sha512-${createHash('sha512').update('old').digest('base64')}`;
  const manifest = { schema: 1, channel: 'nightly', installerVersion: '1.2.0-nightly.3',
    packages: Object.fromEntries(PACKAGE_NAMES.map(n => [n, { version: '1.2.0-nightly.44', integrity: old }])) };
  writeFileSync(join(dir, 'releases/nightly.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, 'packages/installer/package.json'), JSON.stringify({ version: '1.2.0-nightly.3' }));
  writeFileSync(join(dir, 'packages/installer/assets/sources.json'), 'stale\n');
  writeFileSync(join(dir, 'packages/installer/README.md'), 'pins Fleet `1.2.0-nightly.44` here; selects published Fleet `1.2.0-nightly.44`; Cowork `1.2.0-nightly.44` stays.\n');
  writeFileSync(join(dir, 'bin/npm'), `#!${process.execPath}
const fs=require('node:fs');const mode=process.env.SELECT_FIXTURE;
if(process.argv[2]==='view'){
 if(mode==='unpublished'){console.error('npm error code E404');process.exit(1);}
 console.log(JSON.stringify(mode==='tampered'?${JSON.stringify(old)}:${JSON.stringify(published)}));
}else if(process.argv[2]==='pack'){
 const spec=process.argv[3];const pos=spec.lastIndexOf('@');
 fs.copyFileSync(${JSON.stringify(join(dir, 'published.tgz'))},'fixture.tgz');
 console.log(JSON.stringify([{name:spec.slice(0,pos),version:spec.slice(pos+1),filename:'fixture.tgz'}]));
}else process.exit(91);
`, { mode: 0o755 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OURS_') && !k.toLowerCase().startsWith('npm_config_')));
  Object.assign(env, { PATH: `${join(dir, 'bin')}:${env.PATH}`, SELECT_FIXTURE: mode });
  const run = (...args) => spawnSync(process.execPath, [join(dir, 'scripts/select-release-package.mjs'), ...args], { env, encoding: 'utf8', timeout: 30_000 });
  const read = file => readFileSync(join(dir, file), 'utf8');
  return { dir, run, read, manifest, published };
}

test('selects a published component with the registry integrity and regenerates the embedded policy', () => {
  const f = fixture('valid');
  try {
    const r = f.run(fleet, '1.2.0-nightly.45');
    assert.equal(r.status, 0, r.stderr);
    const manifest = JSON.parse(f.read('releases/nightly.json'));
    assert.deepEqual(manifest.packages[fleet], { version: '1.2.0-nightly.45', integrity: f.published });
    for (const name of PACKAGE_NAMES.filter(n => n !== fleet)) assert.deepEqual(manifest.packages[name], f.manifest.packages[name]);
    assert.equal(manifest.installerVersion, '1.2.0-nightly.3');
    const sources = JSON.parse(f.read('packages/installer/assets/sources.json'));
    assert.deepEqual(sources.release, manifest);
    assert.deepEqual(sources.packages[fleet], { type: 'npm', version: '1.2.0-nightly.45' });
    assert.equal(f.read('packages/installer/README.md'), 'pins Fleet `1.2.0-nightly.45` here; selects published Fleet `1.2.0-nightly.45`; Cowork `1.2.0-nightly.44` stays.\n');
    // Selecting the same release again changes nothing.
    const before = f.read('releases/nightly.json');
    assert.equal(f.run(fleet, '1.2.0-nightly.45').status, 0);
    assert.equal(f.read('releases/nightly.json'), before);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const [mode, args, message] of [
  ['unpublished', [fleet, '1.2.0-nightly.45'], /./],
  ['tampered', [fleet, '1.2.0-nightly.45'], /does not match its published integrity/],
  ['effort-bug', [fleet, '1.2.0-nightly.47'], /does not declare .*managed-cli\.codex-reasoning-effort-v1/],
  ['old-fleet', [fleet, '1.2.0-nightly.45'], /does not declare .*managed-cli\.setup-v1/],
  ['valid', ['@ours.network/unknown', '1.2.0-nightly.45'], /is not a component/],
  ['valid', [fleet, 'nightly'], /Invalid exact nightly version/],
  ['valid', [fleet], /Usage/],
]) test(`refuses without writing: ${mode} ${args.join(' ')}`, () => {
  const f = fixture(mode);
  try {
    const before = [f.read('releases/nightly.json'), f.read('packages/installer/assets/sources.json'), f.read('packages/installer/README.md')];
    const r = f.run(...args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, message);
    assert.deepEqual([f.read('releases/nightly.json'), f.read('packages/installer/assets/sources.json'), f.read('packages/installer/README.md')], before);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
