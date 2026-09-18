import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeMarketplace, buildCodexMarketplace, marketplaceJson, marketplacePaths,
  parseNpmVersion, validateChannelVersion,
} from '../lib/marketplace.mjs';

test('npm dist-tag output is one scalar exact version, never an array/object', () => {
  assert.equal(parseNpmVersion('"0.17.0"\n'), '0.17.0');
  assert.equal(parseNpmVersion('0.18.0-nightly.3\n'), '0.18.0-nightly.3');
  assert.equal(parseNpmVersion('["0.17.0"]'), '');
  assert.equal(parseNpmVersion('{"version":"0.17.0"}'), '');
  assert.equal(parseNpmVersion(''), '');
});

test('resolved versions must match the selected channel exactly', () => {
  assert.deepEqual(validateChannelVersion('0.17.0', 'latest'), {
    ok: true, version: '0.17.0', channel: 'latest',
  });
  assert.deepEqual(validateChannelVersion('0.18.0-nightly.3', 'nightly'), {
    ok: true, version: '0.18.0-nightly.3', channel: 'nightly',
  });
  assert.equal(validateChannelVersion('0.18.0-nightly.3', 'latest').ok, false);
  assert.equal(validateChannelVersion('0.18.0', 'nightly').ok, false);
  assert.equal(validateChannelVersion('latest', 'latest').ok, false);
  assert.equal(validateChannelVersion('1.2.03', 'latest').ok, false);
});

test('generated Claude and Codex marketplaces pin exact npm package versions', () => {
  const claude = buildClaudeMarketplace('0.18.0-nightly.3', 'nightly');
  assert.equal(claude.name, 'ours.network');
  assert.deepEqual(claude.plugins[0].source, {
    source: 'npm', package: '@ours.network/claude-code', version: '0.18.0-nightly.3',
  });

  const codex = buildCodexMarketplace('0.17.0', 'latest');
  assert.equal(codex.name, 'ours-codex-marketplace');
  assert.deepEqual(codex.plugins[0].source, {
    source: 'npm', package: '@ours.network/codex', version: '0.17.0', registry: 'https://registry.npmjs.org',
  });
  for (const json of [marketplaceJson(claude), marketplaceJson(codex)]) {
    assert.doesNotMatch(json, /"version"\s*:\s*"(?:latest|nightly)"/);
    assert.ok(json.endsWith('\n'));
  }
});

test('generated marketplace roots are stable across reruns', () => {
  assert.deepEqual(marketplacePaths('/home/tester'), {
    claudeRoot: '/home/tester/.ours/install/marketplaces/claude-code',
    claudeManifest: '/home/tester/.ours/install/marketplaces/claude-code/.claude-plugin/marketplace.json',
    codexRoot: '/home/tester/.ours/install/marketplaces/codex',
    codexManifest: '/home/tester/.ours/install/marketplaces/codex/.agents/plugins/marketplace.json',
  });
});
