/** The Docker build context: one definition shared by host installs and release CI. */
import { chmodSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTALLER_ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));

/** Copy the shipped assets; the caller supplies the selection as sources.json. */
export function copyDockerAssets(workDir) {
  cpSync(INSTALLER_ASSETS, workDir, { recursive: true, errorOnExist: true, force: false });
  chmodSync(workDir, 0o700);
  // Release descriptors are distribution metadata, never part of image content.
  rmSync(join(workDir, 'images.json'), { force: true });
  rmSync(join(workDir, 'sources.json'));
}

/** The installer owns the maintenance tools' dependencies in both installation modes. */
export function writeMaintenancePackage(workDir) {
  const { dependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  writeFileSync(join(workDir, 'scripts/maintenance/package.json'), JSON.stringify({ private: true, type: 'module', dependencies }, null, 2) + '\n', { mode: 0o600 });
}

/** A complete context for one role's selection, as a host would build it. */
export function stageDockerContext(workDir, policy) {
  copyDockerAssets(workDir);
  writeFileSync(join(workDir, 'sources.json'), policy, { mode: 0o600, flag: 'wx' });
  writeMaintenancePackage(workDir);
}
