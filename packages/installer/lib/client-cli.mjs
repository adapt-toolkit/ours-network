import { lstatSync, readFileSync, writeFileSync, realpathSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { buildManagedCli } from './managed-cli.mjs';

const marker = '// ours-managed-cli-v1 ';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function stat(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** Publish the native client, retaining a verified migration launcher for rollback. */
export async function publishClientCli(effects, packagePath) {
  const prefix = (await effects.run('npm', ['prefix', '--global'])).stdout.trim();
  if (!isAbsolute(prefix) || resolve(prefix) !== prefix) throw new Error('npm global prefix must be an absolute normalized path');
  const entry = join(prefix, 'bin', 'ours');
  const before = stat(entry);
  let previous;
  if (before) {
    if (before.uid !== process.getuid()) throw new Error('Refusing to replace a CLI owned by another user');
    if (before.isSymbolicLink()) {
      const npmRoot = (await effects.run('npm', ['root', '--global'])).stdout.trim();
      if (!isAbsolute(npmRoot)) throw new Error('Invalid npm global package root');
      const root = realpathSync(join(npmRoot, '@ours.network/cli'));
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (manifest.name !== '@ours.network/cli' || typeof manifest.bin?.ours !== 'string' || realpathSync(entry) !== realpathSync(resolve(root, manifest.bin.ours))) throw new Error('Refusing to replace an unrelated ours symlink');
    } else {
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o022)) throw new Error('Refusing to replace an unsafe CLI entry');
      previous = readFileSync(entry);
      const line = previous.toString().split('\n')[1];
      if (!line?.startsWith(marker)) throw new Error('Refusing to replace an unknown ours executable');
      const binding = JSON.parse(line.slice(marker.length));
      if (binding.schema !== 1 || previous.toString() !== buildManagedCli(binding.recordPath, binding.installerPath)) throw new Error('Managed CLI launcher was modified; no replacement performed');
      const backup = join(effects.home, '.ours-client', `previous-cli-${hash(previous)}.cjs`);
      if (!existsSync(backup)) writeFileSync(backup, previous, { mode: 0o600, flag: 'wx' });
      else if (!readFileSync(backup).equals(previous)) throw new Error('Managed CLI backup differs');
      const current = lstatSync(entry);
      if (current.dev !== before.dev || current.ino !== before.ino || !readFileSync(entry).equals(previous)) throw new Error('CLI changed during publication');
      unlinkSync(entry);
      effects.out(`Previous managed CLI saved at ${backup}; server maintenance remains available through ours-install server.`);
    }
  }
  try {
    await effects.run('npm', ['install', '--global', '--install-links=false', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', packagePath]);
  } catch (error) {
    if (previous && !stat(entry)) {
      writeFileSync(entry, previous, { mode: before.mode & 0o777, flag: 'wx' });
      chmodSync(entry, before.mode & 0o777);
    }
    throw error;
  }
  return entry;
}
