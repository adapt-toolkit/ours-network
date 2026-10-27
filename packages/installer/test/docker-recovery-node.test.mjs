import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshDockerRecovery, securedNodeStages, PATCHED_NODE_IMAGE } from '../lib/docker-recovery.mjs';

// Retained Dockerfiles are byte copies of earlier assets/Dockerfile revisions (named by commit).
const historical = new URL('./fixtures/retained-dockerfiles/', import.meta.url);
const revisions = readdirSync(historical).filter(name => name.endsWith('.Dockerfile')).sort();
const current = readFileSync(new URL('../assets/Dockerfile', import.meta.url), 'utf8');
const RECOVER = 'COPY --chmod=644 scripts/runtime/recover.mjs scripts/runtime/dependency-ready.mjs /opt/ours/docker/';
const PREFIX = 'COPY --chmod=644 scripts/runtime/daemon-client-prefix.mjs /opt/ours/docker/daemon-client-prefix.mjs';
const nodeStages = text => [...text.matchAll(/^FROM (node:\S+)/gm)].map(match => match[1]);

function retained(t, dockerfile, product) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ours-retained-docker-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workDir = join(root, 'work');
  mkdirSync(join(workDir, 'scripts/runtime'), { recursive: true, mode: 0o700 });
  writeFileSync(join(workDir, 'Dockerfile'), dockerfile, { mode: 0o600 });
  const record = { root, workDir, ...(product ? { product } : {}) };
  return { record, read: () => readFileSync(join(workDir, 'Dockerfile'), 'utf8'), marker: join(workDir, '.recovery-rebuild') };
}

test('fixtures cover historical retained Dockerfiles with and without recovery lines', () => {
  assert.ok(revisions.length >= 4);
  const texts = revisions.map(name => readFileSync(new URL(name, historical), 'utf8'));
  assert.ok(texts.some(text => !text.includes('scripts/runtime/recover.mjs')));
  assert.ok(texts.some(text => text.includes('scripts/runtime/recover.mjs') && !text.includes(PREFIX)));
  for (const text of texts) assert.deepEqual(nodeStages(text), ['node:24', 'node:24', 'node:24']);
});

test('the shipped Dockerfile pins every Node stage to the patched image', () => {
  assert.deepEqual(nodeStages(current), [PATCHED_NODE_IMAGE, PATCHED_NODE_IMAGE, PATCHED_NODE_IMAGE]);
  assert.equal(securedNodeStages(current), current);
});

for (const name of revisions) for (const product of [undefined, 'plugin-only']) {
  test(`retained ${name} (${product ?? 'workspace'}) is pinned, completed and idempotent`, t => {
    const original = readFileSync(new URL(name, historical), 'utf8');
    const fixture = retained(t, original, product);
    assert.equal(refreshDockerRecovery(fixture.record), true);
    const migrated = fixture.read();
    assert.deepEqual(nodeStages(migrated), [PATCHED_NODE_IMAGE, PATCHED_NODE_IMAGE, PATCHED_NODE_IMAGE]);
    assert.doesNotMatch(migrated, /^FROM node:24 /m);
    assert.equal(migrated.split('\n').filter(line => line === RECOVER).length, original.includes('scripts/runtime/recover.mjs') ? 0 : 1);
    assert.ok(migrated.includes('scripts/runtime/recover.mjs'));
    assert.equal(migrated.includes(PREFIX), product === 'plugin-only' || original.includes(PREFIX));
    // Recovery lines stay in the build stage, before the maintenance stage begins.
    assert.ok(migrated.indexOf('scripts/runtime/recover.mjs') < migrated.indexOf(`FROM ${PATCHED_NODE_IMAGE} AS maintenance`));
    // Only the base image lines and the inserted recovery lines differ from the retained file.
    const changed = migrated.split('\n').filter(line => !original.split('\n').includes(line));
    for (const line of changed) assert.ok(line.startsWith(`FROM ${PATCHED_NODE_IMAGE} AS `) || line === RECOVER || line === PREFIX, line);
    // A rebuild is required until the caller consumes the marker; a second pass changes nothing.
    rmSync(fixture.marker);
    assert.equal(refreshDockerRecovery(fixture.record), false);
    assert.equal(fixture.read(), migrated);
  });
}

