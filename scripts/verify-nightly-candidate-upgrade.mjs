/**
 * CI-only qualification of the nightly installer candidate's Docker transition.
 *
 * 1. The current stable installer, exactly as published for releases/stable.json,
 *    installs a Docker server, and real Notifications records are created through
 *    the running service's API (three inbox items, one read).
 * 2. This checkout, already put into its nightly state by
 *    prepare-nightly-qualification.mjs, is packed and installed like a release.
 * 3. That installer updates the installation to its candidate. The gateway's
 *    readiness wait, the last service in the readiness stage, reports failure:
 *    a test-owned docker shim on PATH lets Docker start the gateway, then fails
 *    the wait. No product hook is involved.
 * 4. The update is repeated with the same source policy. It must resume the
 *    recorded candidate (same sourcePolicyHash, same runtime image, no new
 *    preparation), refuse a substituted policy, pass readiness, and keep the
 *    seeded Notifications data.
 * 5. Every container, volume, network and image of the installation and the
 *    candidate is removed, with the temporary directory.
 *
 * It runs only on an ephemeral runner, against real Docker and public registries.
 */
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';

if (process.env.CI !== 'true' || process.env.OURS_NIGHTLY_QUALIFICATION !== '1') throw new Error('Run this qualification only in its CI job');

const repo = new URL('../', import.meta.url);
const repoJson = path => JSON.parse(fs.readFileSync(new URL(path, repo), 'utf8'));
const NOTIFICATIONS = '@ours.network/notifications';
const stable = repoJson('releases/stable.json'), nightly = repoJson('releases/nightly.json');
const candidateVersion = repoJson('packages/installer/package.json').version;
assert.match(candidateVersion, /^\d+\.\d+\.\d+-nightly\.\d+$/, 'Run scripts/prepare-nightly-qualification.mjs first');
assert.equal(nightly.installerVersion, candidateVersion, 'releases/nightly.json selects the prepared candidate');
assert.equal(stable.channel, 'stable');

const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ours-nightly-upgrade-')));
fs.chmodSync(root, 0o700);
const stateDir = join(root, 'state');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const readRecord = () => JSON.parse(fs.readFileSync(join(stateDir, 'installation.json'), 'utf8'));
const sha256 = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const imageId = tag => docker(['image', 'inspect', '--format', '{{.Id}}', tag]).trim();
const privateCopy = (source, name) => {
  const path = join(root, name);
  fs.copyFileSync(source, path, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(path, 0o600);
  return path;
};

function installInstaller(prefix, spec) {
  execFileSync('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', spec], { stdio: 'inherit' });
  const dir = join(prefix, 'lib', 'node_modules', '@ours.network', 'install');
  const read = file => JSON.parse(fs.readFileSync(join(dir, file), 'utf8'));
  return { bin: join(prefix, 'bin', 'ours-install'), dir, read, env: { ...process.env, npm_config_prefix: prefix, PATH: `${join(prefix, 'bin')}:${process.env.PATH}` } };
}

