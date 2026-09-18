/** Enforce the selected ours artifacts; this is not third-party lock replay. */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const names = ['sdk', 'cli', 'tg-connector', 'cowork', 'messenger-server', 'fleet', 'mcp', 'codex', 'claude-code'].map(name => '@ours.network/' + name);
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const nightly = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.(0|[1-9]\d*)(?:\.[0-9a-f]{7,40})?$/;
const fail = message => { throw new Error(`Release graph refused: ${message}`); };
function file(path) {
  if (!lstatSync(path).isFile() || realpathSync(path) !== path) fail(`non-regular or linked file: ${path}`);
  return readFileSync(path);
}
const json = path => JSON.parse(file(path));

export function releaseBinding(policy) {
  // Only an absent binding denotes explicit development/retained legacy inputs.
  if (!Object.hasOwn(policy ?? {}, 'release')) return null;
  const release = policy.release;
  if (release?.schema !== 1 || !['stable', 'nightly'].includes(release.channel)) fail('invalid release binding');
  const pattern = release.channel === 'nightly' ? nightly : stable;
  if (typeof release.installerVersion !== 'string' || !pattern.test(release.installerVersion)) fail('invalid installer version/channel');
  if (!release.packages || JSON.stringify(Object.keys(release.packages).sort()) !== JSON.stringify([...names].sort())) fail('release must select exactly nine ours packages');
  for (const [name, entry] of Object.entries(release.packages)) {
    if (typeof entry?.version !== 'string' || !pattern.test(entry.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? '')) fail(`invalid release artifact: ${name}`);
  }
  if (!policy.packages || !Object.keys(policy.packages).length) fail('missing release source selection');
  for (const [name, entry] of Object.entries(policy.packages)) {
    if (entry?.type !== 'npm' || entry.version !== release.packages[name]?.version || Object.keys(entry).sort().join(',') !== 'type,version') fail(`source selection differs from release: ${name}`);
  }
  return release;
}

export function verifyReleaseGraph(root, policy, { requiredPackages = Object.keys(policy?.packages ?? {}) } = {}) {
  const release = releaseBinding(policy);
  if (!release) return { verified: false, reason: 'development or retained legacy source selection' };
  root = resolve(root);
  if (realpathSync(root) !== root) fail('build root is not canonical');
  const manifest = json(join(root, 'package.json'));
  if (manifest.name?.startsWith('@ours.network/') && manifest.version !== release.packages[manifest.name]?.version) fail(`root package differs from release: ${manifest.name}`);
  const locks = ['package-lock.json', 'node_modules/.package-lock.json'].map(path => {
    const lock = json(join(root, path));
    if (lock.lockfileVersion !== 3 || !lock.packages || Array.isArray(lock.packages)) fail(`invalid lock: ${path}`);
    const entries = new Map();
    for (const [location, entry] of Object.entries(lock.packages)) {
      const match = location.match(/(?:^|\/)node_modules\/(@ours\.network\/[^/]+)$/);
      if (!match) continue;
      const name = match[1], expected = release.packages[name];
      if (!expected || entry?.link || entry.version !== expected.version || entry.integrity !== expected.integrity) fail(`version/integrity mismatch: ${path}:${location}`);
      const installed = resolve(root, location), rel = relative(root, installed);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail(`escaping lock location: ${location}`);
      if (typeof entry.resolved !== 'string') fail(`missing artifact location: ${location}`);
      if (entry.resolved.startsWith('file:')) {
        const archive = resolve(root, entry.resolved.slice(5));
        const archiveRel = relative(root, archive);
        if (archiveRel.startsWith('..') || isAbsolute(archiveRel) || !archive.endsWith('.tgz')) fail(`unbound local artifact: ${location}`);
        const integrity = 'sha512-' + createHash('sha512').update(file(archive)).digest('base64');
        if (integrity !== expected.integrity) fail(`vendor bytes differ from release: ${location}`);
      } else if (!entry.resolved.startsWith(`https://registry.npmjs.org/${name}/-/`)) fail(`non-official artifact: ${location}`);
      entries.set(location, { name, entry, installed });
    }
    return entries;
  });
  const [declared, installed] = locks;
  const direct = Object.entries(manifest.dependencies ?? {}).filter(([name]) => name.startsWith('@ours.network/'));
  if (!manifest.name?.startsWith('@ours.network/') && JSON.stringify(direct.map(([name]) => name).sort()) !== JSON.stringify([...requiredPackages].sort())) fail('direct package set differs from release source selection');
  for (const [name, spec] of direct) {
    const expected = release.packages[name], locked = declared.get(`node_modules/${name}`)?.entry;
    if (!expected || (spec !== expected.version && !(typeof spec === 'string' && spec.startsWith('file:') && spec === locked?.resolved))) fail(`direct package spec differs from release: ${name}`);
  }
  for (const name of Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@ours.network/'))) {
    if (!declared.has(`node_modules/${name}`) || !installed.has(`node_modules/${name}`)) fail(`missing direct release package: ${name}`);
  }
  for (const [location, value] of declared) {
    // npm's root lock retains dev-only entries omitted from a production install.
    if (!installed.has(location) && !value.entry.dev && !value.entry.optional) fail(`installed release entry missing: ${location}`);
  }
  for (const [location, value] of installed) {
    const expected = declared.get(location);
    if (!expected || expected.entry.version !== value.entry.version || expected.entry.integrity !== value.entry.integrity || expected.entry.resolved !== value.entry.resolved) fail(`installed/root lock mismatch: ${location}`);
    if (!lstatSync(value.installed).isDirectory() || realpathSync(value.installed) !== value.installed) fail(`linked installed package: ${location}`);
    const actual = json(join(value.installed, 'package.json'));
    if (actual.name !== value.name || actual.version !== value.entry.version) fail(`installed package differs from release: ${location}`);
  }
  return { verified: true, packages: installed.size };
}

export function verifyRuntimeRelease(root) {
  const path = join(resolve(root), 'sources.json');
  // Historic installations predate sources/release bindings; their existing
  // provenance and conversion checks remain authoritative until explicit update.
  if (!existsSync(path)) return { verified: false, reason: 'legacy runtime without sources' };
  return verifyReleaseGraph(root, json(path));
}
