import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installationPaths } from '../lib/plan.mjs';
import { validatePackageState } from '../lib/state-validation.mjs';
import { realEffects } from '../lib/effects.mjs';
import { selectedComponents, validateDockerLayout } from '../assets/scripts/maintenance/docker-layout-conversion.mjs';

const instanceId = '12345678-1234-1234-1234-123456789abc';
const records = { 'package-lock.json': '{}', 'dependency-tree.json': '{}' };
const write = (path, value) => { fs.mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 }); fs.writeFileSync(path, value, { mode: 0o600 }); };
const temporary = prefix => fs.realpathSync(fs.mkdtempSync(join(tmpdir(), prefix)));
const marker = directory => { for (const [name, bytes] of Object.entries(records)) write(join(directory, '.ours-provenance', name), bytes); };

test('native state validation accepts the selected build and refuses mixed provenance', () => {
  const root = temporary('ours-package-validation-');
  const record = { schema: 2, mode: 'packages', root, workDir: join(root, 'runtime'), instanceId, port: 3050 };
  record.configPath = installationPaths(record).config;
  const paths = installationPaths(record);
  try {
    for (const [name, bytes] of Object.entries(records)) write(join(record.workDir, name), bytes);
    for (const service of ['daemon', 'telegram', 'cowork', 'messenger']) marker(paths[service]);
    const profile = { endpoint: 'http://127.0.0.1:3050', expectedInstanceId: instanceId, credentialPath: join(paths.daemon, 'daemon-token') };
    write(paths.config, JSON.stringify({ stateDir: paths.daemon, port: 3050, networkMcp: { profile, applicationConfigPath: join(paths.mcp, 'config.json') } }));
    write(join(paths.mcp, 'profile.json'), JSON.stringify(profile));
    write(join(paths.cowork, 'config.json'), JSON.stringify({ stateDir: paths.cowork }));
    for (const credential of [profile.credentialPath, ...Object.values(paths.credentials)]) write(credential, 'opaque-token');
    validatePackageState(record);
    write(join(paths.telegram, '.ours-provenance/package-lock.json'), '{"other":true}');
    assert.throws(() => validatePackageState(record), /telegram differs from the selected build/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Docker state validation follows the application selection and runs as the image entrypoint', { skip: process.getuid() === 0 }, () => {
  const root = temporary('ours-docker-validation-');
  const tree = join(root, 'storage/state'), build = join(root, 'build');
  const options = { uid: process.getuid(), gid: process.getgid(), instanceId, provenance: Object.fromEntries(Object.entries(records).map(([name, bytes]) => [name, Buffer.from(bytes)])) };
  try {
    for (const [name, bytes] of Object.entries(records)) write(join(build, name), bytes);
    for (const component of ['daemon', 'telegram', 'cowork', 'messenger']) marker(join(tree, component));
    write(join(tree, 'daemon/config.json'), JSON.stringify({ stateDir: '/var/lib/ours', port: 3050 }));
    write(join(tree, 'mcp/profile.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:3050', expectedInstanceId: instanceId, credentialPath: '/var/lib/ours/daemon-token' }));
    write(join(tree, 'cowork/config.json'), JSON.stringify({ stateDir: '/var/lib/ours-cowork' }));
    write(join(tree, 'daemon/daemon-token'), 'opaque');
    for (const name of ['telegram', 'cowork', 'messenger']) write(join(tree, 'credentials', name, 'daemon-token'), 'opaque');
    validateDockerLayout(tree, options);
    const cowork = join(root, 'cowork.mjs');
    write(cowork, `#!${process.execPath}\nif(process.argv.slice(2).join(' ')!=='--json prepare-backup')process.exit(2);`);
    fs.chmodSync(cowork, 0o700);
    const entrypoint = fileURLToPath(new URL('../assets/scripts/maintenance/docker-layout-conversion.mjs', import.meta.url));
    const env = { ...process.env, OURS_STATE_ROOT: join(root, 'storage'), OURS_BUILD_ROOT: build, OURS_DAEMON_ID: instanceId, OURS_COWORK_CLI_PATH: cowork };
    execFileSync(process.execPath, [entrypoint, 'validate'], { env, stdio: 'pipe' });
    for (const removed of [['prepare', 'label'], ['cleanup']]) assert.throws(() => execFileSync(process.execPath, [entrypoint, ...removed], { env, stdio: 'pipe' }), /usage: validate/);
    write(join(tree, 'cowork/config.json'), '{}');
    assert.throws(() => execFileSync(process.execPath, [entrypoint, 'validate'], { env, stdio: 'pipe' }));
    validateDockerLayout(tree, { ...options, components: ['daemon'] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  assert.deepEqual(selectedComponents({}), ['daemon', 'telegram', 'cowork', 'messenger']);
  assert.deepEqual(selectedComponents({ OURS_SERVER_APPLICATIONS: '' }), ['daemon', 'telegram', 'cowork', 'messenger']);
  assert.deepEqual(selectedComponents({ OURS_SERVER_APPLICATIONS: 'daemon' }), ['daemon']);
  for (const bad of ['cowork', 'daemon,daemon', 'daemon,gateway']) assert.throws(() => selectedComponents({ OURS_SERVER_APPLICATIONS: bad }), /invalid/);
});

test('a collaboration-tools installation validates only its daemon state after an update', async () => {
  const root = temporary('ours-validation-plugin-only-');
  const effects = realEffects({ env: {}, home: root });
  const definitions = [];
  effects.run = async (_command, args) => { definitions.push(JSON.parse(fs.readFileSync(args[args.indexOf('--file') + 1]))); assert.ok(args.includes('--rm')); return { code: 0, stdout: '' }; };
  try {
    const base = { root, mode: 'docker', project: 'ours-fixture', uid: 1000, gid: 1000, instanceId };
    await effects.validateServerBuildState({ ...base, product: 'plugin-only', services: ['daemon'] });
    await effects.validateServerBuildState({ ...base, services: ['daemon', 'telegram', 'cowork', 'messenger', 'gateway'] });
    const [plugin, workspace] = definitions.map(value => value.services['state-operation']);
    assert.deepEqual(plugin.volumes.map(v => v.target).sort(), ['/storage', '/var/lib/ours']);
    assert.equal(plugin.environment.OURS_SERVER_APPLICATIONS, 'daemon');
    assert.ok(workspace.volumes.some(v => v.target === '/var/lib/ours-cowork' && v.volume.subpath === 'state/cowork'), 'the workspace keeps its full validation');
    assert.equal(workspace.environment.OURS_SERVER_APPLICATIONS, '');
    assert.ok(definitions.every(value => value.volumes.storage.external === true && value.volumes.storage.name === 'ours-fixture_server-storage'));
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
