import { spawnSync } from 'node:child_process';

for (const name of ['smoke', 'flows', 'telegram', 'rooms-agents', 'regressions-fleet', 'regressions-client', 'regressions-telegram', 'regressions-component', 'security', 'recovery']) {
  const result = spawnSync(process.execPath, ['/opt/ours/tests/run.mjs', name, '--include-deferred', '--dry-run'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
