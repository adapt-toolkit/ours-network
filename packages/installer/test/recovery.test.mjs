import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { reconcileDockerRecovery } from '../lib/docker-recovery.mjs';

const moduleUrl = new URL('../assets/scripts/runtime/recover.mjs', import.meta.url).href;
const node = source => [process.execPath, '-e', source];
const read = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
async function until(check, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!check()) { assert(Date.now() < end, 'condition timed out'); await sleep(30); }
}
function fixture(t, options = {}, autostart = true) {
  const dir = mkdtempSync(join(tmpdir(), 'ours-recovery-test-'));
  const count = join(dir, 'count'), healthy = join(dir, 'healthy'), ready = join(dir, 'ready');
  writeFileSync(healthy, 'yes');
  const logs = { text: '' };
  const launch = config => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', `import {runRecovery} from ${JSON.stringify(moduleUrl)}; await runRecovery(${JSON.stringify(config)});`], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', chunk => { logs.text += chunk; });
    t.after(() => proc.kill('SIGKILL'));
    return proc;
  };
  const config = { graceMs: 100, intervalMs: 50, probeTimeoutMs: 200, killAfterMs: 200, retries: 3, failures: 2,
    command: node(`const fs=require('fs'); fs.appendFileSync(${JSON.stringify(count)}, 'x'); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`),
    health: node(`process.exit(require('fs').existsSync(${JSON.stringify(healthy)})?0:1)`), ...options };
  const proc = autostart ? launch(config) : undefined;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {dir,count,healthy,ready,proc,config,launch,logs};
}
async function stop(proc) { const exited = once(proc, 'exit'); proc.kill('SIGTERM'); assert.equal((await exited)[0], 0); }
// Budget exhaustion must end the container's main process, never strand it.
async function exhausted(proc) { const [code] = proc.exitCode === null ? await once(proc, 'exit') : [proc.exitCode]; assert.equal(code, 75); }

test('exited child recovers once and remains ready', async t => {
  const f = fixture(t); await until(() => read(f.count).length === 1);
  // Kill the child process group through a child-recorded PID, without killing its supervisor.
  await stop(f.proc);
  f.config.command = node(`const fs=require('fs');let n=fs.existsSync(${JSON.stringify(f.count)})?fs.readFileSync(${JSON.stringify(f.count)},'utf8').length:0; fs.appendFileSync(${JSON.stringify(f.count)},'x'); if(n===1)setTimeout(()=>process.exit(7),100);else {process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);}`);
  const proc = f.launch(f.config); await until(() => read(f.count).length === 3);
  await sleep(400); assert.equal(read(f.count).length, 3); await stop(proc);
});

