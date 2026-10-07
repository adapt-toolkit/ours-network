/** Exercise the shipped Dockerfile with the installer's private host manifest. CI only. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { realEffects } from '../packages/installer/lib/effects.mjs';
import { SERVER_PACKAGES, SERVER_SERVICES } from '../packages/installer/lib/plan.mjs';

if (process.env.CI !== 'true') throw new Error('Run this qualification in CI only');
const root = fs.mkdtempSync(join(tmpdir(), 'ours-image-permissions-'));
const tag = 'ours-image-permissions:' + randomUUID();
const project = 'ours-repair-' + randomUUID().replaceAll('-', '');
const retainedTag = project + ':runtime';
const failedContainer = project + '-daemon-1';
const docker = args => execFileSync('docker', args, { stdio: 'inherit' });
try {
  const distribution = join(root, 'distribution'); fs.mkdirSync(distribution, { mode: 0o700 });
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--workspace', '@ours.network/install', '--pack-destination', distribution, '--json'], { encoding: 'utf8' }));
  execFileSync('tar', ['-xzf', join(distribution, packed.filename), '-C', distribution, '--no-same-owner']);
  const packedAssets = join(distribution, 'package/assets');
  fs.cpSync(packedAssets, root, { recursive: true });
  // Reproduce materialization under bootstrap umask077: copied nonsecret
  // scripts remain private on the host but must become readable in the image.
  for (const dir of ['build', 'maintenance', 'runtime']) {
    const base = join(root, 'scripts', dir);
    fs.chmodSync(base, 0o700);
    for (const name of fs.readdirSync(base)) {
      const path = join(base, name);
      if (fs.statSync(path).isFile()) fs.chmodSync(path, 0o600);
    }
  }
  const release = JSON.parse(fs.readFileSync('releases/nightly.json'));
  const policy = { release, packages: Object.fromEntries(Object.entries(release.packages).filter(([name]) => SERVER_PACKAGES.includes(name)).map(([name, value]) => [name, { type: 'npm', version: value.version }])) };
  const source = join(root, 'sources.json');
  fs.writeFileSync(source, JSON.stringify(policy));
  fs.chmodSync(source, 0o600);
  docker(['build', '--progress=plain', '--target', 'runtime', '--tag', tag, root]);
  for (const uid of [1000, 12345]) {
    docker(['run', '--rm', '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--user', `${uid}:${uid}`, '--entrypoint', 'node', tag, '--input-type=module', '-e', `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      import { verifyRuntimeRelease } from '/opt/ours/maintenance/release-graph.mjs';
      const manifest = '/opt/ours/sources.json';
      assert.equal(fs.statSync(manifest).uid, 0);
      assert.equal(fs.statSync(manifest).mode & 0o777, 0o644);
      JSON.parse(fs.readFileSync(manifest, 'utf8'));
      assert.equal(verifyRuntimeRelease('/opt/ours').verified, true);
      for (const directory of ['/opt/ours/docker', '/opt/ours/maintenance']) {
        for (const name of fs.readdirSync(directory)) {
          const path = directory + '/' + name;
          if (fs.statSync(path).isFile()) fs.accessSync(path, fs.constants.R_OK);
        }
      }
      console.log('Runtime policy, scripts and release graph readable at UID', process.getuid());
    `]);
  }
  assert.equal(fs.statSync(join(root, 'scripts/maintenance/release-graph.mjs')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(source).mode & 0o777, 0o600, 'host policy remains private');
  // A prior installer left both an old Dockerfile and an unreadable existing image.
  const retained = join(root, 'retained'); fs.mkdirSync(retained, { mode: 0o700 });
  const workDir = join(retained, 'runtime'); fs.cpSync(packedAssets, workDir, { recursive: true });
  fs.chmodSync(workDir, 0o700);
  fs.copyFileSync(source, join(workDir, 'sources.json'));
  const oldDockerfile = fs.readFileSync(join(workDir, 'Dockerfile'), 'utf8').replace('COPY --chmod=644 sources.json', 'COPY sources.json');
  fs.writeFileSync(join(workDir, 'Dockerfile'), oldDockerfile);
  fs.chmodSync(join(workDir, 'Dockerfile'), 0o664); // Common umask002/package materialization mode.
  const sourcesPath = join(retained, 'sources.json'); fs.copyFileSync(source, sourcesPath); fs.chmodSync(sourcesPath, 0o600);
  const brokenFile = join(root, 'Broken.Dockerfile');
  fs.writeFileSync(brokenFile, `FROM ${tag}\nCOPY --chmod=600 sources.json /opt/ours/sources.json\n`);
  docker(['build', '-f', brokenFile, '-t', retainedTag, root]);
  const metadata = image => JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }))[0];
  const broken = metadata(retainedTag);
  try { docker(['run', '--name', failedContainer, '--user', '12345:12345', '--entrypoint', 'node', retainedTag, '-e', "require('fs').readFileSync('/opt/ours/sources.json')"]); assert.fail('old image must fail'); }
  catch (error) { assert.equal(error.status, 1); }
  const beforeContainer = JSON.parse(execFileSync('docker', ['inspect', failedContainer], { encoding: 'utf8' }))[0];
  assert.equal(beforeContainer.State.ExitCode, 1);
  const record = { schema: 2, mode: 'docker', services: [...SERVER_SERVICES], root: retained, workDir, sourcesPath, project, instanceId: randomUUID(), port: 3050, coworkPort: 3052, messengerPort: 3053, uid: 12345, gid: 12345 };
  const effects = realEffects({ env: process.env, out: console.log });
  await effects.prepareInstallation(record, { runtimeOnly: true });
  assert.equal(fs.statSync(join(workDir, 'Dockerfile')).mode & 0o777, 0o600);
  const repaired = metadata(retainedTag);
  assert.notEqual(repaired.Id, broken.Id, 'retry must replace the defective retained image');
  assert.deepEqual(repaired.Config, broken.Config, 'repair preserves image execution settings');
  assert.deepEqual(repaired.RootFS.Layers.slice(0, broken.RootFS.Layers.length), broken.RootFS.Layers);
  docker(['run', '--rm', '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--user', '12345:12345', '--entrypoint', 'node', retainedTag, '--input-type=module', '-e', "import {verifyRuntimeRelease} from '/opt/ours/maintenance/release-graph.mjs'; if(!verifyRuntimeRelease('/opt/ours').verified) process.exit(1)"]);
  assert.match(fs.readFileSync(join(workDir, 'Dockerfile'), 'utf8'), /COPY --chmod=644 sources.json/);
  await effects.prepareInstallation(record, { runtimeOnly: true });
  assert.equal(metadata(retainedTag).Id, repaired.Id, 'second retry reuses qualified image');
  assert.equal(JSON.parse(execFileSync('docker', ['inspect', failedContainer], { encoding: 'utf8' }))[0].Image, broken.Id, 'qualification does not start or replace the actual daemon');
  assert.equal(fs.statSync(sourcesPath).mode & 0o777, 0o600);
  // A cached image with unreadable scripts must rebuild from the retained
  // selection, without deleting state or pretending policy-only repair worked.
  const privateModule = join(workDir, 'scripts/maintenance/release-graph.mjs');
  fs.chmodSync(privateModule, 0o600);
  const retainedDockerfile = join(workDir, 'Dockerfile');
  fs.writeFileSync(retainedDockerfile, fs.readFileSync(retainedDockerfile, 'utf8').replaceAll('COPY --chmod=644 scripts/', 'COPY scripts/'));
  fs.writeFileSync(brokenFile, `FROM ${tag}\nCOPY --chmod=600 scripts/maintenance/release-graph.mjs /opt/ours/maintenance/release-graph.mjs\n`);
  docker(['build', '-f', brokenFile, '-t', retainedTag, root]);
  const scriptsBroken = metadata(retainedTag);
  await effects.prepareInstallation(record, { runtimeOnly: true });
  assert.notEqual(metadata(retainedTag).Id, scriptsBroken.Id);
  assert.equal(fs.existsSync(join(workDir, '.script-permissions-rebuild')), false);
  assert.equal(fs.statSync(privateModule).mode & 0o777, 0o600, 'host module remains private');
  docker(['run', '--rm', '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--user', '12345:12345', '--entrypoint', 'node', retainedTag, '--input-type=module', '-e', "import {verifyRuntimeRelease} from '/opt/ours/maintenance/release-graph.mjs'; if(!verifyRuntimeRelease('/opt/ours').verified) process.exit(1)"]);
  const healthyScripts = metadata(retainedTag).Id;
  await effects.prepareInstallation(record, { runtimeOnly: true });
  assert.equal(metadata(retainedTag).Id, healthyScripts, 'retry reuses verified script rebuild');
  // Qualify real effects.serverAccess argv/imports against a cached image with
  // a legacy helper. Only the current inline helper can expose the CLI refusal.
  await effects.prepareInstallation(record);
  const legacyHelper = join(root, 'legacy-client-setup.mjs');
  fs.writeFileSync(legacyHelper, "throw new Error('legacy helper must not execute');\n");
  fs.writeFileSync(brokenFile, `FROM ${retainedTag}\nCOPY --chmod=644 legacy-client-setup.mjs /opt/ours/docker/client-setup.mjs\n`);
  docker(['build', '-f', brokenFile, '-t', retainedTag, root]);
  const diagnosticImage = metadata(retainedTag).Id;
  const storage = `${project}_server-storage`;
  docker(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--user', '12345:12345',
    '--mount', `type=volume,src=${storage},dst=/storage,volume-nocopy`, '--entrypoint', 'node', retainedTag,
    '-e', "require('fs').writeFileSync('/storage/state/daemon/state_data.bin','retained-state-marker',{mode:0o600})"]);
  await assert.rejects(effects.serverAccess(record, 'access-init'), error => {
    assert.match(error.message, /Stage: official-cli/);
    assert.match(error.message, /Existing daemon state requires explicit --migrate/);
    assert.match(error.message, /Exit code: 1/);
    assert.doesNotMatch(error.message, /legacy helper must not execute/);
    return true;
  });
  assert.equal(metadata(retainedTag).Id, diagnosticImage, 'diagnostics never rebuild or retag the retained image');
  docker(['run', '--rm', '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--user', '12345:12345',
    '--mount', `type=volume,src=${storage},dst=/storage,readonly,volume-nocopy`, '--entrypoint', 'node', retainedTag,
    '-e', "const fs=require('fs'),a=require('assert/strict');a.equal(fs.readFileSync('/storage/state/daemon/state_data.bin','utf8'),'retained-state-marker');a.equal(fs.existsSync('/storage/state/daemon/api-master.key'),false)"]);
  console.log('Verified real Compose inline helper and retained CLI refusal without state/authority replacement.');
  console.log('Verified installer repair of retained old assets/image after exit1, and idempotent retry.');

} finally {
  for (const suffix of ['server-storage', 'owner-locks']) { try { execFileSync('docker', ['volume', 'rm', `${project}_${suffix}`], { stdio: 'ignore' }); } catch {} }
  try { execFileSync('docker', ['rm', failedContainer], { stdio: 'ignore' }); } catch {}
  try { execFileSync('docker', ['image', 'rm', retainedTag], { stdio: 'ignore' }); } catch {}
  try { execFileSync('docker', ['image', 'rm', tag], { stdio: 'ignore' }); } catch { /* build may have failed */ }
  fs.rmSync(root, { recursive: true, force: true });
}
