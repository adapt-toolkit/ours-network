#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateRelease } from './release-manifest.mjs';

const REGISTRY = 'https://registry.npmjs.org/@ours.network%2finstall';
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LOCAL = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.(0|[1-9]\d*))?$/;

export function commitLevel(message) {
  if (/\[(?:skip ci|ci skip)\]/i.test(message)) return null;
  const [subject] = message.split('\n');
  if (/^[a-z]+(?:\([^)]*\))?!:/.test(subject) || /^BREAKING CHANGE:/m.test(message)) return 'major';
  const type = /^([a-z]+)(?:\([^)]*\))?:/.exec(subject)?.[1];
  if (['docs', 'ci', 'test', 'chore'].includes(type)) return null;
  return type === 'feat' ? 'minor' : 'patch';
}

export function introducedCommitLevel({ before, after, head, git }) {
  const fullSha = /^[a-f0-9]{40}$/i;
  if (![before, after].every(sha => typeof sha === 'string' && fullSha.test(sha) && !/^0+$/.test(sha))) {
    throw new Error('Stable bump requires explicit nonzero BEFORE_SHA and GITHUB_SHA commit endpoints');
  }
  for (const sha of [before, after]) {
    let resolved;
    try { resolved = git(['rev-parse', '--verify', `${sha}^{commit}`]); }
    catch (cause) { throw new Error(`Unavailable introduced-range commit: ${sha}`, { cause }); }
    if (resolved.toLowerCase() !== sha.toLowerCase()) throw new Error(`Range endpoint is not a commit: ${sha}`);
  }
  if (after.toLowerCase() !== head.toLowerCase()) throw new Error('GITHUB_SHA must match checked-out HEAD');
  try { git(['merge-base', '--is-ancestor', before, after]); }
  catch (cause) { throw new Error('BEFORE_SHA must be an ancestor of GITHUB_SHA', { cause }); }
  // Merge subjects are bookkeeping; classify the introduced nonmerge commits.
  const messages = git(['log', '--no-merges', '--format=%B%x00', `${before}..${after}`])
    .split('\0').map(message => message.trim()).filter(Boolean);
  const levels = messages.map(commitLevel);
  return ['major', 'minor', 'patch'].find(level => levels.includes(level)) ?? null;
}

function numbers(version, pattern) {
  const match = pattern.exec(version);
  if (!match) throw new Error(`Invalid version: ${version}`);
  const result = match.slice(1, 4).map(Number);
  if (!result.every(Number.isSafeInteger)) throw new Error(`Unsafe version: ${version}`);
  return result;
}

export function nextVersion({ mode, localVersion, latest, versions, level = 'patch' }) {
  if (!['stable', 'nightly'].includes(mode)) throw new Error('Mode must be stable or nightly');
  const local = numbers(localVersion, LOCAL);
  const published = numbers(latest, STABLE);
  if (!Array.isArray(versions) || !versions.every(v => typeof v === 'string')) throw new Error('Invalid published versions');
  const difference = local.findIndex((v, i) => v !== published[i]);
  const base = difference < 0 || local[difference] > published[difference] ? local : published;
  const index = mode === 'nightly' ? 2 : { major: 0, minor: 1, patch: 2 }[level];
  if (index === undefined) throw new Error('Invalid bump level');
  base[index] += 1;
  for (let i = index + 1; i < 3; i++) base[i] = 0;
  if (!base.every(Number.isSafeInteger)) throw new Error('Version overflow');
  const core = base.join('.');
  if (mode === 'stable') {
    if (versions.includes(core)) throw new Error(`Stable candidate already published: ${core}`);
    return core;
  }
  const prefix = `${core}-nightly.`;
  const counters = [...versions, localVersion].filter(v => v.startsWith(prefix) && /^(0|[1-9]\d*)$/.test(v.slice(prefix.length))).map(v => Number(v.slice(prefix.length)));
  const counter = Math.max(0, ...counters) + 1;
  if (!Number.isSafeInteger(counter)) throw new Error('Nightly counter overflow');
  return `${prefix}${counter}`;
}