test('persistent failure exits visibly after exactly three recoveries; explicit restart resets it', async t => {
  const f = fixture(t, {}, false);
  f.config.command = node(`require('fs').appendFileSync(${JSON.stringify(f.count)},'x');process.exit(7)`);
  const proc = f.launch(f.config); await until(() => read(f.count).length === 4);
  await exhausted(proc); await sleep(200); assert.equal(read(f.count).length, 4);
  assert.match(f.logs.text, /recovery exhausted \(3 automatic attempts.*Exiting with status 75/);
  const restarted = f.launch({...f.config, command: node(`require('fs').appendFileSync(${JSON.stringify(f.count)},'x');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`)});
  await until(() => read(f.count).length === 5); await stop(restarted);
});

test('unhealthy child is terminated then recovered, and intentional stop remains stopped', async t => {
  const f = fixture(t); await until(() => read(f.count).length === 1);
  rmSync(f.healthy); await until(() => read(f.count).length === 2);
  writeFileSync(f.healthy,'yes'); await sleep(400); assert.equal(read(f.count).length,2);
  await stop(f.proc); await sleep(300); assert.equal(read(f.count).length,2);
});

test('dependency boot/outage does not consume the consumer circuit', async t => {
  const f = fixture(t, {}, false);
  f.config.dependency = node(`process.exit(require('fs').existsSync(${JSON.stringify(f.ready)})?0:1)`);
  writeFileSync(f.count,''); const proc = f.launch(f.config);
  await sleep(1000); assert.equal(read(f.count),'');
  writeFileSync(f.ready,'yes'); await until(() => read(f.count).length === 1);
  rmSync(f.ready); rmSync(f.healthy);
  await sleep(1000); assert.equal(read(f.count).length,1);
  writeFileSync(f.ready,'yes'); await until(() => read(f.count).length === 2);
  writeFileSync(f.healthy,'yes'); await sleep(350); assert.equal(read(f.count).length,2);
  await stop(proc);
});

test('hung probes and SIGTERM-ignoring children are killed within bounds', async t => {
  const f = fixture(t, {}, false);
  const pid = join(f.dir,'pid'); writeFileSync(f.count,'');
  f.config.command = node(`require('fs').writeFileSync(${JSON.stringify(pid)},String(process.pid));require('fs').appendFileSync(${JSON.stringify(f.count)},'x');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`);
  f.config.health = node('setInterval(()=>{},1000)');
  const proc = f.launch(f.config); await until(() => read(f.count).length === 1);
  const first = Number(read(pid)); await until(() => read(f.count).length === 2);
  assert.throws(() => process.kill(first,0), {code:'ESRCH'});
  const started = Date.now(); await stop(proc); assert(Date.now()-started<1500);
});

test('reconciliation changes only owned long-running containers, without start/recreate', async () => {
  const record = {mode:'docker',project:'ours-test',services:['daemon','cowork']};
  const row = (id,service,oneoff='False',project='ours-test') => ({Id:id,Config:{Labels:{'com.docker.compose.project':project,'com.docker.compose.service':service,'com.docker.compose.oneoff':oneoff}},State:{Status:'exited'},HostConfig:{RestartPolicy:{Name:'no'}}});
  const rows = [row('a','daemon'),row('b','cowork'),row('c','prepare'),row('d','daemon','True')];
  const calls=[]; const effects={run:async(_cmd,args)=>{calls.push(args);return {stdout:args[0]==='ps'?'a b c d':args[0]==='inspect'?JSON.stringify(rows):''};}};
  await reconcileDockerRecovery(record,effects);
  assert.deepEqual(calls.at(-1),['update','--restart','unless-stopped','a','b']);
  assert(!calls.flat().some(x=>['start','up','restart','rm'].includes(x)));
  rows[0].Config.Labels['com.docker.compose.project']='another';
  await assert.rejects(reconcileDockerRecovery(record,effects),/ownership differs/);
});

test('leader exit and operator stop leave no SIGTERM-resistant descendant writer', async t => {
  const f = fixture(t, {}, false);
  const pids = join(f.dir,'pids'); writeFileSync(f.count,'');
  const stubborn = `require('fs').appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  f.config.command = node(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(f.count)},'x');require('child_process').spawn(process.execPath,['-e',${JSON.stringify(stubborn)}],{stdio:'inherit'});process.on('SIGTERM',()=>process.exit(0));setTimeout(()=>process.exit(7),350)`);
  const proc = f.launch(f.config); await until(() => read(f.count).length === 4);
  await sleep(500);
  const alive = pid => { try {const stat=readFileSync(`/proc/${pid}/stat`,'utf8');return !['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]);}catch{return false;} };
  assert(read(pids).trim().split('\n').every(pid=>!alive(pid)),'descendants retain no live writer after circuit');
  await exhausted(proc);
  const previous=read(pids).trim().split('\n').length;
  const second=f.launch({...f.config,command:node(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(stubborn)}],{stdio:'inherit'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`)});
  await until(()=>read(pids).trim().split('\n').length>previous);
  await stop(second);
  assert(read(pids).trim().split('\n').every(pid=>!alive(pid)),'descendants retain no live writer after operator stop');
});

test('managed server uninstall stops/removes services with clean-exit guard and retains volumes', async()=>{
 const {realEffects}=await import('../lib/effects.mjs');
 const effects=realEffects({env:{},out:()=>{}}),calls=[];
 effects.run=async(cmd,args)=>{calls.push(args);if(args.includes('ps')&&args.includes('-aq'))return {stdout:'one'};if(args[0]==='inspect')return {stdout:JSON.stringify({Status:'exited',ExitCode:0,OOMKilled:false,Dead:false})};return {stdout:''};};
 const record={schema:2,mode:'docker',root:'/private/test',workDir:'/private/test/runtime',instanceId:'12345678-1234-1234-1234-123456789abc',project:'ours-test',services:['daemon','messenger']};
 await effects.serverUninstall(record);
 assert(calls.find(c=>c.includes('rm')&&c.at(-1)==='messenger'));
 assert(!calls.flat().some(v=>['up','volume','--volumes'].includes(v)));
 const count=calls.length;await assert.rejects(effects.serverUninstall({...record,buildTransition:{}}),/transitions/);assert.equal(calls.length,count);
});

for(const env of [{OURS_UNINSTALL:'hermes'},{OURS_UNINSTALL_DAEMON:'no'},{OURS_UNINSTALL_DATA:'yes'},{OURS_UNINSTALL_ROOMS:'detach'},{OURS_CONFIG:'/private/profile.json'}]) test(`managed uninstall refuses legacy keep/profile/component request ${Object.keys(env)[0]}`, async()=>{
 const {runUninstall}=await import('../lib/orchestrate-uninstall.mjs');let mutations=0;
 const effects={home:'/private/home',env,readJson:()=>({schema:2,mode:'docker'}),out:()=>{},withInstallationLock:()=>{mutations++;throw Error('should not mutate');}};
 assert.equal(await runUninstall(['--state-dir','/private/selected'],effects),2);assert.equal(mutations,0);
});

test('explicitly owned detached Cowork worker is killed after owner death and before replacement', async t=>{
 const f=fixture(t,{},false);const pids=join(f.dir,'detached-pids');
 const worker=`require('fs').appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');process.kill(process.pid,'SIGSTOP');setInterval(()=>{},1000)`;
 f.config.ownerPidEnvironment='OURS_COWORK_SUPERVISOR_PID';
 f.config.command=node(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:'inherit',env:{...process.env,OURS_COWORK_SUPERVISOR_PID:String(process.pid)}});require('fs').appendFileSync(${JSON.stringify(f.count)},'x');setTimeout(()=>process.exit(7),350);`);
 const proc=f.launch(f.config);await until(()=>read(f.count).length===4);await sleep(450);
 const live=pid=>{try{const stat=readFileSync('/proc/'+pid+'/stat','utf8');return !['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]);}catch{return false;}};
 assert(read(pids).trim().split('\n').every(pid=>!live(pid)),'no detached writer survives circuit exhaustion');await exhausted(proc);
});

// Fail health on demand, wait for the replacement, then restore health.
async function failOnce(f, launches) {
  rmSync(f.healthy); await until(() => read(f.count).length === launches);
  writeFileSync(f.healthy, 'yes');
}

test('continuous readiness restores the recovery budget, so spaced transient failures never strand the service', async t => {
  const f = fixture(t, { healthyResetMs: 400 });
  await until(() => read(f.count).length === 1);
  for (let launches = 2; launches <= 6; launches++) {
    await failOnce(f, launches);
    const restored = f.logs.text.split('budget restored').length;
    await until(() => f.logs.text.split('budget restored').length > restored);
  }
  assert.equal(f.proc.exitCode, null, 'five spaced recoveries do not exhaust a three-attempt budget');
  assert.match(f.logs.text, /health probe failed \(1\/2\): exit:1 after \d+ms/);
  await stop(f.proc);
});

test('without a healthy interval the same spaced failures exhaust the budget (negative control)', async t => {
  const f = fixture(t, { healthyResetMs: 60_000 });
  await until(() => read(f.count).length === 1);
  for (let launches = 2; launches <= 4; launches++) { await failOnce(f, launches); await sleep(300); }
  rmSync(f.healthy);
  await exhausted(f.proc);
  assert.equal(read(f.count).length, 4);
  assert.doesNotMatch(f.logs.text, /budget restored/);
});

test('a failed probe or a dependency outage breaks the readiness interval', async t => {
  const f = fixture(t, { healthyResetMs: 1_500, failures: 2 }, false);
  const probes = join(f.dir, 'probes');
  // Every fourth health probe fails, and the dependency is down at the same
  // moment: never two consecutive failures, never 1.5s of continuous readiness.
  f.config.health = node(`const fs=require('fs');const p=${JSON.stringify(probes)};const n=fs.existsSync(p)?fs.readFileSync(p,'utf8').length:0;fs.appendFileSync(p,'x');process.exit(n<2||n%4===3?1:0)`);
  f.config.dependency = node(`const fs=require('fs');const p=${JSON.stringify(probes)};const n=fs.existsSync(p)?fs.readFileSync(p,'utf8').length:0;process.exit(n>2&&(n-1)%4===3?1:0)`);
  const proc = f.launch(f.config);
  await until(() => read(f.count).length === 2);
  await sleep(3_000);
  assert(read(probes).length > 20, 'probes kept running');
  assert.equal(read(f.count).length, 2, 'isolated failures during a dependency outage do not recover');
  assert.doesNotMatch(f.logs.text, /budget restored/);
  await stop(proc);
});

test('probe diagnostics keep only allowlisted classifications', async t => {
  const f = fixture(t, { failures: 3 }, false);
  const probes = join(f.dir, 'probes');
  f.config.health = node(`const fs=require('fs');const p=${JSON.stringify(probes)};const n=fs.existsSync(p)?fs.readFileSync(p,'utf8').length:0;fs.appendFileSync(p,'x');
    if(n===0){console.log('OURS_PROBE readiness:auth');process.exit(1)}
    if(n===1){console.log('OURS_PROBE token:s3cr3t-value');console.log('Bearer s3cr3t-value');process.exit(3)}
    setInterval(()=>{},1000)`);
  const proc = f.launch(f.config);
  await until(() => read(f.count).length === 2);
  assert.match(f.logs.text, /\(1\/3\): readiness:auth after/);
  assert.match(f.logs.text, /\(2\/3\): exit:3 after/);
  assert.match(f.logs.text, /\(3\/3\): timeout after/);
  assert.doesNotMatch(f.logs.text, /s3cr3t/);
  await stop(proc);
});
