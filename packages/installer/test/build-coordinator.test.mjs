import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

test('JS coordinator builds an exact local Git selection through its existing recipe', () => {
  const root = mkdtempSync(join(tmpdir(), 'ours-build-js-'));
  try {
    const source = join(root, 'upstream');
    const output = join(root, 'output');
    mkdirSync(join(source, 'packages/installer'), { recursive: true });
    mkdirSync(output);
    const manifest = { name: 'fixture', version: '1.0.0', private: true };
    writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': manifest } }));
    writeFileSync(join(source, 'packages/installer/package.json'), JSON.stringify({ name: '@ours.network/install', version: '1.2.3' }));
    const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q'); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    writeFileSync(join(output, 'sources.json'), JSON.stringify({
      sources: { mcp: { type: 'git', url: source, commit: git('rev-parse', 'HEAD') } },
      packages: { '@ours.network/install': { source: 'mcp' } },
    }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../assets/scripts/build/build.mjs', import.meta.url))], {
      env: { ...process.env, OURS_BUILD_ROOT: output, OURS_SOURCE_ROOT: join(root, 'checkout'), OURS_BUILD_PACKAGES: 'install' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const built = JSON.parse(readFileSync(join(output, 'package.json')));
    assert.deepEqual(built.dependencies, { '@ours.network/install': 'file:docker/vendor/ours.network-install.tgz' });
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json', join(output, 'docker/vendor/ours.network-install.tgz')], { cwd: output, encoding: 'utf8' }))[0];
    assert.equal(packed.name, '@ours.network/install');
    assert.equal(packed.version, '1.2.3');
    // Exercise the actual fresh finalizer after npm's umask-sensitive install.
    execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: output, stdio: ['ignore', 'pipe', 'pipe'] });
    const finalized = spawnSync(process.execPath, [fileURLToPath(new URL('../assets/scripts/build/record-build.mjs', import.meta.url))], {
      env: { ...process.env, OURS_BUILD_ROOT: output }, encoding: 'utf8',
    });
    assert.equal(finalized.status, 0, finalized.stderr);
    const context = JSON.parse(readFileSync(join(output, 'build-context.json')));
    assert.equal(context.schema, 1);
    assert.equal(context.vendors[0].name, '@ours.network/install');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
