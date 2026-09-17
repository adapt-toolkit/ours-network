/** Acquire selected packages, build Git sources once, write the final manifest. */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SOURCE_ROOT, CONFIG, OUT, ROOT, SELECTED, archive, manifest, run, capture, inheritedLock } from './build-common.mjs';
const recipes = ['sdk', 'telegram', 'cowork', 'messenger', 'fleet', 'mcp'];
const packages = Object.fromEntries([...SELECTED].map(name => [name, CONFIG.packages[name]]));
for (const [name, selection] of Object.entries(packages)) {
  const keys = Object.keys(selection || {}).sort().join(',');
  if (keys === 'source') {
    const source = selection.source;
    if (!recipes.includes(source)) throw Error(`Unknown source recipe: ${source}`);
    const spec = CONFIG.sources[source];
    if (spec?.type !== 'git' || !/^[0-9a-f]{40}$/.test(spec.commit)) throw Error(`${source}: expected Git URL and full commit SHA`);
  } else if (keys === 'type,version' && selection.type === 'npm') {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(selection.version)) throw Error(`${name}: expected exact npm version`);
  } else throw Error(`${name}: select a Git source or exact npm version`);
}
mkdirSync(OUT, { recursive: true });
for (const [name, selection] of Object.entries(packages)) {
  if (selection.type !== 'npm') continue;
  const result = JSON.parse(capture(['npm', 'pack', name + '@' + selection.version, '--ignore-scripts', '--json', '--pack-destination', OUT], ROOT))[0];
  renameSync(join(OUT, result.filename), archive(name));
}
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
if (existsSync('/run/secrets/github_token')) Object.assign(env, {
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '!f() { printf "username=x-access-token\\npassword="; cat /run/secrets/github_token; printf "\\n"; }; f',
});
for (const source of recipes) {
  if (!Object.values(packages).some(item => item.source === source)) continue;
  const spec = CONFIG.sources[source], directory = join(SOURCE_ROOT, source);
  mkdirSync(directory, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: directory, env, stdio: ['inherit', 'inherit', 'inherit', ...inheritedLock] });
  git('init', '-q'); git('remote', 'add', 'origin', spec.url);
  git('fetch', 'origin', spec.commit); git('checkout', '--detach', 'FETCH_HEAD');
  if (capture(['git', 'rev-parse', 'HEAD'], directory).trim() !== spec.commit) throw Error(`${source}: checkout does not match selected commit`);
  git('submodule', 'update', '--init', '--recursive', '--depth=1');
  run([process.execPath, fileURLToPath(new URL(`build-${source}.mjs`, import.meta.url))], ROOT);
}
for (const [name, selection] of Object.entries(packages)) {
  const packed = manifest(archive(name));
  if (packed.name !== name || (selection.type === 'npm' && packed.version !== selection.version)) throw Error(`Packed output does not match selection: ${name}`);
}
writeFileSync(join(ROOT, 'package.json'), JSON.stringify({
  name: 'ours-container-runtime', version: '0.1.0', private: true,
  dependencies: Object.fromEntries(Object.keys(packages).map(name => [name, 'file:' + relative(ROOT, archive(name))])),
}, null, 2) + '\n');
