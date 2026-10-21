import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { realEffects } from '../lib/effects.mjs';

const effectsUrl = new URL('../lib/effects.mjs', import.meta.url).href;
const contender = `import {realEffects} from ${JSON.stringify(effectsUrl)};
try { await realEffects().withInstallationLock(process.argv[1], async()=>{}); }
catch(e) { console.error(e.message); process.exitCode=2; }`;
const compete = root => spawnSync(process.execPath, ['--input-type=module', '-e', contender, root], { encoding: 'utf8' });

test('installation lock excludes another process and releases on failure', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ours-install-lock-'));
  try {
    const effects = realEffects();
    await assert.rejects(effects.withInstallationLock(root, async () => {
      const attempt = compete(root);
      assert.equal(attempt.status, 2);
      assert.match(attempt.stderr, /another installer operation/i);
      throw new Error('fixture failure');
    }), /fixture failure/);
    assert.equal(compete(root).status, 0);
    assert.ok(fs.existsSync(join(root, '.operation.lock')), 'keep a stable lock inode');
    assert.doesNotThrow(() => effects.newInstallation(root, 'docker'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const throughBuild of [false, true]) test(`surviving ${throughBuild ? 'build command' : 'installer child'} retains exclusion after its parent is killed`, { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ours-install-child-lock-'));
  const ready = join(root, 'ready'), release = join(root, 'release');
  const child = `const fs=require('node:fs');fs.fstatSync(3);fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify([process.pid,process.ppid]));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);}},25);`;
  fs.writeFileSync(join(root, 'sources.json'), '{}');
  const buildUrl = new URL('../assets/scripts/build/build-common.mjs', import.meta.url).href;
  const build = `import {run} from ${JSON.stringify(buildUrl)};run([process.execPath,'-e',${JSON.stringify(child)}]);`;
  const args = throughBuild ? ['--input-type=module', '-e', build] : ['-e', child];
  const parentCode = `import {realEffects} from ${JSON.stringify(effectsUrl)};const e=realEffects();await e.withInstallationLock(process.argv[1],()=>e.run(process.execPath,${JSON.stringify(args)},{env:{OURS_BUILD_ROOT:process.argv[1]}}));`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', parentCode, root], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(parent, 'exit');
  let childPid;
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready) && parent.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(fs.existsSync(ready), 'child reached the inherited descriptor');
    const [pid, helperPid] = JSON.parse(fs.readFileSync(ready, 'utf8'));
    childPid = pid;
    if (throughBuild) process.kill(helperPid, 'SIGKILL');
    parent.kill('SIGKILL');
    await exited;
    assert.equal(compete(root).status, 2, 'parent exit must not release its surviving child lock');
    fs.writeFileSync(release, '');
    let attempt;
    do { attempt = compete(root); if (attempt.status !== 0) await new Promise(resolve => setTimeout(resolve, 25)); }
    while (attempt.status !== 0 && Date.now() < deadline);
    assert.equal(attempt.status, 0, attempt.stderr);
  } finally {
    parent.kill('SIGKILL');
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
