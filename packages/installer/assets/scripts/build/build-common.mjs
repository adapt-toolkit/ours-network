/** Shared npm operations for the six fixed repository recipes. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const ROOT = resolve(process.env.OURS_BUILD_ROOT || '/opt/ours');
export const SOURCE_ROOT = resolve(process.env.OURS_SOURCE_ROOT || '/src');
export const OUT = join(ROOT, 'docker/vendor');
export const CONFIG = JSON.parse(readFileSync(join(ROOT, 'sources.json'), 'utf8'));
export const SELECTED = new Set((process.env.OURS_BUILD_PACKAGES || 'sdk,cli,daemon,tg-connector,cowork,messenger-server').split(',').map(name => '@ours.network/' + name));
export const inheritedLock = process.env.OURS_INSTALLER_LOCK_FD === '3' ? [3] : [];
export const run = (args, cwd) => execFileSync(args[0], args.slice(1), { cwd, stdio: ['inherit', 'inherit', 'inherit', ...inheritedLock] });
export const capture = (args, cwd, env = process.env) => execFileSync(args[0], args.slice(1), { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit', ...inheritedLock] });
export const archive = packageName => join(OUT, `ours.network-${packageName.replace(/^@ours\.network\//, '')}.tgz`);
// npm already owns package archive interpretation; no second tar parser here.
export const manifest = path => JSON.parse(capture(['npm', 'pack', '--dry-run', '--ignore-scripts', '--json', path], ROOT))[0];
export function pack(cwd, packageName, source) {
  if (!SELECTED.has(packageName) || CONFIG.packages[packageName]?.source !== source) return;
  const result = JSON.parse(capture(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', OUT], cwd))[0];
  renameSync(join(OUT, result.filename), archive(packageName));
}
export function buildConsumer(source, packageName) {
  if (!SELECTED.has(packageName) || CONFIG.packages[packageName]?.source !== source) return;
  const directory = join(SOURCE_ROOT, source);
  const recipe = join(directory, 'scripts/build-selected.mjs');
  const sdk = archive('@ours.network/sdk'), cli = archive('@ours.network/cli');
  for (const input of [recipe, sdk, cli]) if (!existsSync(input)) throw Error(`${packageName}: required build input missing: ${input}`);
  mkdirSync(OUT, { recursive: true });
  const output = mkdtempSync(join(OUT, source + '-'));
  try {
    const result = JSON.parse(capture([process.execPath, recipe, '--sdk', sdk, '--cli', cli, '--out-dir', output], directory));
    if (typeof result.filename !== 'string' || basename(result.filename) !== result.filename) throw Error(`${packageName}: recipe must return an archive filename`);
    const packed = join(output, result.filename);
    if (manifest(packed).name !== packageName) throw Error(`Packed output does not match selection: ${packageName}`);
    renameSync(packed, archive(packageName));
  } finally { rmSync(output, { recursive: true, force: true }); }
}
