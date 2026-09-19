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

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishClientCli } from '../lib/client-cli.mjs';
import { buildManagedCli } from '../lib/managed-cli.mjs';
for (const fail of [false, true]) {
  test(`known managed launcher is backed up and ${fail ? 'restored after publication failure' : 'replaced by native CLI'}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'ours-cli-publish-'));
    try {
      mkdirSync(join(home, 'bin')); mkdirSync(join(home, '.ours-client'), { mode: 0o700 });
      const entry = join(home, 'bin/ours');
      const original = buildManagedCli(join(home, 'server/installation.json'), join(home, 'installer/install.mjs'));
      writeFileSync(entry, original, { mode: 0o755 });
      const packagePath = join(home, 'acquired'); mkdirSync(packagePath);
      writeFileSync(join(packagePath, 'package.json'), JSON.stringify({ name: '@ours.network/cli', version: '1.0.0', bin: { ours: 'cli.js' } }));
      writeFileSync(join(packagePath, 'cli.js'), '#!/usr/bin/env node\n');
      const npmRoot = join(home, 'lib/node_modules'); mkdirSync(join(npmRoot, '@ours.network'), { recursive: true });
      symlinkSync(packagePath, join(npmRoot, '@ours.network/cli'));
      const effects = { home, out() {}, run: async (_cmd, args) => {
        if (args[0] === 'prefix') return { stdout: home };
        if (args[0] === 'root') return { stdout: npmRoot };
        assert.equal(args[0], 'install'); assert.equal(existsSync(entry), false);
        if (fail) throw new Error('npm publication refused');
        symlinkSync(join(home, 'acquired/cli.js'), entry);
        return { stdout: '' };
      } };
      if (fail) {
        await assert.rejects(publishClientCli(effects, join(home, 'acquired')), /publication refused/);
        assert.equal(readFileSync(entry, 'utf8'), original);
      } else await publishClientCli(effects, join(home, 'acquired'));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
test('unknown host CLI is never overwritten', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ours-cli-unknown-'));
  try {
    mkdirSync(join(home, 'bin')); const entry = join(home, 'bin/ours');
    writeFileSync(entry, '#!/bin/sh\necho user-command\n', { mode: 0o755 });
    let installs = 0;
    const effects = { home, out() {}, run: async (_cmd, args) => { if (args[0] === 'install') installs++; return { stdout: home }; } };
    await assert.rejects(publishClientCli(effects, '/acquired'), /unknown ours/);
    assert.equal(installs, 0); assert.match(readFileSync(entry, 'utf8'), /user-command/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
