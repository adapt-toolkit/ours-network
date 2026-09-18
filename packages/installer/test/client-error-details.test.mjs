import test from 'node:test';
import assert from 'node:assert/strict';
import { runClientCommand } from '../lib/orchestrate.mjs';
import { fx } from './fake-effects.mjs';

function fixture(status = 'ok') {
  const path = '/home/me/.ours-client/profile.json', sourcesPath = '/home/me/.ours-client/sources.json';
  const profile = { endpoint: 'http://server:3050', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: '/home/me/.ours-client/credential', installer: { sourcesPath, integrations: ['codex'] } };
  const effects = fx({ harnesses: [{ name: 'codex', status, command: 'codex' }], json: { [path]: profile, [sourcesPath]: { packages: {} } } });
  effects.verifyPackagedMcp = async () => {};
  effects.acquireClientPackages = async () => ({ localPackages: { codex: '/exact/codex' }, packages: {} });
  effects.prepareClientMarketplace = async () => '/private/marketplace';
  return { effects, path };
}
const finalOutput = effects => effects.recorder.out.join('\n').split('Client setup incomplete').at(-1);

for (const [command, label] of [['marketplace', 'Register Codex marketplace'], ['add', 'Install Codex plugin']]) {
  test(`client summary preserves failed Codex ${command} step and actionable command`, async () => {
    const f = fixture();
    f.effects.run = async (_cmd, args) => {
      if (args[1] === command) throw new Error('Permission denied writing plugin registry');
      return { ok: true, code: 0 };
    };
    assert.equal(await runClientCommand({ operation: 'install' }, f.effects), 2);
    const output = finalOutput(f.effects);
    assert.match(output, new RegExp(label));
    assert.match(output, /Permission denied writing plugin registry/);
    assert.match(output, /Fix the reported command error/);
    assert.match(output, /--config '\/home\/me\/\.ours-client\/profile.json'/);
    assert.match(output, /--integrations 'codex'/);
    assert.match(output, /--sources '\/home\/me\/\.ours-client\/sources.json'/);
    assert.doesNotMatch(output, /Client setup complete/);
  });
}

for (const status of ['absent', 'alias', 'unsafe']) {
  test(`client summary explains ${status} Codex without inventing a command failure`, async () => {
    const f = fixture(status);
    assert.equal(await runClientCommand({ operation: 'install' }, f.effects), 2);
    const output = finalOutput(f.effects);
    assert.match(output, status === 'absent' ? /Codex.*not found.*PATH/ : /Codex.*cannot.*automatically/);
    assert.match(output, /codex --version/);
    assert.match(output, /Saved profile and settings retained/);
    assert.doesNotMatch(output, /Permission denied|Server installation failed/);
  });
}

test('client diagnostics redact common credentials and strip terminal controls', async () => {
  const f = fixture();
  f.effects.run = async () => { throw new Error('\x1b[31mDenied Authorization: Bearer very-private-token apiToken=another-secret https://user:private-password@example.test/path\x1b[0m'); };
  assert.equal(await runClientCommand({ operation: 'install' }, f.effects), 2);
  const output = f.effects.recorder.out.join('\n');
  assert.doesNotMatch(output, /very-private-token|another-secret|private-password|\x1b/);
  assert.match(output, /redacted/);
});

test('retry retains all selected integrations and safely quotes saved paths', async () => {
  const f = fixture();
  const original = f.effects.importClientProfile;
  f.effects.importClientProfile = options => {
    const result = original(options);
    return { ...result, configPath: "/private/user's settings/profile.json", settings: { ...result.settings, sourcesPath: "/private/user's settings/sources.json" } };
  };
  f.effects.run = async () => { throw new Error('registration denied'); };
  assert.equal(await runClientCommand({ operation: 'install', integrations: ['codex', 'claude-code'] }, f.effects), 2);
  const output = finalOutput(f.effects);
  assert.match(output, /--integrations 'codex,claude-code'/);
  assert(output.includes("'/private/user'\\''s settings/profile.json'"));
  assert(output.includes("'/private/user'\\''s settings/sources.json'"));
});
