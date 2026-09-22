import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realEffects } from '../lib/effects.mjs';

const record = { schema: 2, mode: 'docker', instanceId: '12345678-1234-1234-1234-123456789abc', root: '/private/ours', workDir: '/private/ours/runtime', project: 'ours-fixture', services: ['daemon', 'cowork', 'messenger'] };

function fixture(failures, logOutput = 'Fatal: native addon could not load') {
  const effects = realEffects({ env: {}, out: () => {} });
  const calls = [];
  effects.run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('up') && failures.includes(args.at(-1))) throw new Error('container exited (1)');
    if (args.includes('logs')) return { stdout: logOutput };
    return { stdout: '' };
  };
  return { effects, calls };
}

test('daemon startup failure includes scoped container logs and leaves consumers stopped', async () => {
  const { effects, calls } = fixture(['daemon']);
  await assert.rejects(effects.serverLifecycle(record, 'start'), error => {
    assert.match(error.message, /Docker service "daemon" failed to start or become healthy/);
    assert.match(error.message, /Fatal: native addon could not load/);
    assert.match(error.message, /docker.*compose.*logs/);
    assert.equal(error.cause.message, 'container exited (1)');
    return true;
  });
  assert.deepEqual(calls.filter(call => call.args.includes('up')).map(call => call.args.at(-1)), ['daemon']);
  const logs = calls.find(call => call.args.includes('logs'));
  assert.deepEqual(logs.args.slice(-6), ['logs', '--no-color', '--tail', '50', '--timestamps', 'daemon']);
  assert.ok(logs.args.includes(record.workDir) && logs.args.includes(record.project));
});

test('consumer failure retains its logs while attempting unrelated consumers', async () => {
  const { effects, calls } = fixture(['cowork'], 'Missing configured identity');
  await assert.rejects(effects.serverLifecycle(record, 'start'), /Application readiness failed: cowork[\s\S]*Missing configured identity/);
  assert.deepEqual(calls.filter(call => call.args.includes('up')).map(call => call.args.at(-1)), record.services);
});

test('unavailable container logs do not hide the original startup failure', async () => {
  const { effects } = fixture(['daemon']); const run = effects.run;
  effects.run = async (command, args, options) => {
    if (args.includes('logs')) throw new Error('logging driver unavailable');
    return run(command, args, options);
  };
  await assert.rejects(effects.serverLifecycle(record, 'start'), error => {
    assert.match(error.message, /logs could not be read/i);
    assert.match(error.message, /container exited \(1\)/);
    assert.match(error.message, /docker.*logs/);
    return true;
  });
});

test('container diagnostics bound their size and remove terminal control sequences', async () => {
  const { effects } = fixture(['daemon'], '\u001b[31m' + 'x'.repeat(20000) + '\u001b[0m');
  await assert.rejects(effects.serverLifecycle(record, 'start'), error => {
    assert.ok(error.message.length < 8000);
    assert.doesNotMatch(error.message, /\u001b/);
    return true;
  });
});


test('Docker image build streams progress while credential operations remain captured', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ours-build-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcesPath = join(root, 'sources.json');
  writeFileSync(sourcesPath, JSON.stringify({ packages: {} }));
  const effects = realEffects({ env: {}, out: () => {} });
  const calls = [];
  effects.run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: args.includes('inspect') ? 1 : 0, stdout: '' };
  };
  effects.qualifyDockerRuntime = async () => { calls.push({ args: ['qualify'] }); };
  const selected = { ...record, root, sourcesPath, workDir: join(root, 'runtime') };
  await effects.prepareInstallation(selected, { runtimeOnly: true });
  const build = calls.find(call => call.args.includes('build'));
  assert(calls.findIndex(call => call.args.includes('qualify')) > calls.indexOf(build));
  assert.equal(build.options.stream, true);
  assert.equal(build.options.env.BUILDKIT_PROGRESS, 'plain');
  await effects.serverAccess(selected, 'access-init');
  const credentials = calls.find(call => call.args.includes('access-init'));
  assert.equal(credentials.options.sensitive, true);
  assert.notEqual(credentials.options.stream, true);
});

for (const supported of [false,true]) test(`gateway preparation gates exact Cowork artifact before enabling listener: ${supported}`, async t => {
  const root=mkdtempSync(join(tmpdir(),'ours-gateway-build-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const sourcesPath=join(root,'sources.json');writeFileSync(sourcesPath,JSON.stringify({packages:{}}));
  const effects=realEffects({env:{},out:()=>{}}), calls=[];
  effects.run=async(command,args,options)=>{
    calls.push({command,args,options});
    return {code:args.includes('inspect')?1:0,stdout:args.includes('capabilities')?JSON.stringify({ok:true,result:{capabilities:supported?['cowork.http-management-v1','messenger.gateway-prefix-v1','telegram.gateway-listener-v1']:[]}}):''};
  };
  effects.qualifyDockerRuntime=async()=>{};
  const selected={...record,root,sourcesPath,workDir:join(root,'runtime'),gateway:{version:1},port:3050,coworkPort:3052};
  if(supported) await effects.prepareInstallation(selected,{runtimeOnly:true});
  else await assert.rejects(effects.prepareInstallation(selected,{runtimeOnly:true}),/lacks cowork.http-management/);
  const probe=calls.find(c=>c.args.includes('capabilities'));
  assert.ok(probe.args.includes(`${record.project}:runtime`));
  assert.ok(probe.args.includes('none'));
  assert.equal(calls.some(c=>c.args.includes('build')&&c.args.at(-1)==='gateway'),supported);
  assert.equal(calls.some(c=>c.args.includes('up')),false);
});
