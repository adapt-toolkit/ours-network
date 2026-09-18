/** Exercise the shipped Dockerfile with the installer's private host manifest. CI only. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { realEffects } from '../packages/installer/lib/effects.mjs';
import { SERVER_PACKAGES } from '../packages/installer/lib/plan.mjs';

if (process.env.CI !== 'true') throw new Error('Run this qualification in CI only');
const root = fs.mkdtempSync(join(tmpdir(), 'ours-image-permissions-'));
const tag = 'ours-image-permissions:' + randomUUID();
const project = 'ours-repair-' + randomUUID().replaceAll('-', '');
const retainedTag = project + ':runtime';
const failedContainer = project + '-daemon-1';
const docker = args => execFileSync('docker', args, { stdio: 'inherit' });
try {
  fs.cpSync('packages/installer/assets', root, { recursive: true });
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
  assert.equal(fs.statSync(source).mode & 0o777, 0o600, 'host policy remains private');
  // A prior installer left both an old Dockerfile and an unreadable existing image.
  const retained = join(root, 'retained'); fs.mkdirSync(retained, { mode: 0o700 });
  const workDir = join(retained, 'runtime'); fs.cpSync(root, workDir, { recursive: true, filter: path => path !== retained });
  const oldDockerfile = fs.readFileSync(join(workDir, 'Dockerfile'), 'utf8').replace('COPY --chmod=644 sources.json', 'COPY sources.json');
  fs.writeFileSync(join(workDir, 'Dockerfile'), oldDockerfile);
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
  const record = { schema: 2, mode: 'docker', root: retained, workDir, sourcesPath, project, uid: 12345, gid: 12345 };
  const effects = realEffects({ env: process.env, out: console.log });
  await effects.prepareInstallation(record, { runtimeOnly: true });
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
  console.log('Verified installer repair of retained old assets/image after exit1, and idempotent retry.');

} finally {
  try { execFileSync('docker', ['rm', failedContainer], { stdio: 'ignore' }); } catch {}
  try { execFileSync('docker', ['image', 'rm', retainedTag], { stdio: 'ignore' }); } catch {}
  try { execFileSync('docker', ['image', 'rm', tag], { stdio: 'ignore' }); } catch { /* build may have failed */ }
  fs.rmSync(root, { recursive: true, force: true });
}