test('already patched exact releases are kept, including newer patches and other supported lines', t => {
  const text = current
    .replace(`FROM ${PATCHED_NODE_IMAGE} AS toolchain`, 'FROM node:24.23.0 AS toolchain')
    .replace(`FROM ${PATCHED_NODE_IMAGE} AS maintenance`, 'FROM node:26.12.1 AS maintenance')
    .split('\n').filter(line => !line.includes('scripts/runtime/recover.mjs')).join('\n');
  const fixture = retained(t, text);
  refreshDockerRecovery(fixture.record);
  const migrated = fixture.read();
  assert.deepEqual(nodeStages(migrated), ['node:24.23.0', 'node:26.12.1', PATCHED_NODE_IMAGE]);
  // The recovery line is inserted before a maintenance stage that uses a different patched tag.
  assert.match(migrated, new RegExp(`${RECOVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\nFROM node:26\\.12\\.1 AS maintenance`));
});

for (const [tag, replacement] of [
  ['24', PATCHED_NODE_IMAGE], ['24.21', PATCHED_NODE_IMAGE], ['24.21.0', PATCHED_NODE_IMAGE], ['24.22.0', PATCHED_NODE_IMAGE],
  ['22', PATCHED_NODE_IMAGE], ['22.23.3', PATCHED_NODE_IMAGE], ['26.12.0', PATCHED_NODE_IMAGE], ['lts', PATCHED_NODE_IMAGE],
  ['24@sha256:' + '0'.repeat(64), PATCHED_NODE_IMAGE], ['24.21.0@sha256:' + '0'.repeat(64), PATCHED_NODE_IMAGE],
  // A replaced tag keeps its variant, so the base distribution does not change.
  ['24-bookworm', `${PATCHED_NODE_IMAGE}-bookworm`], ['24-bookworm-slim', `${PATCHED_NODE_IMAGE}-bookworm-slim`],
  ['22.23.3-alpine3.22', `${PATCHED_NODE_IMAGE}-alpine3.22`],
  // Prerelease or unknown suffixes are not image variants: they get the plain patched image.
  ['27.0.0-pre', PATCHED_NODE_IMAGE], ['24-custom', PATCHED_NODE_IMAGE],
]) {
  test(`retained node:${tag} stages are replaced by node:${replacement.slice(5)}`, () => {
    const text = `FROM node:${tag} AS toolchain\nFROM toolchain AS build\nFROM node:${tag} AS maintenance\nFROM node:${tag} AS runtime\n`;
    assert.deepEqual(nodeStages(securedNodeStages(text)), [replacement, replacement, replacement]);
  });
}

for (const tag of ['24.22.1', '24.23.0', '26.13.0', '22.24.0', '24.22.1-bookworm', '24.23.0-bookworm-slim', '26.13.0-alpine',
  '24.23.0@sha256:' + 'a'.repeat(64), '26.13.0-bookworm@sha256:' + 'b'.repeat(64)]) {
  test(`already patched node:${tag.slice(0, 40)} stages are never downgraded`, () => {
    const text = `FROM node:${tag} AS toolchain\nFROM toolchain AS build\nFROM node:${tag} AS maintenance\nFROM node:${tag} AS runtime\n`;
    assert.equal(securedNodeStages(text), text);
  });
}

test('non-Node stages are not touched', () => {
  const text = 'FROM toolchain AS build\nFROM nginx:1.28-alpine AS gateway\nRUN echo FROM node:24 AS x\n';
  assert.equal(securedNodeStages(text), text);
});
