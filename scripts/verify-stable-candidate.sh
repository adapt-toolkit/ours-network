#!/usr/bin/env bash
# Verify the committed releases/stable.json as the stable installer the main bump
# will publish, before that bump exists:
#
#   scripts/verify-stable-candidate.sh 2.0.0
#
# The release gates choose their channel from packages/installer/package.json, so
# on prerelease-derived branches they only ever check releases/nightly.json. This
# script copies HEAD into a temporary git worktree, applies exactly the edits the
# main bump makes (installer package and workspace lock version, stable.json
# installerVersion), and runs the stable registry, test and pack gates there.
# The checkout itself is never modified. Docker gates run with OURS_TEST_DOCKER=1.
set -euo pipefail
version="${1:?usage: verify-stable-candidate.sh <installer-version>}"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "not a stable version: $version" >&2; exit 1; }
repo=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
cleanup() { git -C "$repo" worktree remove --force "$work/tree" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
git -C "$repo" worktree add --detach "$work/tree" HEAD >/dev/null
cd "$work/tree"
node --input-type=module - "$version" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { validateRelease } from './scripts/release-manifest.mjs';
const version = process.argv[2];
const edit = (path, fn) => { const value = JSON.parse(readFileSync(path)); fn(value); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
const stable = JSON.parse(readFileSync('releases/stable.json'));
validateRelease({ ...stable, installerVersion: version }, version);
edit('packages/installer/package.json', p => { p.version = version; });
edit('package-lock.json', l => { l.packages['packages/installer'].version = version; });
edit('releases/stable.json', r => { r.installerVersion = version; });
console.log(`stable candidate ${version}: ${Object.entries(stable.packages).map(([n, p]) => `${n}@${p.version}`).join(', ')}`);
JS
npm ci --no-audit --no-fund
npm run test:release
npm test
node scripts/verify-release.mjs --installed --require-all-capabilities
npm pack --workspace @ours.network/install --pack-destination "$work" --json > "$work/pack.json"
node --input-type=module - "$work" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const work = process.argv[2];
const [packed] = JSON.parse(fs.readFileSync(path.join(work, 'pack.json')));
const read = file => execFileSync('tar', ['-xOf', path.join(work, packed.filename), `package/${file}`], { encoding: 'utf8' });
const release = JSON.parse(fs.readFileSync('releases/stable.json'));
assert.equal(release.channel, 'stable');
assert.equal(packed.version, release.installerVersion);
assert.deepEqual(JSON.parse(read('assets/release.json')), release);
assert.deepEqual(JSON.parse(read('assets/sources.json')), {
  release,
  packages: Object.fromEntries(Object.entries(release.packages).map(([name, p]) => [name, { type: 'npm', version: p.version }])),
});
console.log(`Verified stable installer archive ${packed.name}@${packed.version}`);
JS
if [[ "${OURS_TEST_DOCKER:-}" == 1 ]]; then
  node scripts/verify-human-setup-e2e.mjs
  node --test packages/installer/test/gateway-docker.test.mjs
  node --test packages/installer/test/notifications-recovery-docker.test.mjs
  node scripts/verify-docker-runtime-permissions.mjs
  node scripts/verify-legacy-runtime.mjs
fi
echo "stable candidate $version verified"
