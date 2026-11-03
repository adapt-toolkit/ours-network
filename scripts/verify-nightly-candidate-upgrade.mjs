/**
 * CI-only qualification of the nightly installer candidate's Docker transition,
 * driven with an explicit source policy (`server update --sources`).
 *
 * 1. The current stable installer, exactly as published for releases/stable.json,
 *    installs a Docker server. Notifications data is seeded through the running
 *    service's API, then offline with the image's own Store while its writer is
 *    stopped (see nightly-qualification.mjs).
 * 2. This checkout, already put into its nightly state by
 *    prepare-nightly-qualification.mjs, is packed and installed like a release.
 * 3. That installer updates the installation to its candidate. The gateway's
 *    readiness wait, the last service in the readiness stage, reports failure:
 *    a test-owned docker shim on PATH lets Docker start the gateway, then fails
 *    the wait. No product hook is involved.
 * 4. The update is repeated with the same source policy. It must resume the
 *    recorded candidate (same sourcePolicyHash and runtime image, no new
 *    preparation), refuse a substituted policy, pass readiness, and retain the
 *    Notifications state, credentials and configuration exactly.
 * 5. Every container, volume, network and image of the installation and the
 *    candidate is removed, with the temporary directory.
 *
 * It runs only on an ephemeral runner, against real Docker and public registries.
 */
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import {
  NOTIFICATIONS, sha256, imageId, installInstaller, packCandidate, runInstaller, readinessFault, notifications,
  seedStableNotifications, assertRetained, assertDedupe, messengerBinding, assertBinding, describeSnapshot, cleanupProjects,
} from './nightly-qualification.mjs';

if (process.env.CI !== 'true' || process.env.OURS_NIGHTLY_QUALIFICATION !== '1') throw new Error('Run this qualification only in its CI job');

const repo = new URL('../', import.meta.url);
const repoJson = path => JSON.parse(fs.readFileSync(new URL(path, repo), 'utf8'));
const stable = repoJson('releases/stable.json'), nightly = repoJson('releases/nightly.json');
const candidateVersion = repoJson('packages/installer/package.json').version;
assert.match(candidateVersion, /^\d+\.\d+\.\d+-nightly\.\d+$/, 'Run scripts/prepare-nightly-qualification.mjs first');
assert.equal(nightly.installerVersion, candidateVersion, 'releases/nightly.json selects the prepared candidate');
assert.equal(stable.channel, 'stable');

const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ours-nightly-upgrade-')));
fs.chmodSync(root, 0o700);
const stateDir = join(root, 'state');
const readRecord = () => JSON.parse(fs.readFileSync(join(stateDir, 'installation.json'), 'utf8'));
const privateCopy = (bytes, name) => {
  const path = join(root, name);
  fs.writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  return path;
};