export async function registryMetadata(fetcher = fetch) {
  const response = await fetcher(REGISTRY, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Official registry request failed: HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.name !== '@ours.network/install' || !metadata.versions || typeof metadata.versions !== 'object' || Array.isArray(metadata.versions)) throw new Error('Invalid installer registry metadata');
  const latest = metadata['dist-tags']?.latest;
  numbers(latest, STABLE);
  if (!Object.hasOwn(metadata.versions, latest)) throw new Error('Registry latest missing from published versions');
  return { latest, versions: Object.keys(metadata.versions) };
}

export async function bumpInstaller({ mode, commit = false, root = process.cwd(), env = process.env, git, readRegistry = registryMetadata }) {
  if (!['stable', 'nightly'].includes(mode) || (commit && mode !== 'stable')) throw new Error('Use stable [--commit] or nightly; nightly never commits');
  git ??= args => execFileSync('git', args, { cwd: root, encoding: 'utf8', env }).trim();
  const branch = env.GITHUB_REF_NAME || git(['branch', '--show-current']);
  if (branch !== (mode === 'stable' ? 'main' : 'prerelease') || env.GITHUB_EVENT_NAME?.startsWith('pull_request')) throw new Error(`Refusing ${mode} version bump on branch/event ${branch}/${env.GITHUB_EVENT_NAME ?? 'local'}`);
  if (commit && git(['status', '--porcelain'])) throw new Error('Stable commit requires a clean working tree');
  const manifestPath = 'packages/installer/package.json';
  const releasePath = `releases/${mode}.json`;
  const paths = [manifestPath, 'package-lock.json', releasePath];
  const originals = paths.map(path => readFileSync(join(root, path)));
  const [pkg, lock, release] = originals.map(bytes => JSON.parse(bytes));
  if (pkg.name !== '@ours.network/install' || lock.packages?.['packages/installer']?.version !== pkg.version) throw new Error('Installer manifest and workspace lock disagree');
  const sha = git(['rev-parse', 'HEAD']);
  const emit = output => {
    for (const [key, value] of Object.entries(output)) {
      if (/\r|\n/.test(String(value))) throw new Error('Invalid output value');
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
    return output;
  };
  const level = mode === 'stable' ? introducedCommitLevel({ before: env.BEFORE_SHA, after: env.GITHUB_SHA, head: sha, git }) : 'patch';
  if (!level) return emit({ bumped: false, 'new-sha': sha, version: pkg.version });
  const metadata = await readRegistry();
  const version = nextVersion({ mode, localVersion: pkg.version, ...metadata, level });
  // Validate the complete preselected channel without changing any component pins.
  const candidate = { ...release, installerVersion: version };
  if (candidate.channel !== mode) throw new Error('Selected release manifest has the wrong channel');
  validateRelease(candidate, version);
  pkg.version = version;
  lock.packages['packages/installer'].version = version;
  const contents = [pkg, lock, candidate].map(value => JSON.stringify(value, null, 2) + '\n');
  try {
    paths.forEach((path, index) => writeFileSync(join(root, path), contents[index]));
  } catch (error) {
    paths.forEach((path, index) => writeFileSync(join(root, path), originals[index]));
    throw error;
  }
  let newSha = sha;
  if (commit) {
    git(['config', 'user.name', 'ours-ci-version-bump[bot]']);
    git(['config', 'user.email', 'ours-ci-version-bump[bot]@users.noreply.github.com']);
    git(['add', '--', ...paths]);
    git(['commit', '-m', `chore(release): @ours.network/install v${version} [skip ci]`]);
    newSha = git(['rev-parse', 'HEAD']);
    git(['push', 'origin', 'HEAD:refs/heads/main']);
  }
  return emit({ bumped: true, 'new-sha': newSha, version });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, ...flags] = process.argv.slice(2);
  if (flags.some(flag => flag !== '--commit') || flags.length > 1) throw new Error('Usage: bump-installer-version.mjs stable [--commit] | nightly');
  bumpInstaller({ mode, commit: flags.includes('--commit') }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
}
