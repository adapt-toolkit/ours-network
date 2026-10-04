#!/usr/bin/env node
// Select one published component release in the channel manifest:
//
//   node scripts/select-release-package.mjs @ours.network/fleet 1.2.0-nightly.45
//
// The integrity is read from the registry for that exact published version and
// checked against the archive the registry serves; nothing is computed from a
// local build and nothing is written when either lookup fails. The embedded
// source policy is regenerated from the manifest, and installer prose naming the
// previous version is updated. Run `node scripts/verify-release.mjs --installed`
// afterwards: it downloads the whole set and checks the actual dependency graph
// and the capabilities this installer invokes.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateRelease } from './release-manifest.mjs';
import { assertArchiveCapabilities } from './release-capabilities.mjs';

const [name, version] = process.argv.slice(2);
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('packages/installer/package.json', root)));
const channel = pkg.version.includes('-nightly.') ? 'nightly' : 'stable';
const manifestUrl = new URL(`releases/${channel}.json`, root);
const manifest = validateRelease(JSON.parse(readFileSync(manifestUrl)), pkg.version);
if (!name || !version || process.argv.length !== 4) throw new Error('Usage: select-release-package.mjs <package> <exact-version>');
if (!Object.hasOwn(manifest.packages, name)) throw new Error(`${name} is not a component of the ${channel} release`);

const dir = mkdtempSync(join(tmpdir(), 'ours-release-select-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OURS_') && !key.toLowerCase().startsWith('npm_config_')));
Object.assign(env, { HOME: dir, NPM_CONFIG_USERCONFIG: join(dir, '.npmrc'), NPM_CONFIG_CACHE: join(dir, 'cache') });
const npm = args => execFileSync('npm', [...args, '--registry=https://registry.npmjs.org'], { cwd: dir, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
try {
  const published = JSON.parse(npm(['view', `${name}@${version}`, 'dist.integrity', '--json']) || 'null');
  if (typeof published !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(published))
    throw new Error(`${name}@${version} is not published with a SHA-512 integrity; publish it first`);
  const [packed] = JSON.parse(npm(['pack', `${name}@${version}`, '--ignore-scripts', '--json']));
  if (packed.name !== name || packed.version !== version) throw new Error(`Registry package identity mismatch: ${name}`);
  const actual = `sha512-${createHash('sha512').update(readFileSync(join(dir, packed.filename))).digest('base64')}`;
  if (actual !== published) throw new Error(`Registry archive for ${name}@${version} does not match its published integrity`);
  // A newly selected release must carry everything this installer offers: selecting is how a step gets delivered.
  assertArchiveCapabilities(name, version, join(dir, packed.filename), { strict: true });

  const previous = manifest.packages[name].version;
  const next = structuredClone(manifest);
  next.packages[name] = { version, integrity: published };
  if (next.hostCli && Object.hasOwn(next.hostCli, name)) next.hostCli[name] = { version, integrity: published };
  validateRelease(next, pkg.version);
  writeFileSync(manifestUrl, `${JSON.stringify(next, null, 2)}\n`);
  const policy = { release: next, packages: Object.fromEntries(Object.entries(next.packages).map(([key, value]) => [key, { type: 'npm', version: value.version }])) };
  writeFileSync(new URL('packages/installer/assets/sources.json', root), `${JSON.stringify(policy, null, 2)}\n`);
  const readmeUrl = new URL('packages/installer/README.md', root);
  const label = name.split('/')[1];
  const readme = readFileSync(readmeUrl, 'utf8');
  const title = label[0].toUpperCase() + label.slice(1);
  const updated = readme.replaceAll(`${title} \`${previous}\``, `${title} \`${version}\``);
  if (updated !== readme) writeFileSync(readmeUrl, updated);
  console.log(`Selected ${name}@${version} (${published}) in releases/${channel}.json and the embedded source policy; was ${previous}.`);
  console.log('Next: node scripts/verify-release.mjs --installed && npm run test:release && npm test');
} finally { rmSync(dir, { recursive: true, force: true }); }