const projects = new Set();
let failed = true;
try {
  // 1. Stable baseline with seeded Notifications state.
  const stableInstaller = installInstaller(join(root, 'stable'), `@ours.network/install@${stable.installerVersion}`);
  assert.equal(stableInstaller.read('package.json').version, stable.installerVersion);
  assert.deepEqual(stableInstaller.read('assets/release.json'), stable, 'published stable installer embeds releases/stable.json');
  const server = ['server', 'update', '--mode', 'docker', '--state-dir', stateDir, '--identity-name', 'Nightly Qualification'];
  const baselineRun = await runInstaller(stableInstaller, ['server', 'install', ...server.slice(2)], `Stable ${stable.installerVersion} installation`);
  assert.equal(baselineRun.code, 0, `stable installation exited ${baselineRun.code}`);
  const installed = readRecord();
  projects.add(installed.project);
  assert.equal(installed.mode, 'docker');
  assert.ok(installed.services.includes('messenger') && installed.services.includes('gateway'));
  const baseline = await seedStableNotifications(installed, stable);
  const stableBinding = messengerBinding(installed);
  assertBinding(stableBinding, installed, baseline, imageId(`${installed.project}:runtime`), 'stable baseline');

  // 2. The nightly candidate, packed exactly as the publish job packs it.
  const pack = packCandidate(root);
  assert.equal(pack.version, candidateVersion);
  const packedRelease = JSON.parse(pack.read('assets/release.json'));
  assert.deepEqual(packedRelease, nightly, 'candidate archive embeds releases/nightly.json');
  const nightlyInstaller = installInstaller(join(root, 'nightly'), pack.tarball);
  assert.equal(nightlyInstaller.read('package.json').version, candidateVersion);
  const packedSources = pack.read('assets/sources.json');
  assert.deepEqual(fs.readFileSync(join(nightlyInstaller.dir, 'assets', 'sources.json')), packedSources, 'installed candidate is the packed archive');
  const sources = privateCopy(packedSources, 'nightly-sources.json');
  const substitute = privateCopy(fs.readFileSync(join(stableInstaller.dir, 'assets', 'sources.json')), 'stable-sources.json');
  const policyHash = sha256(packedSources);
  const update = [...server, '--compatible', '--sources', sources];
  console.log('Candidate archive:', JSON.stringify({ file: pack.filename, version: pack.version, integrity: pack.integrity, sha256: pack.sha256, sourcePolicyHash: policyHash }));

  // 3. Update to the candidate; readiness fails after the runtime is activated.
  const fault = readinessFault(root, nightlyInstaller.env);
  const interrupted = await runInstaller(nightlyInstaller, update, `Nightly ${candidateVersion} update with injected readiness failure`, { env: fault.env });
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
  assert.equal(transition.sourcePolicyHash, policyHash, 'transition records the packed source policy');
  assert.equal(transition.candidate.sourcePolicyHash, policyHash);
  assert.deepEqual([...transition.runningServices].sort(), [...installed.services].sort());
  assert.deepEqual(fs.readdirSync(stateDir).filter(name => name.startsWith('.build-')), [basename(transition.candidate.root)]);
  const candidateImage = imageId(`${transition.candidate.project}:runtime`);
  assert.equal(imageId(`${pending.project}:runtime`), candidateImage, 'activated runtime is the candidate build');
  const selectedSources = fs.readFileSync(pending.sourcesPath);
  assert.deepEqual(JSON.parse(selectedSources).release, packedRelease, 'selected sources are the packed release');
  const interruptedSnapshot = notifications(pending, 'snapshot');
  assertRetained(baseline, interruptedSnapshot, nightly.packages[NOTIFICATIONS].version, 'after the interrupted update');
  assertBinding(messengerBinding(pending), pending, interruptedSnapshot, candidateImage, 'after the interrupted update');
  console.log('Interrupted transition:', JSON.stringify({ phase: transition.phase, candidate: transition.candidate.project, sourcePolicyHash: transition.sourcePolicyHash, runtimeImage: candidateImage }));

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
  assert.equal(completed.sourcePolicyHash, policyHash, 'completed installation records the packed source policy');
  assert.equal(imageId(`${completed.project}:runtime`), candidateImage, 'resume kept the candidate runtime image');
  assert.deepEqual(fs.readFileSync(completed.sourcesPath), selectedSources);
  assert.ok(!fs.existsSync(transition.candidate.root), 'candidate build directory discarded after completion');
  const status = await runInstaller(nightlyInstaller, ['server', 'status', '--state-dir', stateDir], 'Status after resume');
  assert.equal(status.code, 0);
  const reported = JSON.parse(status.output.split('\n').find(line => line.startsWith('{')));
  assert.deepEqual([...reported.running].sort(), [...installed.services].sort(), 'every service is running');
  const after = notifications(completed, 'snapshot');
  assertRetained(baseline, after, nightly.packages[NOTIFICATIONS].version, 'after the resume');
  const resumedBinding = messengerBinding(completed);
  assertBinding(resumedBinding, completed, after, candidateImage, 'after the resume');
  assert.equal(resumedBinding.volume, stableBinding.volume, 'same Notifications volume as the stable baseline');
  assertDedupe(completed, baseline);
  failed = false;
  console.log('Notifications after resume:', describeSnapshot(after));
  console.log(`NIGHTLY_CANDIDATE_UPGRADE_PASS: stable ${stable.installerVersion} (Notifications ${baseline.version}) -> nightly ${candidateVersion} (Notifications ${after.version}) from archive sha256 ${pack.sha256}; readiness failure retained candidate ${transition.candidate.project}, resume kept sourcePolicyHash ${policyHash} and runtime image ${candidateImage}, refused a substituted policy, passed readiness; Notifications state ${after.stateSha256}, configuration and credentials retained exactly; duplicates stayed deduplicated.`);
} finally {
  try {
    if (fs.existsSync(join(stateDir, 'installation.json'))) {
      const record = readRecord();
      projects.add(record.project);
      if (record.buildTransition) projects.add(record.buildTransition.candidate.project);
    }
  } catch (error) { console.error('Could not read the installation record for cleanup:', error.message); }
  const left = cleanupProjects(projects, { failed });
  fs.rmSync(root, { recursive: true, force: true });
  if (left.length) {
    console.error(`Qualification resources remain: ${left.join(', ')}`);
    if (!failed) process.exitCode = 1;
  } else console.log(`Removed qualification projects: ${[...projects].join(', ') || '(none)'}`);
}
