/** CI-only qualification of the real volume boundary and persistent CLI dependencies. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { prepareMigrationCliRuntime } from '../packages/installer/lib/legacy-migration.mjs';

if (process.env.CI !== 'true') throw new Error('Run this qualification in CI only');
const root = fs.mkdtempSync(join(tmpdir(), 'ours-legacy-ci-'));
const volume = 'ours-legacy-ci-' + randomUUID();
const docker = args => execFileSync('docker', args, { stdio: 'inherit' });
try {
  const source = join(root, 'source'); fs.mkdirSync(source, { mode: 0o700 });
  const receipt = { sourceStateDir: '/legacy/source', sourceConfigPath: '/legacy/source/config.json', targetRoot: '/managed', rootName: 'Human' };
  for (const component of ['mcp', 'daemon']) {
    const path = join(source, component); fs.mkdirSync(path, { mode: 0o700 });
    fs.writeFileSync(join(path, '.ours-legacy-import.json'), JSON.stringify(receipt), { mode: 0o600 });
    fs.writeFileSync(join(path, 'opaque'), 'retained-' + component, { mode: 0o600 });
  }
  const common = ['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE',
    '--mount', `type=bind,source=${resolve('.')},target=/code,readonly`, '--mount', `type=bind,source=${source},target=/legacy-import,readonly`,
    '--mount', `type=volume,source=${volume},target=/storage`, '--env', 'OURS_UID=1000', '--env', 'OURS_GID=1000', '--env', 'OURS_LEGACY_TARGET_ROOT=/managed'];
  docker([...common, 'node:24', 'node', '/code/packages/installer/assets/scripts/runtime/legacy-import.mjs']);
  const verify = `const fs=require('node:fs'),a=require('node:assert/strict'); for(const c of ['mcp','daemon']) {const p='/storage/state/'+c+'/opaque';a.equal(fs.readFileSync(p,'utf8'),'retained-'+c);a.equal(fs.statSync(p).uid,1000);a.equal(fs.statSync(p).gid,1000);} fs.writeFileSync('/storage/state/daemon/opaque','changed-after-activation');`;
  docker([...common, 'node:24', 'node', '-e', verify]);
  docker([...common, 'node:24', 'node', '/code/packages/installer/assets/scripts/runtime/legacy-import.mjs']);
  docker([...common, 'node:24', 'node', '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('/storage/state/daemon/opaque','utf8'),'changed-after-activation')"]);
  assert.equal(fs.readFileSync(join(source, 'daemon/opaque'), 'utf8'), 'retained-daemon');
  const target = join(root, 'managed'); fs.mkdirSync(target, { mode: 0o700 });
  const effects = { out: console.log, async run(command, args) { return { stdout: execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) }; } };
  const entry = await prepareMigrationCliRuntime({ root: target }, effects);
  assert(!fs.lstatSync(join(target, 'launcher-runtime/node_modules/@ours.network/install')).isSymbolicLink());
  const help = execFileSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
  assert.match(help, /ours-install/);
  assert.equal(await prepareMigrationCliRuntime({ root: target }, { ...effects, run: () => assert.fail('ready management runtime must be reused') }), entry);
  console.log('Verified named-volume import, ownership remapping, retry preservation and persistent management runtime.');
} finally {
  try { execFileSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' }); } catch { /* no volume if preparation failed */ }
  fs.rmSync(root, { recursive: true, force: true });
}
