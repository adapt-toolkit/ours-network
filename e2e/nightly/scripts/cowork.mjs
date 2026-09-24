import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

const configPath = process.env.OURS_COWORK_CONFIG;
if (!configPath) throw new Error('OURS_COWORK_CONFIG is required');
const stateDir = dirname(configPath);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
chmodSync(stateDir, 0o700);
writeFileSync(configPath, JSON.stringify({
  version: 1,
  stateDir,
  rest: { enabled: false, port: 3052 },
}), { mode: 0o600 });
chmodSync(configPath, 0o600);
const child = spawn('/opt/ours/node_modules/.bin/ours-cowork', ['serve'], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
