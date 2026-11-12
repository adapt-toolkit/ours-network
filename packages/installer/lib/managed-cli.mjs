/** The managed `ours` launcher bound to one installation record. */
import { dirname, isAbsolute, resolve } from 'node:path';

const marker = '// ours-managed-cli-v1 ';
function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\r\n\0]/.test(path)) throw new Error('Managed CLI requires normalized absolute paths');
  return path;
}

export function buildManagedCli(recordPath, installerPath) {
  absolute(recordPath); absolute(installerPath);
  const binding = { schema: 1, targetRoot: dirname(recordPath), recordPath, installerPath };
  return `#!/usr/bin/env node
${marker}${JSON.stringify(binding)}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const binding = ${JSON.stringify(binding)};
function fail(message) { console.error('ours: ' + message); process.exit(2); }
const args = process.argv.slice(2);
if (args.some(arg => /^(?:--config|--state-dir|--port|--daemon-id|--daemon-url|--endpoint|--credential-path)(?:=|$)/.test(arg))) fail('This command belongs to the managed installation. Use ours-install to select or manage another installation.');
let record;
try {
  const stat = fs.lstatSync(binding.recordPath);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || fs.realpathSync(binding.recordPath) !== binding.recordPath) throw new Error('unsafe record');
  record = JSON.parse(fs.readFileSync(binding.recordPath, 'utf8'));
} catch { fail('The managed installation record is missing or unsafe; repair it with ours-install.'); }
if (record.schema !== 2 || record.root !== binding.targetRoot || !['packages', 'docker'].includes(record.mode)
    || typeof record.instanceId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(record.instanceId)
    || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535
    || record.workDir !== path.join(record.root, 'runtime') || record.configPath !== path.join(record.root, 'storage/state/daemon/config.json')
    || (record.mode === 'docker' && (typeof record.project !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(record.project)))) fail('The managed installation selection is invalid.');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('OURS_')) delete env[key];
const lifecycle = args[0] === 'daemon' && ['start', 'stop', 'restart', 'status'].includes(args[1]);
const version = args[0] === 'version' || args[0] === '--version' || args[0] === '-V';
let command, commandArgs;
if (lifecycle) {
  if (args.slice(2).some(arg => arg !== '--json') || (args[1] !== 'status' && args.includes('--json'))) fail('Use ours-install server for lifecycle options; --json is supported for status only.');
  command = process.execPath;
  commandArgs = [binding.installerPath, 'server', args[1], '--state-dir', record.root];
} else {
  if (args[0] === 'daemon') fail('Use ours-install server to manage this installation and its services.');
  if (args[0] === 'config' && args[1] !== 'show') fail('Use ours-install server to manage configuration and credentials.');
  if (record.mode === 'docker') {
    command = 'docker';
    commandArgs = ['exec', '-i', record.project + '-daemon-1', 'node', '/opt/ours/node_modules/@ours.network/cli/dist/cli.js', ...args];
    if (!version) commandArgs.push('--config', '/var/lib/ours/config.json', '--state-dir', '/var/lib/ours');
  } else {
    command = path.join(record.workDir, 'node_modules/.bin/ours');
    commandArgs = [...args];
    if (!version) commandArgs.push('--config', record.configPath, '--state-dir', path.join(record.root, 'storage/state/daemon'));
    Object.assign(env, { OURS_CONFIG: record.configPath, OURS_STATE_DIR: path.join(record.root, 'storage/state/daemon'), OURS_PORT: String(record.port), OURS_DAEMON_ID: record.instanceId });
  }
}
const result = spawnSync(command, commandArgs, { stdio: 'inherit', env });
if (result.error) fail('Could not start the managed command: ' + result.error.message);
if (result.signal) { process.kill(process.pid, result.signal); process.exit(1); }
process.exit(result.status ?? 1);
`;
}
