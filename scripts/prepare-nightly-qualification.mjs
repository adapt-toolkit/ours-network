#!/usr/bin/env node
/**
 * CI-only: put this checkout into the nightly installer state that the nightly
 * publish job would produce, so the candidate can be qualified before merge.
 * It never commits, pushes or publishes.
 *
 * The production bump (bumpInstaller, including its branch/event guard) is
 * called unchanged. This wrapper applies its own stricter preconditions and
 * then hands the bump an explicit qualification environment: the target branch
 * is prerelease and the event is named as a qualification, not a pull request.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bumpInstaller, registryMetadata } from './bump-installer-version.mjs';

export const NIGHTLY_RELEASE_FILES = ['packages/installer/package.json', 'package-lock.json', 'releases/nightly.json'];

/** Only this repository's qualification job, for a change to or on prerelease, with no publish credential. */
export function qualificationEvent(env) {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.OURS_NIGHTLY_QUALIFICATION !== '1') {
    throw new Error('Nightly candidate qualification runs only in its GitHub Actions job');
  }
  for (const name of ['NODE_AUTH_TOKEN', 'NPM_TOKEN']) {
    if (env[name]) throw new Error(`Refusing nightly qualification with ${name} set; qualification never publishes`);
  }
  if (env.GITHUB_EVENT_NAME === 'pull_request' && env.GITHUB_BASE_REF === 'prerelease') return 'pull_request';
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/prerelease') return 'push';
  throw new Error(`Refusing nightly qualification for event ${env.GITHUB_EVENT_NAME ?? 'local'} on ${env.GITHUB_BASE_REF || env.GITHUB_REF || 'no ref'}`);
}

/** Tracked paths changed in the work tree, from NUL-separated porcelain v1 records. */
function changedPaths(status) {
  const paths = [];
  const records = status.split('\0').filter(Boolean);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    paths.push(record.slice(3));
    // A rename or copy record is followed by its source path.
    if (/^[RC]/.test(record)) paths.push(records[++i]);
  }
  return paths.sort();
}

export async function prepareNightlyQualification({ root = process.cwd(), env = process.env, git, readRegistry = registryMetadata } = {}) {
  qualificationEvent(env);
  git ??= args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const status = () => git(['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  const head = () => git(['rev-parse', 'HEAD']).trim();
  if (changedPaths(status()).length) throw new Error('Nightly qualification requires an unmodified checkout');
  const before = head();
  const qualificationEnv = { ...env, GITHUB_REF_NAME: 'prerelease', GITHUB_EVENT_NAME: 'nightly-qualification' };
  // No step outputs: nothing downstream may mistake this for a publish bump.
  delete qualificationEnv.GITHUB_OUTPUT;
  const result = await bumpInstaller({ mode: 'nightly', commit: false, root, env: qualificationEnv, git: args => git(args).trim(), readRegistry });
  if (head() !== before) throw new Error('Nightly qualification must not create commits');
  const changed = changedPaths(status());
  if (JSON.stringify(changed) !== JSON.stringify([...NIGHTLY_RELEASE_FILES].sort())) {
    throw new Error(`Nightly qualification changed unexpected paths: ${changed.join(', ') || '(none)'}`);
  }
  if (result.bumped !== true || !/^\d+\.\d+\.\d+-nightly\.\d+$/.test(result.version)) throw new Error('Nightly qualification did not produce a nightly candidate');
  return { version: result.version, head: before };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 2) throw new Error('Usage: prepare-nightly-qualification.mjs');
  prepareNightlyQualification()
    .then(({ version, head }) => console.log(`Prepared nightly installer candidate ${version} on ${head} for qualification; not committed, not published.`))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
