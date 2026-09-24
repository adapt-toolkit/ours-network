import { mkdirSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const configPath = '/state/config.json';
const credentialPath = '/state/daemon-token';
mkdirSync('/state', { recursive: true, mode: 0o700 });
chmodSync('/state', 0o700);
if (!existsSync(configPath)) {
  writeFileSync(configPath, `${JSON.stringify({
    stateDir: '/state', port: 3050, brokerUrl: 'ws://broker:9000', apiVisibility: 'owner',
  })}\n`, { mode: 0o600 });
}
const cli = '/opt/ours/node_modules/.bin/ours-daemon';
function run(args) {
  const child = spawnSync(cli, args, { stdio: args[0] === 'config' ? 'ignore' : 'inherit' });
  if (child.status !== 0) process.exit(child.status ?? 1);
}
run(['config', 'access-init', '--config', configPath, '--json']);
if (!existsSync(credentialPath)) run(['config', 'access-issue', '--config', configPath, '--output', credentialPath, '--json']);
const child = spawn(cli, ['daemon', 'serve', '--config', configPath], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  writeFileSync('/state/shutdown-request.json', JSON.stringify({ signal, at: new Date().toISOString() }));
  child.kill(signal);
});
child.on('exit', (code, signal) => {
  writeFileSync('/state/shutdown-result.json', JSON.stringify({ code, signal, at: new Date().toISOString() }));
  process.exitCode = code ?? (signal === 'SIGTERM' ? 0 : 1);
});
