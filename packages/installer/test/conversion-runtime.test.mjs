import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realEffects } from '../lib/effects.mjs';

test('Docker runtime preparation keeps legacy selection usable and changes only installer assets', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ours-conversion-runtime-'));
  const workDir = join(root, 'runtime');
  fs.mkdirSync(workDir, { mode: 0o700 });
  const compose = join(workDir, 'docker-compose.yaml');
  const original = 'services: {}\nvolumes: {daemon-state: {}}\n';
  fs.writeFileSync(compose, original, { mode: 0o600 });
  const record = { schema: 1, mode: 'docker', root, workDir, project: 'ours-fixture', services: ['daemon'] };
  const effects = realEffects({ env: {}, home: root });
  let failBuild = true;
  const selected = [];
  effects.run = async (_command, args) => {
    if (args[0] === 'build') {
      if (failBuild) throw new Error('build failed');
      const dockerfile = fs.readFileSync(join(args.at(-1), 'Dockerfile'), 'utf8');
      assert.match(dockerfile, /FROM ours-fixture:runtime AS runtime/);
      assert.equal(fs.existsSync(join(args.at(-1), 'sources.json')), false);
    }
    if (args.includes('ps')) selected.push(args[args.indexOf('--file') + 1]);
    return { code: 0, stdout: '' };
  };
  try {
    await assert.rejects(effects.prepareDockerConversionRuntime(record), /build failed/);
    assert.equal(fs.readFileSync(compose, 'utf8'), original);
    failBuild = false;
    await effects.prepareDockerConversionRuntime(record);
    assert.equal(fs.readFileSync(join(workDir, 'docker-compose.legacy.yaml'), 'utf8'), original);
    assert.match(fs.readFileSync(compose, 'utf8'), /subpath: state\/mcp/);
    await effects.serverLifecycle(record, 'status');
    await effects.serverLifecycle({ ...record, schema: 2 }, 'status');
    assert.deepEqual(selected, [join(workDir, 'docker-compose.legacy.yaml'), compose]);
    assert.equal(fs.readdirSync(root).some(name => name.startsWith('.conversion-build-')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
