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
// Same shape as a user whose npm global prefix is their own directory: the
// installer publishes its managed CLI beside itself.
fs.chmodSync(join(prefix, 'bin'), 0o755);
const env = { ...process.env, npm_config_prefix: prefix, PATH: `${join(prefix, 'bin')}:${process.env.PATH}` };
const installer = join(prefix, 'bin', 'ours-install');
const readRecord = () => JSON.parse(fs.readFileSync(join(stateDir, 'installation.json'), 'utf8'));
/** Ask the running Messenger what it actually stored, with its own in-container credential. */
function messengerIdentity(record) {
  const script = `import { readFileSync } from 'node:fs';
const token = readFileSync('/credentials/messenger/daemon-token', 'utf8').trim();
const response = await fetch('http://127.0.0.1:8420/api/identity', { headers: { 'X-Ours-Api-Token': token }, redirect: 'error', signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error('Messenger identity read failed (HTTP ' + response.status + ')');
const { name, cid, humanProfile } = await response.json();
process.stdout.write(JSON.stringify({ name, cid, humanProfile }));`;
  return JSON.parse(execFileSync('docker', ['exec', `${record.project}-messenger-1`, 'node', '--input-type=module', '-e', script], { encoding: 'utf8' }));
}
const args = ['--mode', 'docker', '--state-dir', stateDir, '--username', 'ci', '--name', 'Ada', '--surname', 'Lovelace', '--hostname', 'ci-host', '--integrations', 'fleet', '--disable-fleet-agents-setup'];
const install = label => {
  console.log(`\n=== ${label}: ours-install ${args.join(' ')}`);
  const result = spawnSync(installer, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `${label} exited ${result.status}`);
  return result.stdout + result.stderr;
};
let failed = true;
try {
  const first = install('Fresh installation');
  assert.match(first, /Messenger Name and Surname initialized\./, 'fresh installation sets the Messenger profile');
  assert.match(first, /Requested install completed/);
  const record = readRecord();
  assert.equal(record.mode, 'docker'); assert.equal(record.gateway?.version, 1, 'fresh Docker installation runs behind the gateway');
  const stored = messengerIdentity(record);
  console.log('Messenger identity after fresh installation:', JSON.stringify(stored));
  assert.deepEqual({ name: stored.humanProfile?.name, surname: stored.humanProfile?.surname }, { name: 'Ada', surname: 'Lovelace' });
  assert.match(String(stored.cid), /^[0-9A-Fa-f]{64}$/);
  assert.match(first, /Human identity ci@ci-host is ready\./, 'fresh root is <username>@<hostname>');
  const again = install('Repeated installation');
  assert.match(again, /Retained Messenger Name and Surname\./, 'repeat keeps the stored profile, proving the first write reached Messenger');
  assert.doesNotMatch(again, /Messenger Name and Surname initialized\./);
  assert.equal(readRecord().instanceId, record.instanceId, 'repeat retains the installation');
  const retained = messengerIdentity(readRecord());
  assert.equal(retained.cid, stored.cid, 'repeat retains the same identity');
  assert.deepEqual(retained.humanProfile, stored.humanProfile, 'repeat retains the stored profile');
  execFileSync(join(prefix, 'bin', 'ours-fleet'), ['setup-tunnel', '--help'], { env, stdio: 'inherit' });
  failed = false;
  console.log('HUMAN_SETUP_E2E_PASS: packed installer, real Docker gateway stack, Messenger stores the requested Name and Surname, identity and profile retained on repeat, installed Fleet offers setup-tunnel. No tunnel, device link or browser exercised.');
} finally {
  if (fs.existsSync(join(stateDir, 'installation.json'))) {
    const record = readRecord();
    // Compose addresses an existing project by name; no interpolation of the installation's files is needed.
    const compose = extra => spawnSync('docker', ['compose', '--project-name', record.project, ...extra], { stdio: 'inherit' });
    if (failed) { compose(['ps', '--all']); compose(['logs', '--no-color', '--tail', '200']); }
    const down = compose(['down', '--volumes', '--remove-orphans']);
    const left = execFileSync('docker', ['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${record.project}`], { encoding: 'utf8' }).trim();
    if (!failed) { assert.equal(down.status, 0, 'test stack removed'); assert.equal(left, '', 'no test containers remain'); }
  }
}
