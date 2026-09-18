import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realEffects } from '../lib/effects.mjs';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ours-client-import-'));
  const input = join(home, 'input');
  mkdirSync(input, { mode: 0o700 });
  const profile = { endpoint: 'http://127.0.0.1:3050', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: join(input, 'token') };
  writeFileSync(profile.credentialPath, 'issued-client-token\n', { mode: 0o600 });
  const sourcesPath = join(input, 'sources.json');
  const fleetSettingsPath = join(input, 'fleet.json');
  writeFileSync(sourcesPath, JSON.stringify({ packages: { '@ours.network/fleet': { type: 'npm', version: '1.1.5' }, '@ours.network/sdk': { type: 'npm', version: '3.7.2' }, '@ours.network/cli': { type: 'npm', version: '2.7.2' } } }));
  writeFileSync(fleetSettingsPath, '{"displayName":"test"}');
  const effects = realEffects({ env: {}, home });
  return { home, input, profile, sourcesPath, fleetSettingsPath, effects };
}

test('managed import keeps private source-independent state and preserves repeat settings', () => {
  const f = fixture();
  try {
    const first = f.effects.importClientProfile({ profile: f.profile, sourcesPath: f.sourcesPath, integrations: ['fleet'], fleetSettingsPath: f.fleetSettingsPath });
    assert.equal(first.configPath, join(f.home, '.ours-client/profile.json'));
    assert.equal(first.profile.credentialPath, join(f.home, '.ours-client/credential'));
    for (const path of [first.configPath, first.profile.credentialPath, first.settings.sourcesPath, first.settings.fleetSettingsPath]) assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.home, '.ours-client')).mode & 0o777, 0o700);
    assert.equal(readFileSync(f.profile.credentialPath, 'utf8'), 'issued-client-token\n', 'source is untouched');
    rmSync(f.input, { recursive: true });
    const saved = f.effects.readManagedClientProfile();
    assert.deepEqual(saved.installer.integrations, ['fleet']);
    assert.equal(JSON.parse(readFileSync(saved.installer.fleetSettingsPath)).displayName, 'test');
    const before = readFileSync(first.configPath, 'utf8');
    f.effects.importClientProfile({ profile: first.profile, sourcesPath: saved.installer.sourcesPath, integrations: ['codex'] });
    assert.equal(readFileSync(first.configPath, 'utf8'), before);
    const replacement = join(f.home, 'replacement');
    writeFileSync(replacement, 'replacement-token', { mode: 0o600 });
    f.effects.importClientProfile({ profile: { ...first.profile, credentialPath: replacement }, sourcesPath: saved.installer.sourcesPath, integrations: ['fleet'] });
    assert.equal(readFileSync(first.profile.credentialPath, 'utf8'), 'replacement-token');
    assert.equal(readFileSync(first.configPath, 'utf8'), before);
    assert.throws(() => f.effects.importClientProfile({ profile: { ...first.profile, endpoint: 'http://other:3050' }, sourcesPath: saved.installer.sourcesPath, integrations: ['fleet'] }), /another server/i);
    assert.equal(readFileSync(first.configPath, 'utf8'), before);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('unreadable setup input never activates a managed default', () => {
  const f = fixture();
  try {
    assert.throws(() => f.effects.importClientProfile({ profile: f.profile, sourcesPath: f.sourcesPath, integrations: ['fleet'], fleetSettingsPath: join(f.input, 'missing') }));
    assert.equal(f.effects.readManagedClientProfile(), null);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('guided metadata is followed by authenticated daemon and MCP validation before publication', async () => {
  const f = fixture();
  const { createServer } = await import('node:http');
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push([req.url, req.headers['x-ours-api-token']]);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/selection') return res.end(JSON.stringify({ schema: 1, instanceId: f.profile.expectedInstanceId, capabilities: ['external-sessions-v1'] }));
    if (req.headers['x-ours-api-token'] !== 'issued-client-token') { res.statusCode = 401; return res.end('{}'); }
    if (req.url === '/version') return res.end('{"version":"test"}');
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const results = {
      initialize: { serverInfo: { name: 'ours' }, protocolVersion: '2025-03-26' },
      'resources/list': { resources: [{ uri: 'ours://application-identities' }] },
      'tools/list': { tools: [{ name: 'list_identities' }] },
    };
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] ?? {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const profile = await f.effects.discoverClientProfile(endpoint, f.profile.credentialPath);
    assert.equal(profile.expectedInstanceId, f.profile.expectedInstanceId);
    await f.effects.verifyHostProfile(profile);
    await f.effects.verifyPackagedMcp(profile);
    assert.equal(f.effects.readManagedClientProfile(), null, 'validation does not publish a default');
    assert.ok(requests.some(([url, token]) => url === '/version' && token === 'issued-client-token'));
    assert.ok(requests.some(([url, token]) => url === '/mcp' && token === 'issued-client-token'));
    writeFileSync(profile.credentialPath, 'wrong', { mode: 0o600 });
    await assert.rejects(f.effects.verifyHostProfile(profile), /HTTP 401/);
    assert.equal(f.effects.readManagedClientProfile(), null);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(f.home, { recursive: true, force: true }); }
});

test('explicit setup refreshes client selections while ordinary retries retain them', () => {
  const f = fixture();
  try {
    const first = f.effects.importClientProfile({ profile: f.profile, sourcesPath: f.sourcesPath, integrations: ['fleet'], fleetSettingsPath: f.fleetSettingsPath });
    const sources = { packages: { '@ours.network/codex': { type: 'npm', version: '2.0.0' }, '@ours.network/sdk': { type: 'npm', version: '4.0.0' } } };
    const refreshed = f.effects.importClientProfile({ profile: f.profile, sources, integrations: ['codex'], refresh: true });
    assert.equal(refreshed.configPath, first.configPath);
    assert.deepEqual(refreshed.settings.integrations, ['codex']);
    assert.equal(refreshed.settings.fleetSettingsPath, undefined);
    assert.deepEqual(JSON.parse(readFileSync(refreshed.settings.sourcesPath)), sources);
    assert.equal(refreshed.profile.expectedInstanceId, f.profile.expectedInstanceId);
    assert.equal(readFileSync(refreshed.profile.credentialPath, 'utf8'), 'issued-client-token\n');
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
