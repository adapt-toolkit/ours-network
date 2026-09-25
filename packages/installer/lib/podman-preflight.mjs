import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runContainer } from './container-engine.mjs';

export const PROBE_IMAGE = 'docker.io/library/nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236';
/** Behavioral checks, in disposable resources, before touching installation storage. */
export async function qualifyPodman(effects, record) {
  const root = mkdtempSync(join(tmpdir(), 'ours-podman-preflight-'));
  const project = `ours-probe-${randomUUID()}`;
  const file = join(root, 'compose.json'), overlay = join(root, 'reset.yaml');
  const common = { image: PROBE_IMAGE, entrypoint: ['/bin/sh', '-ec'], read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'] };
  writeFileSync(file, JSON.stringify({ services: {
    prepare: { ...common, user: '0:0', network_mode: 'none', cap_add: ['CHOWN', 'DAC_OVERRIDE'],
      command: ['mkdir -p /storage/state/daemon /storage/state/sibling; chmod 700 /storage/state/daemon; chown 1000:1000 /storage/state/daemon'],
      volumes: [{ type: 'volume', source: 'data', target: '/storage', volume: { nocopy: true } }] },
    probe: { ...common, user: '1000:1000', command: ['test ! -e /data/sibling; test "$(stat -c %a /data)" = 700; echo ready > /data/probe; nslookup -type=A probe.; sleep 120'],
      healthcheck: { test: ['CMD-SHELL', 'test -s /data/probe'], interval: '1s', timeout: '2s', retries: 10 },
      volumes: [{ type: 'volume', source: 'data', target: '/data', volume: { nocopy: true, subpath: 'state/daemon' } }] },
  }, volumes: { data: {} } }), { mode: 0o600 });
  writeFileSync(overlay, 'services:\n  probe:\n    ports: !reset []\n', { mode: 0o600 });
  const compose = args => runContainer(effects, record, ['compose', '-p', project, '-f', file, '-f', overlay, ...args], { timeout: 180000 });
  try {
    await compose(['config', '--format', 'json']);
    await compose(['run', '--rm', '--no-deps', '-T', 'prepare']);
    await compose(['up', '-d', '--no-build', '--wait', 'probe']);
    const result = await compose(['ps', '--format', 'json']);
    const rows = result.stdout.trim().startsWith('[') ? JSON.parse(result.stdout) : result.stdout.trim().split('\n').map(s => JSON.parse(s));
    if (!rows.some(r => r.Service === 'probe' && r.State === 'running')) throw new Error('Compose JSON status is incompatible');
    await compose(['exec', '-T', 'probe', '/bin/sh', '-ec', 'test -s /data/probe; test ! -e /data/state']);
  } catch (cause) {
    let logs = '';
    try { logs = (await compose(['logs', '--no-color', '--tail', '30'])).stdout; } catch {}
    throw new Error(`Podman capability check failed (Compose !reset/wait/status, DNS, rootless UID, volume subpath): ${cause.message}\n${logs}`, { cause });
  } finally {
    try { await compose(['down', '--volumes', '--remove-orphans']); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}
