import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayCompose } from '../lib/gateway.mjs';

const composeAvailable = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
for (const gateway of [false, true]) {
  test(`resolved ${gateway ? 'gateway' : 'direct'} delivery restarts servers but never administrative jobs`,
    { skip: !composeAvailable }, t => {
      const root = mkdtempSync(join(tmpdir(), 'ours-restart-policy-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const files = ['-f', fileURLToPath(new URL('../assets/docker-compose.yaml', import.meta.url))];
      if (gateway) {
        const path = join(root, 'gateway.yaml');
        writeFileSync(path, gatewayCompose({ project: 'restart-test', port: 3050, coworkPort: 3052 }));
        files.push('-f', path);
      }
      // Resolve actual Compose inheritance and overrides, without starting Docker.
      const config = JSON.parse(execFileSync('docker', ['compose', ...files,
        '--profile', '*', 'config', '--format', 'json'], {
        encoding: 'utf8', env: { ...process.env, OURS_DAEMON_ID: '11111111-2222-3333-4444-555555555555' },
      }));
      const servers = ['daemon', 'cowork', 'messenger', 'telegram', ...(gateway ? ['gateway'] : [])];
      for (const service of servers) assert.equal(config.services[service].restart, 'unless-stopped', service);
      for (const service of ['prepare', 'access', 'legacy-import', 'state-operation'])
        assert.ok(!config.services[service].restart || config.services[service].restart === 'no', service);
    });
}
