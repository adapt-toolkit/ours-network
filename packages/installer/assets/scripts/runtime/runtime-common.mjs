import { readBuildRecords, initializeBuildMarker } from '../maintenance/build-context.mjs';
import { accessSync, constants, lstatSync, readFileSync } from 'node:fs';

export function privatePath(path, directory = false, writable = false) {
  const stat = lstatSync(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
      || stat.uid !== process.getuid() || stat.gid !== process.getgid()
      || (stat.mode & 0o7077) !== 0) {
    throw new Error(`Unsafe ownership or permissions: ${path}`);
  }
  accessSync(path, constants.R_OK | (directory ? constants.X_OK : 0) | (writable ? constants.W_OK : 0));
}

export function jsonConfig(path) {
  try {
    privatePath(path);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`Invalid config: ${path}`);
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function checkRuntime(state, id) {
  if (!process.getuid() || !process.getgid()) throw new Error('Run as a non-root UID and GID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id ?? '')) {
    throw new Error('Configure a stable daemon UUID');
  }
  privatePath(state, true, true);
  for (const name of ['OURS_API_TOKEN', 'OURS_DAEMON_TOKEN', 'OURS_TG_BOT_TOKEN', 'OURS_TG_STT_API_KEY', 'TELEGRAM_BOT_TOKEN']) {
    if (process.env[name] !== undefined) throw new Error(`Use a protected credential file instead of ${name}`);
  }
}

export function checkCredential(path) {
  privatePath(path);
  // Credential format and authenticity belong to the SDK attachment API.
  if (!readFileSync(path, 'utf8').trim()) throw new Error(`Empty daemon credential: ${path}`);
}

// Called with the startup state-directory lock held. These are build records,
// not a storage schema or a declaration that arbitrary upgrades are compatible.
export function recordBuild(state) {
  initializeBuildMarker(`${state}/.ours-provenance`, readBuildRecords('/opt/ours'));
}
