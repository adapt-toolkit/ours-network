import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// Image composition is a packaging check, separate from behavioral E2E scenarios.
const manifest = JSON.parse(readFileSync('/opt/ours/package.json', 'utf8'));
const required = [
  '@ours.network/sdk', '@ours.network/cli', '@ours.network/fleet',
  '@ours.network/mcp', '@ours.network/codex', '@ours.network/claude-code',
  '@ours.network/hermes', '@ours.network/fleet-codex',
  '@ours.network/fleet-claude-code',
];
for (const name of required) {
  const version = manifest.dependencies?.[name];
  assert.ok(version, `${name} is missing from the client image manifest`);
  const installed = `/opt/ours/node_modules/${name}/package.json`;
  assert.ok(existsSync(installed), `${name} is missing from the client image`);
  assert.equal(JSON.parse(readFileSync(installed, 'utf8')).version, version,
    `${name} does not match its pinned image version`);
}
assert.equal(manifest.dependencies?.['@ours.network/daemon'], undefined,
  'The client image must not depend directly on the daemon');
console.log(`Client image package check passed (${required.length} pinned packages)`);
