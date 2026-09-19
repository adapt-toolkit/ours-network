import { lstatSync, readFileSync, writeFileSync, realpathSync, unlinkSync, chmodSync, symlinkSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildManagedCli } from './managed-cli.mjs';

import { createRequire } from 'node:module';
import { releaseBinding, verifyReleaseGraph } from '../assets/scripts/maintenance/release-graph.mjs';

const marker = '// ours-managed-cli-v1 ';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function stat(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function privateAcquisition(home, root) {
  for (const path of [join(home, '.ours-client-install'), root]) {
    const value = lstatSync(path);
    if (!value.isDirectory() || value.uid !== process.getuid() || (value.mode & 0o077) || realpathSync(path) !== path) throw new Error('Unsafe private CLI directory');
  }
}
/** Publish the native client, retaining a verified migration launcher for rollback. */
export async function publishClientCli(effects, packagePath, { policy = {}, isolated = false } = {}) {
  const prefix = (await effects.run('npm', ['prefix', '--global'])).stdout.trim();
  if (!isAbsolute(prefix) || resolve(prefix) !== prefix) throw new Error('npm global prefix must be an absolute normalized path');
  const entry = join(prefix, 'bin', 'ours');
  const before = stat(entry);
  let previous;
  if (before) {
    if (before.uid !== process.getuid()) throw new Error('Refusing to replace a CLI owned by another user');
    if (before.isSymbolicLink()) {
      const resolved = realpathSync(entry);
      const privateBase = join(effects.home, '.ours-client-install') + '/';
      if (resolved.startsWith(privateBase)) {
        const packageRoot = dirname(dirname(resolved));
        const acquisitionRoot = dirname(dirname(dirname(packageRoot)));
        privateAcquisition(effects.home, acquisitionRoot);
        const retained = JSON.parse(readFileSync(join(acquisitionRoot, 'sources.json')));
        if (releaseBinding(retained)?.scope !== 'host-cli') throw new Error('Unrecognized private CLI entry');
        verifyReleaseGraph(acquisitionRoot, retained);
        const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json')));
        if (pkg.name !== '@ours.network/cli' || resolve(packageRoot, pkg.bin?.ours ?? '') !== resolved) throw new Error('Unrecognized private CLI target');
      } else {
        const npmRoot = (await effects.run('npm', ['root', '--global'])).stdout.trim();
        if (!isAbsolute(npmRoot)) throw new Error('Invalid npm global package root');
        const root = realpathSync(join(npmRoot, '@ours.network/cli'));
        const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        if (manifest.name !== '@ours.network/cli' || typeof manifest.bin?.ours !== 'string' || resolved !== realpathSync(resolve(root, manifest.bin.ours))) throw new Error('Refusing to replace an unrelated ours symlink');
      }
    } else {
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o022)) throw new Error('Refusing to replace an unsafe CLI entry');
      previous = readFileSync(entry);
      const line = previous.toString().split('\n')[1];
      if (!line?.startsWith(marker)) throw new Error('Refusing to replace an unknown ours executable');
      const binding = JSON.parse(line.slice(marker.length));
      if (binding.schema !== 1 || previous.toString() !== buildManagedCli(binding.recordPath, binding.installerPath)) throw new Error('Managed CLI launcher was modified; no replacement performed');
      const backup = join(effects.home, '.ours-client', `previous-cli-${hash(previous)}.cjs`);
      const backupDir = lstatSync(join(effects.home, '.ours-client'));
      if (!backupDir.isDirectory() || backupDir.uid !== process.getuid() || (backupDir.mode & 0o7777) !== 0o700) throw new Error('Managed CLI backup requires a private owned directory');
      const saved = stat(backup);
      if (!saved) writeFileSync(backup, previous, { mode: 0o600, flag: 'wx' });
      else if (!saved.isFile() || saved.nlink !== 1 || saved.uid !== process.getuid() || (saved.mode & 0o7777) !== 0o600 || saved.size !== previous.length || !readFileSync(backup).equals(previous)) throw new Error('Managed CLI backup is unsafe or differs');
      const current = lstatSync(entry);
      if (current.dev !== before.dev || current.ino !== before.ino || !readFileSync(entry).equals(previous)) throw new Error('CLI changed during publication');
      if (!isolated) unlinkSync(entry);
      effects.out(`Previous managed CLI saved at ${backup}; server maintenance remains available through ours-install server.`);
    }
  }
  if (isolated) {
    const root = dirname(dirname(dirname(packagePath)));
    if (!realpathSync(root).startsWith(join(effects.home, '.ours-client-install') + '/') || releaseBinding(policy)?.scope !== 'host-cli') throw new Error('Invalid private CLI acquisition');
    privateAcquisition(effects.home, root);
    verifyReleaseGraph(root, policy);
    const selected = JSON.parse(readFileSync(join(packagePath, 'package.json')));
    const target = realpathSync(resolve(packagePath, selected.bin.ours));
    if (!target.startsWith(realpathSync(packagePath) + '/')) throw new Error('CLI entry escapes selected package');
    const sdkEntry = realpathSync(createRequire(target).resolve('@ours.network/sdk'));
    if (!sdkEntry.startsWith(root + '/')) throw new Error('Private CLI SDK escaped verified acquisition');
    const sdk = JSON.parse(readFileSync(join(dirname(dirname(sdkEntry)), 'package.json')));
    if (sdk.name !== '@ours.network/sdk' || sdk.version !== policy.release.packages['@ours.network/sdk'].version) throw new Error('Private CLI SDK differs from selection');
    mkdirSync(dirname(entry), { recursive: true });
    const binDir = lstatSync(dirname(entry));
    if (!binDir.isDirectory() || binDir.uid !== process.getuid() || (binDir.mode & 0o022)) throw new Error('CLI bin directory must be owned and not writable by others');
    const current = stat(entry);
    if (before ? !current || current.dev !== before.dev || current.ino !== before.ino : current) throw new Error('CLI entry changed during publication');
    const staged = entry + '.' + randomUUID();
    try {
      symlinkSync(target, staged);
      renameSync(staged, entry);
    } catch (error) {
      if (stat(staged)) unlinkSync(staged);
      if (previous && !stat(entry)) writeFileSync(entry, previous, { mode: before.mode & 0o777, flag: 'wx' });
      throw error;
    }
    if (realpathSync(entry) !== target) throw new Error('Private CLI entry changed during publication');
    verifyReleaseGraph(root, policy);
    return entry;
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
  const published = stat(entry);
  if (!published?.isSymbolicLink() || published.uid !== process.getuid()) throw new Error('CLI publication did not create the expected owned npm entry');
  const npmRoot = (await effects.run('npm', ['root', '--global'])).stdout.trim();
  if (!isAbsolute(npmRoot) || resolve(npmRoot) !== npmRoot) throw new Error('Invalid npm global package root');
  const root = realpathSync(join(npmRoot, '@ours.network/cli'));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const selected = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
  const target = typeof manifest.bin?.ours === 'string' ? resolve(root, manifest.bin.ours) : '';
  if (manifest.name !== '@ours.network/cli' || manifest.version !== selected.version || !target.startsWith(root + '/') || realpathSync(entry) !== realpathSync(target) || !stat(target)?.isFile()) throw new Error('Published CLI does not match the selected package');
  if (!readFileSync(target).equals(readFileSync(resolve(packagePath, selected.bin.ours)))) throw new Error('Published CLI entry differs from the selected artifact');
  return entry;
}
