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
  assert.equal(await runClientCommand({ operation: 'install', integrations: [] }, effects), 0);
  assert.equal(acquired, true);
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
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

for (const drift of [false, true]) test(`private host CLI ${drift ? 'rejects SDK drift without replacing command' : 'retains its SDK across publication retries'}`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'ours-private-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, '.ours-client-install/selection');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const cli = '@ours.network/cli', sdk = '@ours.network/sdk';
  const integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
  const artifacts = { [cli]: { version: '2.8.1-nightly.4', integrity }, [sdk]: { version: '3.8.1-nightly.6', integrity } };
  const policy = { release: { schema: 1, scope: 'host-cli', channel: 'nightly', installerVersion: '1.2.0-nightly.3', packages: artifacts }, packages: Object.fromEntries(Object.entries(artifacts).map(([n,p]) => [n,{type:'npm',version:p.version}])) };
  const write = (path,value) => { mkdirSync(join(path,'..'),{recursive:true}); writeFileSync(path,JSON.stringify(value)); };
  write(join(root,'sources.json'),policy);
  const manifest = { private: true, dependencies: Object.fromEntries(Object.entries(artifacts).map(([n,p])=>[n,p.version])) };
  write(join(root,'package.json'),manifest);
  const entries = Object.fromEntries(Object.entries(artifacts).map(([n,p])=>['node_modules/'+n,{...p,resolved:`https://registry.npmjs.org/${n}/-/artifact.tgz`} ]));
  write(join(root,'package-lock.json'),{lockfileVersion:3,packages:{'':manifest,...entries}});
  write(join(root,'node_modules/.package-lock.json'),{lockfileVersion:3,packages:entries});
  for (const [name,p] of Object.entries(artifacts)) {
    const packagePath=join(root,'node_modules',name);
    write(join(packagePath,'package.json'),{name,version:p.version,main:'dist/index.js',...(name===cli?{bin:{ours:'dist/cli.js'}}:{})});
    mkdirSync(join(packagePath,'dist')); writeFileSync(join(packagePath,'dist',name===cli?'cli.js':'index.js'),'#!/usr/bin/env node\n');
  }
  const packagePath=join(root,'node_modules',cli);
  const effects={home,out(){},run:async (_cmd,args)=>{assert.deepEqual(args,['prefix','--global']);return {stdout:home};}};
  await publishClientCli(effects,packagePath,{policy,isolated:true});
  const before=realpathSync(join(home,'bin/ours'));
  if(drift) {
    write(join(root,'node_modules',sdk,'package.json'),{name:sdk,version:'3.8.1-nightly.4',main:'dist/index.js'});
    await assert.rejects(publishClientCli(effects,packagePath,{policy,isolated:true}),/release/i);
  } else await publishClientCli(effects,packagePath,{policy,isolated:true});
  assert.equal(realpathSync(join(home,'bin/ours')),before);
});
