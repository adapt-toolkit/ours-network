/**
 * CI-only qualification of the plain `ours-install update --nightly` path:
 * the stable installer's own launcher selects the nightly installer through npm
 * and that installer's no-argument setup offers Update for the existing
 * installation. No --sources is passed anywhere.
 *
 * Mock limits, all explicit:
 * - Registry: the candidate is not published. A loopback registry serves the
 *   real upstream packument for @ours.network/install with this checkout's
 *   packed candidate added and dist-tag `nightly` moved to it; every other GET
 *   is proxied to registry.npmjs.org unchanged and nothing is written upstream.
 *   npm and npx reach it only through npm's own `npm_config_registry`; the
 *   installer has no registry or metadata override of its own.
 * - Terminal: the installer runs without a controlling terminal, so every
 *   welcome prompt returns its default without reading (lib/prompt.mjs). The
 *   defaults are Update / Finish the earlier update, and Yes to the backup
 *   question: the same as pressing Enter at each prompt.
 * - Home: HOME is a job-owned directory so the welcome screen finds exactly
 *   this installation (~/.ours-install); DOCKER_CONFIG keeps the runner's
 *   Docker CLI configuration and plugins.
 * - Readiness fault: the same test-owned docker shim as the --sources scenario;
 *   every other Docker call is the real one.
 */
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import {
  INSTALLER, NOTIFICATIONS, imageId, installInstaller, packCandidate, runInstaller, readinessFault, notifications, startCandidateRegistry,
  seedStableNotifications, assertRetained, assertDedupe, messengerBinding, assertBinding, describeSnapshot, cleanupProjects,
} from './nightly-qualification.mjs';

if (process.env.CI !== 'true' || process.env.OURS_NIGHTLY_QUALIFICATION !== '1') throw new Error('Run this qualification only in its CI job');

const repo = new URL('../', import.meta.url);
const repoJson = path => JSON.parse(fs.readFileSync(new URL(path, repo), 'utf8'));
const stable = repoJson('releases/stable.json'), nightly = repoJson('releases/nightly.json');
const candidateVersion = repoJson('packages/installer/package.json').version;
assert.match(candidateVersion, /^\d+\.\d+\.\d+-nightly\.\d+$/, 'Run scripts/prepare-nightly-qualification.mjs first');
assert.equal(nightly.installerVersion, candidateVersion, 'releases/nightly.json selects the prepared candidate');