function runInstaller(installer, args, label, env = installer.env) {
  console.log(`\n=== ${label}: ours-install ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(installer.bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
}

// Runs inside the Messenger container, which hosts Notifications, with the
// service's own scoped credentials from its private configuration.
const NOTIFICATIONS_PROBE = `import { readFileSync } from 'node:fs';
const action = process.argv[1];
const config = JSON.parse(readFileSync('/var/lib/ours-notifications/config.json', 'utf8'));
const owner = config.users[0].token, producer = config.producers.find(p => p.source === 'fleet').token;
const call = async (path, token, body) => {
  const response = await fetch('http://127.0.0.1:49677' + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(path + ' failed with HTTP ' + response.status + ': ' + await response.text());
  return response.json();
};
const inbox = () => call('/api/v1/inbox?limit=50', owner);
if (action === 'seed') {
  for (const n of [1, 2, 3]) await call('/api/v1/send', producer, { eventId: 'nightly-qualification-' + n, title: 'Qualification ' + n, body: 'Seeded before the nightly upgrade', target: { kind: 'agent', agentId: 'nightly-qualification' } });
  const first = (await inbox()).items.find(item => item.title === 'Qualification 1');
  await call('/api/v1/read', owner, { ids: [first.id] });
} else if (action !== 'inspect') throw new Error('Unknown probe action ' + action);
const { items, unread } = await inbox();
const state = JSON.parse(readFileSync('/var/lib/ours-notifications/state.json', 'utf8'));
const version = JSON.parse(readFileSync('/opt/ours/node_modules/@ours.network/notifications/package.json', 'utf8')).version;
process.stdout.write(JSON.stringify({ version, stateVersion: state.version, unread,
  items: items.map(({ id, title, body, target, createdAt, readAt }) => ({ id, title, body, target, createdAt, readAt })) }));`;
const notifications = (record, action) => JSON.parse(docker(['exec', `${record.project}-messenger-1`, 'node', '--input-type=module', '-e', NOTIFICATIONS_PROBE, action]));

// Test-owned fault: Docker really starts the gateway, then its readiness wait
// reports failure, as a readiness timeout would. Every other call passes through.
function readinessFaultPath(env) {
  const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8', env }).trim();
  assert.match(realDocker, /^\/[^'\s]+$/);
  const bin = join(root, 'fault-bin'), marker = join(root, 'injected-readiness-fault');
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.writeFileSync(join(bin, 'docker'), `#!/bin/sh
case " $* " in
  *" compose "*" up "*" --wait gateway ")
    '${realDocker}' "$@" || exit $?
    printf '%s\\n' "$*" >> '${marker}'
    echo 'Qualification fault: gateway readiness wait reported failure' >&2
    exit 1;;
esac
exec '${realDocker}' "$@"
`, { mode: 0o700 });
  return { env: { ...env, PATH: `${bin}:${env.PATH}` }, marker };
}

const projects = new Set();
let failed = true;
try {
  // 1. Stable baseline with seeded Notifications state.
  const stableInstaller = installInstaller(join(root, 'stable'), `@ours.network/install@${stable.installerVersion}`);
  assert.equal(stableInstaller.read('package.json').version, stable.installerVersion);
  assert.deepEqual(stableInstaller.read('assets/release.json'), stable, 'published stable installer embeds releases/stable.json');
  const server = ['server', 'update', '--mode', 'docker', '--state-dir', stateDir, '--identity-name', 'Nightly Qualification'];
  const installArgs = ['server', 'install', ...server.slice(2)];
  const baseline = await runInstaller(stableInstaller, installArgs, `Stable ${stable.installerVersion} installation`);
  assert.equal(baseline.code, 0, `stable installation exited ${baseline.code}`);
  const installed = readRecord();
  projects.add(installed.project);
  assert.equal(installed.mode, 'docker');
  assert.ok(installed.services.includes('messenger') && installed.services.includes('gateway'));
  const seeded = notifications(installed, 'seed');
  console.log('Seeded Notifications:', JSON.stringify(seeded));
  assert.equal(seeded.version, stable.packages[NOTIFICATIONS].version, 'baseline runs the stable Notifications pin');
  assert.equal(seeded.stateVersion, 3, 'stable Notifications writes a version 3 state file');
  assert.equal(seeded.items.length, 3);
  assert.equal(seeded.unread, 2);
  assert.equal(seeded.items.filter(item => item.readAt).length, 1);

  // 2. The nightly candidate, packed exactly as the publish job packs it.
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--workspace', '@ours.network/install', '--pack-destination', root, '--json'], { encoding: 'utf8' }));
  assert.equal(packed.version, candidateVersion);
  const nightlyInstaller = installInstaller(join(root, 'nightly'), join(root, packed.filename));
  assert.deepEqual(nightlyInstaller.read('assets/release.json'), nightly, 'candidate embeds releases/nightly.json');
  const sources = privateCopy(join(nightlyInstaller.dir, 'assets', 'sources.json'), 'nightly-sources.json');
  const substitute = privateCopy(join(stableInstaller.dir, 'assets', 'sources.json'), 'stable-sources.json');
  const policyHash = sha256(sources);
  const update = [...server, '--compatible', '--sources', sources];

  // 3. Update to the candidate; readiness fails after the runtime is activated.
  const fault = readinessFaultPath(nightlyInstaller.env);
  const interrupted = await runInstaller(nightlyInstaller, update, `Nightly ${candidateVersion} update with injected readiness failure`, fault.env);
  assert.notEqual(interrupted.code, 0, 'interrupted update must fail');
  assert.match(fs.readFileSync(fault.marker, 'utf8'), /--wait gateway/, 'the readiness fault fired');
  assert.match(interrupted.output, /Application readiness failed: gateway/);
  assert.match(interrupted.output, /Activate the prepared runtime complete/);
  assert.match(interrupted.output, /messenger is ready\./, 'candidate Notifications started on the stable state before the interruption');
  const pending = readRecord();
  const transition = pending.buildTransition;
  assert.ok(transition, 'the interrupted update is retained');
  projects.add(transition.candidate.project);
  assert.equal(transition.operation, 'update');
  assert.equal(transition.compatible, true);
  assert.equal(transition.phase, 'runtime-activated');
  assert.equal(transition.sourcePolicyHash, policyHash);
  assert.equal(transition.candidate.sourcePolicyHash, policyHash);
  assert.deepEqual([...transition.runningServices].sort(), [...installed.services].sort());
  assert.deepEqual(fs.readdirSync(stateDir).filter(name => name.startsWith('.build-')), [basename(transition.candidate.root)]);
  const activatedImage = imageId(`${pending.project}:runtime`);
  assert.equal(activatedImage, imageId(`${transition.candidate.project}:runtime`), 'activated runtime is the candidate build');
  const selectedSources = fs.readFileSync(pending.sourcesPath);
  assert.equal(JSON.parse(selectedSources).release?.packages?.[NOTIFICATIONS]?.version, nightly.packages[NOTIFICATIONS].version);
  console.log('Interrupted transition:', JSON.stringify({ phase: transition.phase, candidate: transition.candidate.project, sourcePolicyHash: transition.sourcePolicyHash, runtimeImage: activatedImage }));

  // 4a. A substituted source policy is refused without touching the retained transition.
  const recordBytes = fs.readFileSync(join(stateDir, 'installation.json'));
  const substituted = await runInstaller(nightlyInstaller, [...server, '--compatible', '--sources', substitute], 'Resume with a substituted source policy');
  assert.notEqual(substituted.code, 0);
  assert.match(substituted.output, /Resume the retained server update\/rebuild without substituting sources/);
  assert.deepEqual(fs.readFileSync(join(stateDir, 'installation.json')), recordBytes);

  // 4b. Resume with the same policy.
  const resumed = await runInstaller(nightlyInstaller, update, 'Resume the nightly update');
  assert.equal(resumed.code, 0, `resumed update exited ${resumed.code}`);
  assert.doesNotMatch(resumed.output, /Prepare the updated runtime/, 'resume reuses the recorded candidate');
  assert.doesNotMatch(resumed.output, /Verify package and stored-state compatibility/);
  assert.match(resumed.output, /Verify and recover retained Notifications provenance complete/);
  assert.match(resumed.output, /Restore previously running services and check readiness complete/);
  assert.match(resumed.output, /Verify authenticated gateway management complete/);
  const completed = readRecord();
  assert.equal(completed.buildTransition, undefined);
  assert.equal(completed.instanceId, installed.instanceId);
  assert.equal(completed.sourcePolicyHash, policyHash, 'completed installation records the resumed candidate policy');
  assert.equal(imageId(`${completed.project}:runtime`), activatedImage, 'resume kept the candidate runtime image');
  assert.deepEqual(fs.readFileSync(completed.sourcesPath), selectedSources);
  assert.ok(!fs.existsSync(transition.candidate.root), 'candidate build directory discarded after completion');
  const status = await runInstaller(nightlyInstaller, ['server', 'status', '--state-dir', stateDir], 'Status after resume');
  assert.equal(status.code, 0);
  const reported = JSON.parse(status.output.split('\n').find(line => line.startsWith('{')));
  assert.deepEqual([...reported.running].sort(), [...installed.services].sort(), 'every service is running');
  const after = notifications(completed, 'inspect');
  console.log('Notifications after resume:', JSON.stringify(after));
  assert.equal(after.version, nightly.packages[NOTIFICATIONS].version, 'candidate Notifications is running');
  assert.equal(after.stateVersion, 3);
  assert.equal(after.unread, seeded.unread);
  assert.deepEqual(after.items, seeded.items, 'seeded Notifications records are retained exactly');
  failed = false;
  console.log(`NIGHTLY_CANDIDATE_UPGRADE_PASS: stable ${stable.installerVersion} (Notifications ${seeded.version}) -> nightly ${candidateVersion} (Notifications ${after.version}); readiness failure retained candidate ${transition.candidate.project}, resume kept sourcePolicyHash ${policyHash}, refused a substituted policy, passed readiness and kept ${after.items.length} records with ${after.unread} unread.`);
} finally {
  try {
    if (fs.existsSync(join(stateDir, 'installation.json'))) {
      const record = readRecord();
      projects.add(record.project);
      if (record.buildTransition) projects.add(record.buildTransition.candidate.project);
    }
  } catch (error) { console.error('Could not read the installation record for cleanup:', error.message); }
  const quiet = args => { try { return docker(args); } catch (error) { console.error(`docker ${args.join(' ')} failed: ${error.message}`); return ''; } };
  const ids = args => quiet(args).split('\n').map(line => line.trim()).filter(Boolean);
  for (const project of projects) {
    const label = `label=com.docker.compose.project=${project}`;
    if (failed) {
      console.log(quiet(['compose', '--project-name', project, 'ps', '--all']));
      console.log(quiet(['compose', '--project-name', project, 'logs', '--no-color', '--tail', '200']));
    }
    quiet(['compose', '--project-name', project, 'down', '--volumes', '--remove-orphans', '--timeout', '30']);
    for (const id of ids(['ps', '--all', '--quiet', '--filter', label])) quiet(['rm', '--force', '--volumes', id]);
    for (const name of ids(['volume', 'ls', '--quiet', '--filter', label])) quiet(['volume', 'rm', name]);
    for (const id of ids(['network', 'ls', '--quiet', '--filter', label])) quiet(['network', 'rm', id]);
    for (const tag of ids(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=${project}:*`])) quiet(['image', 'rm', '--force', tag]);
  }
  const left = [...projects].flatMap(project => [
    ...ids(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]),
    ...ids(['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]),
    ...ids(['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]),
    ...ids(['image', 'ls', '--quiet', '--filter', `reference=${project}:*`]),
  ]);
  fs.rmSync(root, { recursive: true, force: true });
  if (left.length) {
    console.error(`Qualification resources remain: ${left.join(', ')}`);
    if (!failed) process.exitCode = 1;
  } else console.log(`Removed qualification projects: ${[...projects].join(', ') || '(none)'}`);
}
