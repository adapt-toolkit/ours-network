// `ours-install update [--nightly]`: run the newest published installer.
//
// A launcher only. The selected release is started with no arguments, so the
// child shows its normal setup (which offers Update for an existing
// installation) and never sees `update` again — no recursion. Everything else
// that starts with `update` keeps its existing preset meaning.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const INSTALLER_PACKAGE = '@ours.network/install';

/** The npm tag for `update` / `update --nightly`; null for every other argv. */
export function selfUpdateTag(argv) {
  if (argv.length === 1 && argv[0] === 'update') return 'latest';
  if (argv.length === 2 && argv[0] === 'update' && argv[1] === '--nightly') return 'nightly';
  return null;
}

/**
 * Prefer `npx --yes <pkg>@<tag>`; npx resolves a tag against the registry, so
 * a cached older release is not reused. Without npx, `npm i -g` the selected tag
 * and start the global bin it just wrote by its absolute path, never a PATH
 * lookup that could select an older copy. Returns the exit status to use.
 */
export function runSelfUpdate(tag, { env = process.env, spawn = spawnSync, err = line => process.stderr.write(`${line}\n`), kill = signal => process.kill(process.pid, signal) } = {}) {
  const spec = `${INSTALLER_PACKAGE}@${tag}`;
  const npm = env.OURS_NPM?.trim() || 'npm';
  const available = cmd => { const r = spawn(cmd, ['--version'], { stdio: 'ignore', env, timeout: 15_000 }); return !r.error && r.status === 0; };
  const interactive = (cmd, args) => {
    const r = spawn(cmd, args, { stdio: 'inherit', env });
    if (r.error) { err(`ours-install: could not start ${cmd}: ${r.error.message}`); return 1; }
    if (r.signal) { kill(r.signal); return 1; }
    return r.status ?? 1;
  };
  if (available('npx')) return interactive('npx', ['--yes', spec]);
  if (!available(npm)) {
    err(`ours-install: update needs npx or npm on PATH. Install Node.js with npm, then run: npx --yes ${spec}`);
    return 1;
  }
  const installed = interactive(npm, ['i', '-g', spec]);
  if (installed !== 0) return installed;
  const prefix = spawn(npm, ['prefix', '--global'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env });
  const dir = prefix.status === 0 ? prefix.stdout.trim() : '';
  if (!dir.startsWith('/')) { err(`ours-install: installed ${spec} but could not find the npm global prefix; run ours-install from a new shell`); return 1; }
  return interactive(join(dir, 'bin', 'ours-install'), []);
}
