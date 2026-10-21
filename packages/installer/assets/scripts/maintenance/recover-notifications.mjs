/** Non-secret retained build evidence arrives on stdin, never in argv/env. */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStateOperation } from './state-operation.mjs';

// The shipped state-operation service is read_only without a /tmp tmpfs, and
// retained Compose definitions cannot gain one. /dev/shm stays a writable
// in-memory mount there, so evidence never enters the stored-state volume.
function scratch() {
  for (const base of [tmpdir(), '/dev/shm']) {
    try { return fs.mkdtempSync(join(base, 'ours-notifications-recovery-')); }
    catch (error) { if (!['EROFS', 'EACCES', 'ENOENT'].includes(error.code)) throw error; }
  }
  throw new Error('No writable private scratch directory for recovery evidence');
}
const root = scratch();
fs.chmodSync(root, 0o700);
try {
  const evidence = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!evidence || Object.keys(evidence).sort().join(',') !== 'phase,previous,target'
    || !['prepared', 'state-updated', 'runtime-activated'].includes(evidence.phase)) throw new Error('Invalid recovery evidence');
  for (const name of ['previous', 'target']) {
    const records = evidence[name], names = Object.keys(records).sort();
    if (!['dependency-tree.json,package-lock.json', 'build-context.json,dependency-tree.json,package-lock.json'].includes(names.join(','))) throw new Error('Invalid recovery record set');
    const directory = join(root, name); fs.mkdirSync(directory, { mode: 0o700 });
    for (const file of names) {
      if (typeof records[file] !== 'string') throw new Error('Invalid recovery record bytes');
      fs.writeFileSync(join(directory, file), Buffer.from(records[file], 'base64'), { flag: 'wx', mode: 0o600 });
    }
  }
  const result = await runStateOperation(['recover-notifications', 'server', '--compatible'], {
    ...process.env, OURS_PREVIOUS_BUILD_ROOT: join(root, 'previous'), OURS_EXPECTED_BUILD_ROOT: join(root, 'target'), OURS_RECOVERY_PHASE: evidence.phase,
  });
  console.log(JSON.stringify(result));
} finally { fs.rmSync(root, { recursive: true }); }
