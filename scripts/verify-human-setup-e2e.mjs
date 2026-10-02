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
const { installationPaths } = await import(join(prefix, 'lib/node_modules/@ours.network/install/lib/plan.mjs'));
const readRecord = () => JSON.parse(fs.readFileSync(join(stateDir, 'installation.json'), 'utf8'));
/** Ask the running Messenger, through the gateway, what it actually stored. */
async function messengerIdentity(record) {
  const token = fs.readFileSync(installationPaths(record).credentials.messenger, 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${record.port}/messenger/api/identity`, { headers: { 'X-Ours-Api-Token': token }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, 'Messenger identity is readable through the gateway');
  return response.json();
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
  const stored = await messengerIdentity(record);
  console.log('Messenger identity after fresh installation:', JSON.stringify({ name: stored.name, cid: stored.cid, humanProfile: stored.humanProfile }));
  assert.deepEqual({ name: stored.humanProfile?.name, surname: stored.humanProfile?.surname }, { name: 'Ada', surname: 'Lovelace' });
  assert.match(String(stored.cid), /^[0-9A-Fa-f]{64}$/);
  assert.match(first, /Human identity ci@ci-host is ready\./, 'fresh root is <username>@<hostname>');
  const again = install('Repeated installation');
  assert.match(again, /Retained Messenger Name and Surname\./, 'repeat keeps the stored profile, proving the first write reached Messenger');
  assert.doesNotMatch(again, /Messenger Name and Surname initialized\./);
  assert.equal(readRecord().instanceId, record.instanceId, 'repeat retains the installation');
  const retained = await messengerIdentity(readRecord());
  assert.equal(retained.cid, stored.cid, 'repeat retains the same identity');
  assert.deepEqual(retained.humanProfile, stored.humanProfile, 'repeat retains the stored profile');
  execFileSync(join(prefix, 'bin', 'ours-fleet'), ['setup-tunnel', '--help'], { env, stdio: 'inherit' });
  failed = false;
  console.log('HUMAN_SETUP_E2E_PASS: packed installer, real Docker gateway stack, Messenger stores the requested Name and Surname, identity and profile retained on repeat, installed Fleet offers setup-tunnel. No tunnel, device link or browser exercised.');
} finally {
  if (fs.existsSync(join(stateDir, 'installation.json'))) {
    const record = readRecord();
    const files = ['docker-compose.yaml', ...(record.gateway ? ['docker-compose.gateway.yaml'] : [])].flatMap(name => ['--file', join(record.workDir, name)]);
    const compose = extra => spawnSync('docker', ['compose', '--project-directory', record.workDir, ...files, '--project-name', record.project, ...extra], { stdio: 'inherit' });
    if (failed) { compose(['ps', '--all']); compose(['logs', '--no-color', '--tail', '200']); }
    const down = compose(['down', '--volumes', '--remove-orphans']);
    if (!failed) assert.equal(down.status, 0, 'test stack removed');
  }
}
