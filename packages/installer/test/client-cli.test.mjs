import test from 'node:test';
import assert from 'node:assert/strict';
import { runClientCommand } from '../lib/orchestrate.mjs';
import { fx } from './fake-effects.mjs';
test('client-only setup with no optional integrations still acquires the host CLI', async () => {
  const config = '/home/me/.ours-client/profile.json';
  const sources = '/home/me/.ours-client/sources.json';
  const profile = { endpoint: 'https://server.example', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: '/home/me/.ours-client/credential', installer: { sourcesPath: sources, integrations: [] } };
  const effects = fx({ json: { [config]: profile, [sources]: { packages: {} } } });
  let acquired = false;
  effects.acquireClientPackages = async (_config, _sources, integrations) => {
    assert.deepEqual(integrations, []); acquired = true; return { localPackages: {}, packages: {}, cliBin: '/exact/ours' };
  };
  effects.verifyPackagedMcp = async () => {};
  assert.equal(await runClientCommand({ operation: 'install', integrations: [] }, effects), 0);
  assert.equal(acquired, true);
});
