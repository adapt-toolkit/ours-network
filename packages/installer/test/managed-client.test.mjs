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

test('guided metadata is followed by authenticated daemon API validation before publication', async () => {
  const f = fixture();
  const { createServer } = await import('node:http');
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push([req.url, req.headers['x-ours-api-token']]);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/ours') { res.statusCode = 404; return res.end('{}'); }
    if (req.url === '/selection') return res.end(JSON.stringify({ schema: 1, instanceId: f.profile.expectedInstanceId, capabilities: ['external-sessions-v1'] }));
    if (req.headers['x-ours-api-token'] !== 'issued-client-token') { res.statusCode = 401; return res.end('{}'); }
    if (req.url === '/version') return res.end('{"version":"test"}');
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const profile = await f.effects.discoverClientProfile(endpoint, f.profile.credentialPath);
    assert.equal(profile.expectedInstanceId, f.profile.expectedInstanceId);
    await f.effects.verifyHostProfile(profile);

    assert.equal(f.effects.readManagedClientProfile(), null, 'validation does not publish a default');
    assert.ok(requests.some(([url, token]) => url === '/version' && token === 'issued-client-token'));
    assert.ok(!requests.some(([url]) => url === '/mcp'));
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

for (const mode of ['gateway', 'malformed', 'redirect', 'unauthorized']) {
  test(`server URL discovery: ${mode}`, async () => {
    const f = fixture();
    const { createServer } = await import('node:http');
    const { gatewayDiscovery } = await import('../lib/gateway.mjs');
    const requests = [];
    const server = createServer((req, res) => {
      requests.push([req.url, req.headers['x-ours-api-token']]);
      if (req.url === '/base/.well-known/ours') {
        if (mode === 'redirect') { res.writeHead(302, { location: '/selection' }); return res.end(); }
        if (mode === 'unauthorized') { res.writeHead(401); return res.end(); }
        return res.end(JSON.stringify(mode === 'malformed' ? {} : gatewayDiscovery({ instanceId: f.profile.expectedInstanceId })));
      }
      if (req.url === '/base/daemon/selection') return res.end(JSON.stringify({schema:1,instanceId:f.profile.expectedInstanceId,capabilities:['external-sessions-v1']}));
      if (req.url === '/base/daemon/version' && req.headers['x-ours-api-token'] === 'issued-client-token') return res.end('{"version":"test"}');
      res.writeHead(404); res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}/base`;
      if (mode !== 'gateway') {
        await assert.rejects(f.effects.discoverClientProfile(base, f.profile.credentialPath));
        assert.deepEqual(requests.map(([url])=>url), ['/base/.well-known/ours']);
      } else {
        const profile = await f.effects.discoverClientProfile(base, f.profile.credentialPath);
        assert.equal(profile.serverUrl, base);
        assert.equal(profile.endpoint, base + '/daemon');
        await f.effects.verifyHostProfile(profile);
        const saved = f.effects.importClientProfile({profile,sourcesPath:f.sourcesPath,integrations:['fleet']});
        assert.equal(saved.profile.serverUrl, base);
      }
      assert.equal(requests[0][1], undefined, 'discovery never carries credentials');
    } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); rmSync(f.home,{recursive:true,force:true}); }
  });
}

test('gateway Fleet artifact is qualified before publishing native commands, including acquisition retry', async () => {
  const f = fixture();
  try {
    const profile = { ...f.profile, serverUrl: 'http://127.0.0.1:3050/base', endpoint: 'http://127.0.0.1:3050/base/daemon' };
    const imported = f.effects.importClientProfile({ profile, sourcesPath: f.sourcesPath, integrations: ['fleet'] });
    let artifact;
    let acquisitions = 0;
    let publications = 0;
    f.effects.run = async (_command, args, options) => {
      if (args.includes('--global')) { publications++; throw new Error('publication reached'); }
      if (args[0] === 'install') {
        acquisitions++;
        const dir = join(options.cwd, 'node_modules/@ours.network/fleet/dist');
        mkdirSync(dir, { recursive: true });
        artifact = join(dir, 'build-info.json');
        writeFileSync(artifact, JSON.stringify({ capabilities: [] }));
      }
      return { ok: true, code: 0, stdout: '' };
    };
    const acquire = () => f.effects.acquireClientPackages(imported.configPath, imported.settings.sourcesPath, ['fleet']);
    await assert.rejects(acquire(), /does not support gateway HTTP management/);
    assert.equal(publications, 0);
    writeFileSync(artifact, JSON.stringify({ capabilities: ['cowork.http-management-v1'] }));
    await assert.rejects(acquire(), /publication reached/);
    assert.equal(acquisitions, 1, 'retry revalidates the retained artifact');
    assert.equal(publications, 1);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

for (const existing of [false, true]) test(`gateway qualification preserves active managed inputs (existing=${existing})`, async () => {
  const f = fixture();
  try {
    const profile = { ...f.profile, serverUrl: 'http://127.0.0.1:3050/base', endpoint: 'http://127.0.0.1:3050/base/daemon' };
    if (existing) f.effects.importClientProfile({ profile, sourcesPath: f.sourcesPath, integrations: ['fleet'], fleetSettingsPath: f.fleetSettingsPath });
    const paths = ['profile.json', 'credential', 'sources.json', 'fleet-settings.json'].map(name => join(f.home, '.ours-client', name));
    const contents = paths.map(path => { try { return readFileSync(path); } catch { return null; } });
    let publications = 0;
    f.effects.run = async (_command, args) => {
      if (args.includes('--global')) publications++;
      return { ok: true, code: 0, stdout: '' };
    };
    await assert.rejects(f.effects.qualifyGatewayClient({ profile, sourcesPath: f.sourcesPath, integrations: ['fleet'] }), /does not support gateway HTTP management/);
    assert.equal(publications, 0);
    for (const [index, path] of paths.entries()) {
      let value = null; try { value = readFileSync(path); } catch {}
      assert.deepEqual(value, contents[index]);
    }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('installed Fleet gate reads the answering executable and rejects missing or legacy capabilities', async () => {
  const f = fixture();
  try {
    const profile = { installer: { integrations: ['fleet'] } };
    for (const capabilities of [undefined, [], ['cowork.http-management-v1']]) {
      f.effects.run = async (command, args) => {
        assert.equal(command, 'ours-fleet'); assert.deepEqual(args, ['version', '--json']);
        return { stdout: JSON.stringify({ capabilities }) };
      };
      if (capabilities?.length) await f.effects.qualifyInstalledGatewayClient(profile);
      else await assert.rejects(f.effects.qualifyInstalledGatewayClient(profile), /upgrade Fleet/);
    }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
