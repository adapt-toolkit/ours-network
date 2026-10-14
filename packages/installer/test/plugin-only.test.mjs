// Plugin-only installations: option rules, record validation and package roles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSetupArgs, validateSetupOptions } from '../lib/setup-options.mjs';
import { validateInstallation, selectSourcePackages, resolveSourcePolicy, DAEMON_PACKAGES } from '../lib/plan.mjs';
import { pluginOnlyCompose, serverRole, isPluginOnly, CLIENT_PREFIX_PORT } from '../lib/product.mjs';

const parse = argv => parseSetupArgs(argv, { home: '/home/fixture' });
const base = ['--plugin-only', '--state-dir', '/private/ours', '--identity-name', 'me@host'];

test('--plugin-only selects Docker by default and only Claude Code or Codex', () => {
  const options = parse([...base, '--integrations', 'claude-code,codex']);
  assert.equal(options.product, 'plugin-only');
  assert.equal(options.mode, 'docker');
  assert.equal(parse([...base, '--integrations', 'none']).integrations.length, 0);
  assert.equal(parse([...base, '--integrations', 'codex', '--container-engine', 'podman']).containerEngine, 'podman');
  for (const extra of [['--integrations', 'fleet'], ['--integrations', 'codex', '--mode', 'native'], ['--integrations', 'codex', '--fleet-settings', '/f.json'],
    ['--integrations', 'codex', '--name', 'A', '--surname', 'B', '--username', 'a'], ['--integrations', 'codex', '--cowork-port', '4000'],
    ['--integrations', 'codex', '--migrate-from', '/home/me/.ours/config.json', '--compatible'], ['--integrations', 'codex', '--server-url', 'https://x.example']]) {
    assert.throws(() => parse([...base, ...extra]), extra.join(' '));
  }
  assert.throws(() => parse(['client', '--plugin-only', '--config', '/p.json', '--integrations', 'codex']), /client scope/);
  assert.throws(() => parse([...base, '--plugin-only', '--integrations', 'codex']), /Duplicate/);
});

test('validation is pure for the product field', () => {
  assert.throws(() => validateSetupOptions({ scope: 'all', product: 'everything', mode: 'docker', stateDir: '/x', identityName: 'a', integrations: [] }), /Product/);
  const input = { scope: 'server', product: 'plugin-only', stateDir: '/x', identityName: 'a' };
  assert.equal(validateSetupOptions(input).mode, 'docker');
  assert.equal(input.mode, undefined);
});

const record = (extra = {}) => ({ schema: 2, root: '/r', mode: 'docker', product: 'plugin-only', instanceId: '12345678-1234-1234-1234-123456789abc', project: 'ours-abc',
  workDir: '/r/runtime', configPath: '/r/storage/state/daemon/config.json', sourcesPath: '/r/sources.json', services: ['daemon'], port: 3050, ...extra });

test('a plugin-only record is exactly one daemon service in a container, without a gateway', () => {
  assert.equal(validateInstallation(record(), '/r').product, 'plugin-only');
  for (const bad of [{ services: ['daemon', 'gateway'], gateway: { version: 1 } }, { services: ['daemon', 'cowork'] }, { mode: 'packages' }, { product: 'workspace' }, { product: 'other' }]) {
    assert.throws(() => validateInstallation(record(bad), '/r'), JSON.stringify(bad));
  }
  assert.ok(isPluginOnly(record()) && !isPluginOnly({}) && serverRole(record()) === 'daemon' && serverRole({}) === 'server');
});

test('the daemon role selects only the SDK, CLI and daemon packages', async () => {
  const all = Object.fromEntries(['sdk', 'cli', 'daemon', 'tg-connector', 'cowork', 'messenger-server', 'notifications'].map(n => [`@ours.network/${n}`, { type: 'npm', version: '1.0.0' }]));
  assert.deepEqual(Object.keys(selectSourcePackages({ packages: all }, 'daemon')), DAEMON_PACKAGES);
  const exact = await resolveSourcePolicy({ packages: all }, 'daemon');
  assert.deepEqual(Object.keys(exact.packages), DAEMON_PACKAGES);
  assert.equal(Object.keys(selectSourcePackages({ packages: all }, 'server')).length, 7);
});

test('the plugin-only Compose overlay publishes only the client prefix and mounts only daemon state', () => {
  const text = pluginOnlyCompose();
  assert.match(text, /entrypoint: \[node, \/opt\/ours\/docker\/daemon-client-prefix\.mjs\]/);
  assert.match(text, new RegExp(`ports: !override\\n      - \\{target: ${CLIENT_PREFIX_PORT}, published: "\\$\\{OURS_HOST_PORT:-3050\\}", host_ip: 127\\.0\\.0\\.1\\}`));
  assert.doesNotMatch(text, /target: 3050/);
  assert.doesNotMatch(text, /telegram|cowork|messenger|credentials/);
  assert.equal(text.match(/OURS_SERVER_APPLICATIONS: daemon/g).length, 4);
});

test('custom agent app guidance names the exact server, the required session id and the pinned package', async () => {
  const { customHarnessGuidance } = await import('../lib/welcome.mjs');
  const text = customHarnessGuidance({ version: '1.2.0-nightly.13', profilePath: '/home/u/.ours-client/profile.json', marketplace: '/home/u/.ours-client-install/aaaaaaaaaaaaaaaa/marketplaces/claude-code' }).join('\n');
  assert.match(text, /arguments: \/home\/u\/\.ours-client-install\/aaaaaaaaaaaaaaaa\/marketplaces\/claude-code\/plugins\/ours\/bin\/proxy\.mjs/);
  assert.match(text, /CLAUDE_CODE_SESSION_ID = a value unique to each agent session/);
  assert.match(text, /@ours\.network\/claude-code@1\.2\.0-nightly\.13/);
  assert.match(text, /cannot use Ours this way/);
  assert.doesNotMatch(text, /no extra settings are needed/);
});
