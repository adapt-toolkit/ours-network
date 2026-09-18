import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export function snapshotConfig(path) {
  if (!existsSync(path)) return { exists: false, text: '', mode: 0o600 };
  return {
    exists: true,
    text: readFileSync(path, 'utf8'),
    mode: statSync(path).mode & 0o777,
  };
}

// Write beside the destination and rename only after a complete write. A failure
// leaves the old config byte-for-byte intact. The injectable rename seam is for failure tests.
export function atomicWriteConfig(path, text, { rename = renameSync } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    rename(tmp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* absent or already renamed */ }
    throw error;
  }
  return path;
}

export function restoreConfig(path, snapshot) {
  if (snapshot.exists) {
    atomicWriteConfig(path, snapshot.text);
    // Restore the pre-transaction permissions. Normal successful secret writes always use 0600.
    chmodSync(path, snapshot.mode);
  } else {
    try { unlinkSync(path); } catch { /* already absent */ }
  }
}

// Apply a config and validate/reload it as one transaction. If the apply callback fails, restore
// the exact previous bytes and invoke it once more to reload the old configuration.
export function transactionalConfigUpdate(path, text, apply) {
  const before = snapshotConfig(path);
  try {
    atomicWriteConfig(path, text);
  } catch (error) {
    return { ok: false, stage: 'write', rolledBack: true, error };
  }
  let applied;
  try {
    applied = apply();
  } catch (error) {
    applied = { ok: false, error };
  }
  if (applied?.ok) return { ok: true, stage: 'apply', rolledBack: false };
  try {
    restoreConfig(path, before);
    apply();
    return { ok: false, stage: 'apply', rolledBack: true, error: applied?.error };
  } catch (error) {
    return { ok: false, stage: 'rollback', rolledBack: false, error };
  }
}
