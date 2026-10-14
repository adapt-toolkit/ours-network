#!/usr/bin/env node
// Bind the complete stable component set in one step:
//
//   node scripts/bootstrap-stable-release.mjs @ours.network/sdk@4.0.0 @ours.network/cli@3.0.0 ...
//
// select-release-package.mjs edits one package of an already complete manifest in
// the channel of the current installer version, so it cannot create the first
// stable set while the installer is a nightly and releases/stable.json is empty.
// This script takes an exact published version for every component the nightly
// manifest selects (including the optional daemon), reads each registry
// integrity, checks it against the archive the registry serves and the
// installer's required capabilities, and writes releases/stable.json with
// hostCli = the selected SDK and CLI. installerVersion stays null: the main
// version bump binds it. Nothing is written unless every component passes.
// Then run scripts/verify-stable-candidate.sh <installer-version>.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateRelease } from './release-manifest.mjs';
import { assertArchiveCapabilities } from './release-capabilities.mjs';

const root = new URL('../', import.meta.url);
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSelections(args, names) {
  const selected = {};
  for (const arg of args) {
    const at = arg.lastIndexOf('@');
    const [name, version] = at > 0 ? [arg.slice(0, at), arg.slice(at + 1)] : [arg, ''];
    if (!names.includes(name)) throw new Error(`${name} is not a component of the release`);
    if (!STABLE.test(version)) throw new Error(`${name} needs an exact stable version, got '${version}'`);
    if (Object.hasOwn(selected, name)) throw new Error(`${name} selected twice`);
    selected[name] = version;
  }
  const missing = names.filter(name => !Object.hasOwn(selected, name));
  if (missing.length) throw new Error(`Missing stable selections: ${missing.join(', ')}`);
  return selected;
}

export function stableManifest(selected) {
  const packages = Object.fromEntries(Object.entries(selected).map(([name, p]) => [name, { ...p }]));
  const manifest = {
    schema: 1,
    channel: 'stable',
    installerVersion: null,
    packages,
    hostCli: { '@ours.network/sdk': { ...packages['@ours.network/sdk'] }, '@ours.network/cli': { ...packages['@ours.network/cli'] } },
  };
  // Validate everything except the installer binding, which the main bump owns.
  validateRelease({ ...manifest, installerVersion: '0.0.0' }, '0.0.0');
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const nightly = JSON.parse(readFileSync(new URL('releases/nightly.json', root)));
  const names = Object.keys(nightly.packages);
  const selected = parseSelections(process.argv.slice(2), names);
  const dir = mkdtempSync(join(tmpdir(), 'ours-release-stable-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OURS_') && !key.toLowerCase().startsWith('npm_config_')));
  Object.assign(env, { HOME: dir, NPM_CONFIG_USERCONFIG: join(dir, '.npmrc'), NPM_CONFIG_CACHE: join(dir, 'cache') });
  const npm = args => execFileSync('npm', [...args, '--registry=https://registry.npmjs.org'], { cwd: dir, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  try {
    const bound = {};
    for (const [name, version] of Object.entries(selected)) {
      let published = null;
      try { published = JSON.parse(npm(['view', `${name}@${version}`, 'dist.integrity', '--json']) || 'null'); }
      catch { /* npm view fails for an unpublished version */ }
      if (typeof published !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(published))
        throw new Error(`${name}@${version} is not published with a SHA-512 integrity; publish it first`);
      const [packed] = JSON.parse(npm(['pack', `${name}@${version}`, '--ignore-scripts', '--json']));
      if (packed.name !== name || packed.version !== version) throw new Error(`Registry package identity mismatch: ${name}`);
      const actual = `sha512-${createHash('sha512').update(readFileSync(join(dir, packed.filename))).digest('base64')}`;
      if (actual !== published) throw new Error(`Registry archive for ${name}@${version} does not match its published integrity`);
      assertArchiveCapabilities(name, version, join(dir, packed.filename), { strict: true });
      bound[name] = { version, integrity: published };
      console.log(`verified ${name}@${version} ${published}`);
    }
    const manifest = stableManifest(bound);
    writeFileSync(new URL('releases/stable.json', root), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote releases/stable.json with ${Object.keys(bound).length} stable components; installerVersion is bound by the main bump.`);
    console.log('Next: scripts/verify-stable-candidate.sh <expected-installer-version>');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
