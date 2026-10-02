/**
 * Run the packed installer exactly as the App's install command does, against
 * real Docker and the published component images. CI only: it installs into the
 * runner's home and starts containers.
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

if (process.env.CI !== 'true') throw new Error('Run this qualification in CI only');
const root = fs.mkdtempSync(join(tmpdir(), 'ours-human-setup-'));
const prefix = join(root, 'prefix'), stateDir = join(root, 'state');
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--workspace', '@ours.network/install', '--pack-destination', root, '--json'], { encoding: 'utf8' }));
execFileSync('npm', ['install', '--global', '--prefix', prefix, join(root, packed.filename)], { stdio: 'inherit' });
const installer = join(prefix, 'bin', 'ours-install');
const args = ['--mode', 'docker', '--state-dir', stateDir, '--username', 'ci', '--name', 'Ada', '--surname', 'Lovelace', '--hostname', 'ci-host', '--integrations', 'fleet', '--disable-fleet-agents-setup'];
const install = label => {
  console.log(`\n=== ${label}: ours-install ${args.join(' ')}`);
  const result = spawnSync(installer, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${join(prefix, 'bin')}:${process.env.PATH}` }, maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `${label} exited ${result.status}`);
  return result.stdout + result.stderr;
};
let failed = true;
try {
  const first = install('Fresh installation');
  assert.match(first, /Messenger Name and Surname initialized\./, 'fresh installation sets the Messenger profile');
  assert.match(first, /Requested install completed/);
  const record = JSON.parse(fs.readFileSync(join(stateDir, 'installation.json'), 'utf8'));
  assert.equal(record.mode, 'docker'); assert.equal(record.gateway?.version, 1, 'fresh Docker installation runs behind the gateway');
  const again = install('Repeated installation');
  assert.match(again, /Retained Messenger Name and Surname\./, 'repeat keeps the stored profile, proving the first write reached Messenger');
  assert.doesNotMatch(again, /Messenger Name and Surname initialized\./);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(stateDir, 'installation.json'), 'utf8')).instanceId, record.instanceId, 'repeat retains the installation');
  failed = false;
  console.log('HUMAN_SETUP_E2E_PASS: packed installer, real Docker gateway stack, Messenger profile written once and retained on repeat.');
} finally {
  if (fs.existsSync(join(stateDir, 'installation.json'))) {
    const record = JSON.parse(fs.readFileSync(join(stateDir, 'installation.json'), 'utf8'));
    const compose = extra => spawnSync('docker', ['compose', '--project-name', record.project, ...extra], { stdio: 'inherit' });
    if (failed) { compose(['ps', '--all']); compose(['logs', '--no-color', '--tail', '200']); }
    compose(['down', '--volumes', '--remove-orphans']);
  }
}