const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ours-nightly-self-update-')));
fs.chmodSync(root, 0o700);
const home = join(root, 'home');
fs.mkdirSync(home, { mode: 0o700 });
const stateDir = join(home, '.ours-install');
const baseEnv = { ...process.env, HOME: home, DOCKER_CONFIG: process.env.DOCKER_CONFIG || join(homedir(), '.docker'),
  npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
delete baseEnv.OURS_ASSUME_YES;
const readRecord = () => JSON.parse(fs.readFileSync(join(stateDir, 'installation.json'), 'utf8'));
const UPDATE = ['update', '--nightly'];

const projects = new Set();
let failed = true, registry;
try {
  // 1. Stable baseline in the default folder, with seeded Notifications state.
  const stableInstaller = installInstaller(join(root, 'stable'), `${INSTALLER}@${stable.installerVersion}`, baseEnv);
  assert.deepEqual(stableInstaller.read('assets/release.json'), stable, 'published stable installer embeds releases/stable.json');
  assert.ok(fs.existsSync(join(stableInstaller.dir, 'lib', 'self-update.mjs')), 'stable installer ships the update launcher');
  const installRun = await runInstaller(stableInstaller, ['server', 'install', '--mode', 'docker', '--state-dir', stateDir, '--identity-name', 'Nightly Qualification'], `Stable ${stable.installerVersion} installation`);
  assert.equal(installRun.code, 0, `stable installation exited ${installRun.code}`);
  const installed = readRecord();
  projects.add(installed.project);
  assert.equal(installed.sourcePolicyHash, undefined, 'packaged-policy installation records no source policy hash');
  const baseline = await seedStableNotifications(installed, stable);
  const stableBinding = messengerBinding(installed);
  assertBinding(stableBinding, installed, baseline, imageId(`${installed.project}:runtime`), 'stable baseline');

  // 2. The packed candidate behind a loopback registry; `nightly` selects it.
  // Packed with its own cache: npm pack caches the archive by integrity, and npx must download it from the registry.
  const pack = packCandidate(root, { ...baseEnv, npm_config_cache: join(root, 'pack-cache') });
  assert.equal(pack.version, candidateVersion);
  const packedRelease = JSON.parse(pack.read('assets/release.json'));
  assert.deepEqual(packedRelease, nightly, 'candidate archive embeds releases/nightly.json');
  registry = await startCandidateRegistry({ tarball: pack.tarball, manifest: JSON.parse(pack.read('package.json')), integrity: pack.integrity, shasum: pack.shasum });
  const env = { ...stableInstaller.env, npm_config_registry: registry.url };
  // Asynchronous: the registry serves from this process's event loop.
  assert.equal((await promisify(execFile)('npm', ['view', `${INSTALLER}@nightly`, 'version'], { encoding: 'utf8', env })).stdout.trim(), candidateVersion);
  console.log('Candidate archive:', JSON.stringify({ file: pack.filename, version: pack.version, integrity: pack.integrity, sha256: pack.sha256, registry: registry.url }));

  // 3. Plain `ours-install update --nightly` from the stable installer; readiness fails.
  const fault = readinessFault(root, env);
  const interrupted = await runInstaller(stableInstaller, UPDATE, 'Stable launcher: update --nightly with injected readiness failure', { env: fault.env, detached: true });
  assert.notEqual(interrupted.code, 0, 'interrupted update must fail');
  assert.ok(registry.requests.includes(`GET ${registry.tarballPath}`), 'npx fetched the packed candidate archive');
  assert.match(interrupted.output, new RegExp(`to installer ${candidateVersion.replaceAll('.', '\\.')}`), 'the welcome screen of the candidate offered the update');
  assert.match(fs.readFileSync(fault.marker, 'utf8'), /--wait gateway/, 'the readiness fault fired');
  assert.match(interrupted.output, /Application readiness failed: gateway/);
  assert.match(interrupted.output, /Activate the prepared runtime complete/);
  assert.match(interrupted.output, /messenger is ready\./);
  const pending = readRecord();
  const transition = pending.buildTransition;
  assert.ok(transition, 'the interrupted update is retained');
  projects.add(transition.candidate.project);
  assert.equal(transition.operation, 'update');
  assert.equal(transition.compatible, true, 'welcome Update confirms compatibility');
  assert.equal(transition.phase, 'runtime-activated');
  // What the plain path records: the candidate, but no source policy hash anywhere.
  assert.equal(transition.sourcePolicyHash, undefined, 'no --sources: the transition records no source policy hash');
  assert.equal(transition.candidate.sourcePolicyHash, undefined);
  assert.equal(pending.sourcePolicyHash, undefined);
  assert.deepEqual(fs.readdirSync(stateDir).filter(name => name.startsWith('.build-')), [basename(transition.candidate.root)]);
  const candidateImage = imageId(`${transition.candidate.project}:runtime`);
  assert.equal(imageId(`${pending.project}:runtime`), candidateImage, 'activated runtime is the candidate build');
  const selectedSources = fs.readFileSync(pending.sourcesPath);
  assert.deepEqual(JSON.parse(selectedSources).release, packedRelease, 'selected sources are the packed release');
  const interruptedSnapshot = notifications(pending, 'snapshot');
  assertRetained(baseline, interruptedSnapshot, nightly.packages[NOTIFICATIONS].version, 'after the interrupted update');
  assertBinding(messengerBinding(pending), pending, interruptedSnapshot, candidateImage, 'after the interrupted update');
  const candidateIdentity = { project: transition.candidate.project, root: transition.candidate.root, image: candidateImage };
  console.log('Interrupted transition:', JSON.stringify({ phase: transition.phase, ...candidateIdentity, sourcePolicyHash: null }));

  // 4. The same plain command again: the candidate's welcome offers to finish the earlier update.
  const packumentReads = registry.requests.filter(line => /^GET \/@ours\.network%2[fF]install$/.test(line)).length;
  const resumed = await runInstaller(stableInstaller, UPDATE, 'Stable launcher: update --nightly again', { env, detached: true });
  assert.equal(resumed.code, 0, `resumed update exited ${resumed.code}`);
  assert.ok(registry.requests.filter(line => /^GET \/@ours\.network%2[fF]install$/.test(line)).length > packumentReads, 'the rerun resolved @nightly again');
  assert.match(resumed.output, /An earlier update or setup step did not finish/);
  assert.doesNotMatch(resumed.output, /Prepare the updated runtime/, 'resume reuses the recorded candidate');
  assert.doesNotMatch(resumed.output, /Verify package and stored-state compatibility/);
  assert.match(resumed.output, /Verify and recover retained Notifications provenance complete/);
  assert.match(resumed.output, /Restore previously running services and check readiness complete/);
  assert.match(resumed.output, /Verify authenticated gateway management complete/);
  const completed = readRecord();
  assert.equal(completed.buildTransition, undefined);
  assert.equal(completed.instanceId, installed.instanceId);
  assert.equal(completed.sourcePolicyHash, undefined, 'completion records the candidate policy hash it had: none');
  assert.equal(imageId(`${completed.project}:runtime`), candidateIdentity.image, 'resume kept the candidate runtime image');
  assert.deepEqual(fs.readFileSync(completed.sourcesPath), selectedSources, 'resume kept the candidate source selection');
  assert.ok(!fs.existsSync(candidateIdentity.root), 'candidate build directory discarded after completion');
  const status = await runInstaller(stableInstaller, ['server', 'status', '--state-dir', stateDir], 'Status after resume');
  assert.equal(status.code, 0);
  const reported = JSON.parse(status.output.split('\n').find(line => line.startsWith('{')));
  assert.deepEqual([...reported.running].sort(), [...installed.services].sort(), 'every service is running');
  const after = notifications(completed, 'snapshot');
  assertRetained(baseline, after, nightly.packages[NOTIFICATIONS].version, 'after the resume');
  const resumedBinding = messengerBinding(completed);
  assertBinding(resumedBinding, completed, after, candidateIdentity.image, 'after the resume');
  assert.equal(resumedBinding.volume, stableBinding.volume, 'same Notifications volume as the stable baseline');
  assertDedupe(completed, baseline);
  failed = false;
  console.log('Notifications after resume:', describeSnapshot(after));
  console.log(`NIGHTLY_SELF_UPDATE_PASS: stable ${stable.installerVersion} launcher \`ours-install update --nightly\` -> candidate ${candidateVersion} (archive sha256 ${pack.sha256}, served by a loopback registry); readiness failure retained candidate ${candidateIdentity.project} with no source policy hash recorded; the same plain command resumed it (same runtime image and source selection, no new preparation), passed readiness; Notifications state ${after.stateSha256}, configuration and credentials retained exactly; duplicates stayed deduplicated.`);
} finally {
  try {
    if (fs.existsSync(join(stateDir, 'installation.json'))) {
      const record = readRecord();
      projects.add(record.project);
      if (record.buildTransition) projects.add(record.buildTransition.candidate.project);
    }
  } catch (error) { console.error('Could not read the installation record for cleanup:', error.message); }
  const left = cleanupProjects(projects, { failed });
  if (registry) {
    console.log(`Qualification registry served ${registry.requests.length} requests; refused writes: ${registry.requests.filter(line => !/^(GET|HEAD) /.test(line)).length}`);
    await registry.close();
  }
  fs.rmSync(root, { recursive: true, force: true });
  if (left.length) {
    console.error(`Qualification resources remain: ${left.join(', ')}`);
    if (!failed) process.exitCode = 1;
  } else console.log(`Removed qualification projects: ${[...projects].join(', ') || '(none)'}`);
}
