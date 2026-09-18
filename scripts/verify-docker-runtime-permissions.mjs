/** Exercise the shipped Dockerfile with the installer's private host manifest. CI only. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { SERVER_PACKAGES } from '../packages/installer/lib/plan.mjs';

if (process.env.CI !== 'true') throw new Error('Run this qualification in CI only');
const root = fs.mkdtempSync(join(tmpdir(), 'ours-image-permissions-'));
const tag = 'ours-image-permissions:' + randomUUID();
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
} finally {
  try { execFileSync('docker', ['image', 'rm', tag], { stdio: 'ignore' }); } catch { /* build may have failed */ }
  fs.rmSync(root, { recursive: true, force: true });
}
