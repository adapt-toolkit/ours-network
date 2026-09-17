/** Finalize freshly installed runtime records; never migrate historic builds here. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createBuildContext, CONTEXT } from '../maintenance/build-context.mjs';
export function finalizeBuild(root) {
  if (fs.realpathSync(root) !== root) throw new Error('Build root must be canonical');
  try { fs.lstatSync(join(root, CONTEXT)); throw new Error('Existing context cannot be regenerated'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const protect = (path, directory = false) => {
    const st = fs.lstatSync(path);
    if (!(directory ? st.isDirectory() : st.isFile()) || st.uid !== process.getuid() || (!directory && st.nlink !== 1) || fs.realpathSync(path) !== path) throw new Error('Unsafe owned build input: ' + path);
    fs.chmodSync(path, directory ? 0o700 : 0o600);
  };
  for (const path of [root, join(root, 'docker'), join(root, 'docker/vendor')]) protect(path, true);
  for (const name of ['package.json', 'package-lock.json']) protect(join(root, name));
  const manifest = JSON.parse(fs.readFileSync(join(root, 'package.json')));
  for (const spec of Object.values(manifest.dependencies ?? {})) {
    if (typeof spec !== 'string' || !/^file:docker\/vendor\/ours\.network-[a-z-]+\.tgz$/.test(spec)) throw new Error('Unexpected installer vendor reference');
    protect(join(root, spec.slice(5)));
  }
  const tree = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  JSON.parse(tree);
  const path = join(root, 'dependency-tree.json');
  // Fresh finalization may not overwrite a retained tree or follow a symlink.
  fs.writeFileSync(path, tree, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(path, 0o600);
  return createBuildContext(root);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) finalizeBuild(resolve(process.env.OURS_BUILD_ROOT || '/opt/ours'));
