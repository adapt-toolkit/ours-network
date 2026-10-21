/** Replace only the verified, user-owned npm CLI entry after managed cutover. */
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const marker = '// ours-managed-cli-v1 ';
const backupName = 'managed-cli-original.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uid = () => process.getuid();
function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\r\n\0]/.test(path)) throw new Error('Managed CLI requires normalized absolute paths');
  return path;
}
function owned(path, { directory = false, writable = false } = {}) {
  const stat = lstatSync(path);
  if (stat.uid !== uid() || (directory ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1)) || (stat.mode & 0o022)) throw new Error(`Managed CLI refuses foreign or unsafe ownership: ${path}`);
  if (directory && realpathSync(path) !== path) throw new Error('Managed CLI directory must be canonical');
  if (writable) {
    if (!(stat.mode & 0o200)) throw new Error(`Managed CLI path is read-only: ${path}`);
    accessSync(path, constants.W_OK | (directory ? constants.X_OK : 0));
  }
  return stat;
}
function snapshot(path) {
  const stat = lstatSync(path);
  if (stat.uid !== uid() || (!stat.isSymbolicLink() && (!stat.isFile() || stat.nlink !== 1))) throw new Error('Managed CLI entry is not an owned file or symlink');
  if (!stat.isSymbolicLink() && (stat.mode & 0o022)) throw new Error('Managed CLI entry is writable by another user');
  return { kind: stat.isSymbolicLink() ? 'symlink' : 'file', dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777,
    size: stat.size, mtimeMs: stat.mtimeMs, ...(stat.isSymbolicLink() ? { link: readlinkSync(path), resolved: realpathSync(path) } : {}), digest: sha(readFileSync(path)) };
}
function readBackup(targetRoot) {
  const path = join(targetRoot, 'legacy-backup', backupName);
  owned(dirname(path), { directory: true }); owned(path);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.schema !== 1 || value.targetRoot !== targetRoot || !value.original || typeof value.originalProgram !== 'string') throw new Error('Invalid managed CLI backup');
  return value;
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

export async function inspectManagedCli(effects, targetRoot) {
  if (!['linux', 'darwin'].includes(effects.platform?.platform ?? process.platform) || typeof process.getuid !== 'function') throw new Error('Managed CLI cutover supports Linux/macOS only');
  absolute(targetRoot);
  const output = async args => {
    const result = await effects.run(args[0], args.slice(1));
    if (result.code !== undefined && result.code !== 0) throw new Error('Cannot determine the existing global CLI selection');
    return absolute(result.stdout.trim());
  };
  const npmRoot = await output(['npm', 'root', '--global']);
  const prefix = await output(['npm', 'prefix', '--global']);
  const binPath = join(prefix, 'bin', 'ours');
  const selected = await output(['which', 'ours']);
  if (selected !== binPath) throw new Error('PATH selects another ours command; select the verified npm global bin before migration');
  owned(dirname(binPath), { directory: true, writable: true });
  const packageRoot = realpathSync(join(npmRoot, '@ours.network/cli'));
  const packagePath = join(packageRoot, 'package.json'); owned(packagePath);
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (pkg.name !== '@ours.network/cli' || typeof pkg.bin?.ours !== 'string') throw new Error('Global package does not declare the expected ours CLI');
  const originalProgram = realpathSync(resolve(packageRoot, pkg.bin.ours));
  if (!originalProgram.startsWith(packageRoot + '/')) throw new Error('Global CLI bin escapes its package');
  owned(originalProgram); accessSync(originalProgram, constants.R_OK | constants.X_OK);
  const before = snapshot(binPath);
  let installed = false;
  let installerPath = fileURLToPath(new URL('../install.mjs', import.meta.url));
  if (before.kind === 'symlink') {
    if (before.resolved !== originalProgram) throw new Error('Global ours symlink does not target the verified npm CLI');
  } else {
    const contents = readFileSync(binPath, 'utf8');
    const line = contents.split('\n')[1];
    if (!line?.startsWith(marker)) throw new Error('Refusing to replace an unknown ours executable');
    const binding = JSON.parse(line.slice(marker.length));
    if (binding.schema !== 1 || binding.targetRoot !== targetRoot || binding.recordPath !== join(targetRoot, 'installation.json')) throw new Error('Managed CLI belongs to another installation');
    installerPath = absolute(binding.installerPath);
    if (contents !== buildManagedCli(binding.recordPath, installerPath)) throw new Error('Managed CLI launcher was modified');
    const backup = readBackup(targetRoot);
    if (backup.binPath !== binPath || backup.originalProgram !== originalProgram) throw new Error('Managed CLI backup selects another original executable');
    installed = true;
  }
  return { schema: 1, targetRoot, binPath, originalProgram, installerPath, before, installed };
}

export async function installManagedCli(record, cliPlan, effects, { rename = renameSync } = {}) {
  if (record.root !== cliPlan.targetRoot) throw new Error('Managed CLI target changed after inspection');
  const fresh = await inspectManagedCli(effects, record.root);
  if (fresh.binPath !== cliPlan.binPath || fresh.originalProgram !== cliPlan.originalProgram || JSON.stringify(fresh.before) !== JSON.stringify(cliPlan.before)) throw new Error('Global CLI changed after inspection; cutover refused');
  const installerPath = absolute(cliPlan.installerPath);
  owned(installerPath);
  if (realpathSync(installerPath) !== installerPath) throw new Error('Managed installer path must be canonical');
  if (fresh.installed && fresh.installerPath !== installerPath) throw new Error('Managed installer selection changed after inspection');
  if (fresh.installed) return { binPath: fresh.binPath, originalProgram: fresh.originalProgram, changed: false };
  owned(record.root, { directory: true });
  const backupDir = join(record.root, 'legacy-backup');
  if (!existsSync(backupDir)) mkdirSync(backupDir, { mode: 0o700 });
  const backupStat = owned(backupDir, { directory: true });
  if (backupStat.mode & 0o077) throw new Error('CLI backup directory must be private');
  const backupPath = join(backupDir, backupName);
  const backup = { schema: 1, targetRoot: record.root, binPath: fresh.binPath, originalProgram: fresh.originalProgram,
    original: fresh.before, ...(fresh.before.kind === 'file' ? { bytes: readFileSync(fresh.binPath).toString('base64') } : {}) };
  if (existsSync(backupPath)) {
    const original = readBackup(record.root);
    if (original.binPath !== backup.binPath || original.originalProgram !== backup.originalProgram) throw new Error('Existing CLI backup differs from the selected original');
  } else writeFileSync(backupPath, JSON.stringify(backup, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const contents = buildManagedCli(join(record.root, 'installation.json'), installerPath);
  const temporary = join(dirname(fresh.binPath), `.ours-managed-${randomUUID()}`);
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode: 0o700 }); chmodSync(temporary, 0o755);
    if (JSON.stringify(snapshot(fresh.binPath)) !== JSON.stringify(fresh.before)) throw new Error('Global CLI changed during cutover');
    rename(temporary, fresh.binPath);
  } finally { rmSync(temporary, { force: true }); }
  return { binPath: fresh.binPath, originalProgram: fresh.originalProgram, changed: true };
}
