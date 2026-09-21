import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Native callers provide an exact selected executable. Compose mounts the
// selected runtime and supplies its bin directory, including retained releases.
export function daemonOwner(env = process.env) {
  if (env.OURS_CLI_PATH) return env.OURS_CLI_PATH;
  const bin = env.OURS_DAEMON_BIN_DIR;
  if (!bin) throw new Error('daemon maintenance requires its selected executable or bin directory');
  const daemon = join(bin, 'ours-daemon');
  if (existsSync(daemon)) return daemon;
  const legacy = join(bin, 'ours');
  if (existsSync(legacy)) return legacy;
  throw new Error('selected runtime contains no daemon administrator');
}
