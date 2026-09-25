import test from 'node:test';
import assert from 'node:assert/strict';
import { engineName, validateContainerEngine, runContainer, nativeBuildCommands, namespaceDigest } from '../lib/container-engine.mjs';
import { parseSetupArgs } from '../lib/setup-options.mjs';
import { parseNetworkArgs } from '../lib/target.mjs';
const maps={uidmap:[{container_id:0,host_id:process.getuid(),size:1}],gidmap:[{container_id:0,host_id:process.getgid(),size:1}]};
const record = { mode: 'docker', containerEngine: 'podman', containerBinding: { version: 1, namespaceDigest: namespaceDigest({host:{idMappings:maps}}), uid: process.getuid(), graphRoot: '/store', runRoot: '/run/store', socket: '/run/podman.sock', driver: 'overlay', provider: '/bin/docker-compose' } };
test('legacy Docker commands retain executable, arguments and environment', async () => {
  const calls=[]; const e={run:async(...args)=>calls.push(args)};
  const options={env:{X:'Y'}};
  await runContainer(e,{mode:'docker'},['volume','ls'],options);
  assert.equal(engineName({}),'docker');
  assert.deepEqual(calls,[['docker',['volume','ls'],options]]);
});
test('Podman pins local store and provider without a Docker executable', async () => {
  let call; const e={env:{},run:async(...args)=>{call=args;return {code:0,stdout:''}}};
  await runContainer(e,record,['compose','up','--no-build'],{env:{OURS_DAEMON_ID:'example'}});
  assert.equal(call[0],'podman');assert.deepEqual(call[1].slice(0,3),['--remote','--url','unix:///run/podman.sock']);
  assert.equal(call[2].env.DOCKER_HOST,'unix:///run/podman.sock');
  assert.equal(call[2].env.PODMAN_COMPOSE_PROVIDER,'/bin/docker-compose');
  assert.equal(call[2].env.OURS_DAEMON_ID,'example');
});
test('backend conflicts and another rootless owner fail before execution',async()=>{
  for(const env of [{DOCKER_HOST:'unix:///other'},{DOCKER_CONTEXT:'other'},{CONTAINER_CONNECTION:'other'},{PODMAN_USERNS:'keep-id'},{PODMAN_COMPOSE_PROVIDER:'/bin/podman-compose'},{CONTAINERS_STORAGE_CONF:'/other'}]){
    let ran=false;await assert.rejects(runContainer({env,run:()=>{ran=true}},record,['rm','x']),/conflict/i);assert.equal(ran,false);
  }
  await assert.rejects(runContainer({env:{}},{...record,containerBinding:{...record.containerBinding,uid:record.containerBinding.uid+1}},['ps']),/another rootless owner/);
  assert.throws(()=>validateContainerEngine({...record,mode:'packages'}));
  assert.throws(()=>validateContainerEngine({...record,containerBinding:{...record.containerBinding,provider:'compose'}}));
});
test('missing inspect is normalized only after exact native existence check',async()=>{
  const calls=[];const e={env:{},run:async(cmd,args)=>{calls.push(args);return {code:1,stdout:''}}};
  assert.equal((await runContainer(e,record,['image','inspect','test:missing'],{allowCodes:[1]})).code,1);
  assert.deepEqual(calls[0].slice(-3),['image','exists','test:missing']);
  const denied={env:{},run:async()=>{throw Error('permission denied')}};
  await assert.rejects(runContainer(denied,record,['volume','inspect','volume'],{allowCodes:[1]}),/permission denied/);
});
test('native build retains platform, targets and secret reference, never value',()=>{
  const config={services:{daemon:{image:'ours:runtime',platform:'linux/amd64',build:{context:'/build',dockerfile:'Dockerfile',target:'runtime',args:{VERSION:'1'},secrets:[{source:'token',target:'github_token'}]}}},secrets:{token:{environment:'TOKEN'}}};
  const [args]=nativeBuildCommands(config,['daemon'],{TOKEN:'synthetic-secret'});
  assert.ok(args.includes('linux/amd64')); assert.ok(args.includes('runtime'));assert.ok(args.includes('id=github_token,type=env,env=TOKEN'));assert.ok(!JSON.stringify(args).includes('synthetic-secret'));
  config.services.daemon.build.ssh=['default'];assert.throws(()=>nativeBuildCommands(config,['daemon']),/Unsupported/);
});
test('engine is accepted on both command paths and rejected for native/client installs',()=>{
  const args=['--mode','docker','--container-engine','podman','--state-dir','/tmp/server'];
  assert.equal(parseNetworkArgs(['server','install',...args]).containerEngine,'podman');
  assert.equal(parseSetupArgs(['server','install',...args,'--identity-name','Test']).containerEngine,'podman');
  assert.throws(()=>parseSetupArgs(['server','install','--mode','packages','--container-engine','podman','--state-dir','/tmp/server','--identity-name','Test']),/container-engine/);
  assert.throws(()=>parseNetworkArgs(['server','install',...args.slice(0,2),'--container-engine','other','--state-dir','/tmp/server']),/container-engine/);
});
test('native image IDs are normalized at the adapter boundary',async()=>{
 const id='a'.repeat(64);
 const result=await runContainer({env:{},run:async()=>({code:0,stdout:JSON.stringify([{Id:id,Config:{Labels:{test:'value'}}}])})},record,['image','inspect','ours:runtime']);
 assert.deepEqual(JSON.parse(result.stdout),[{Id:'sha256:'+id,Config:{Labels:{test:'value'}}}]);
});
test('foreign Podman volumes are rejected before compose can write them',async()=>{
 const {realEffects}=await import('../lib/effects.mjs');
 const e=realEffects({env:{}});const calls=[];
 e.run=async(cmd,args)=>{
  calls.push(args);
  if(args.includes('config'))return {code:0,stdout:JSON.stringify({volumes:{'server-storage':{name:'ours-test_server-storage'}}})};
  if(args.includes('exists'))return {code:0,stdout:''};
  if(args.includes('inspect'))return {code:0,stdout:JSON.stringify({Name:'ours-test_server-storage',Labels:{'com.docker.compose.project':'foreign','com.docker.compose.volume':'server-storage'}})};
  throw Error('unexpected command');
 };
 await assert.rejects(e.serverAccess({...record,project:'ours-test',workDir:'/runtime'},'access-init'),/foreign volume/);
 assert.ok(!calls.some(args=>args.includes('run')));
});
test('stop/status do not require healthy boot services or linger',async()=>{
 const {realEffects}=await import('../lib/effects.mjs');
 const e=realEffects({env:{}});const calls=[];
 const selected={...record,containerBinding:{...record.containerBinding,socket:`/run/user/${process.getuid()}/podman/podman.sock`}};
 const info={host:{idMappings:maps,security:{rootless:true},remoteSocket:{path:selected.containerBinding.socket}},store:{graphRoot:'/store',runRoot:'/run/store',graphDriverName:'overlay'}};
 e.run=async(cmd,args)=>{
  calls.push([cmd,...args]);
  if(cmd==='podman'&&args.includes('info'))return {code:0,stdout:JSON.stringify(info)};
  if(cmd==='/bin/docker-compose')return {code:0,stdout:'5.5.1'};
  if(cmd==='podman'&&args.includes('ps'))return {code:0,stdout:''};
  throw Error('boot unavailable');
 };
 for(const operation of ['stop','status'])await e.serverPreflight({...selected,project:'ours-test'},operation,{existing:false});
 assert.ok(!calls.some(args=>args[0]==='systemctl'||args[0]==='loginctl'));
 await assert.rejects(e.serverPreflight({...selected,project:'ours-test'},'start',{existing:false}),/boot unavailable/);
});

test('partial service restoration does not require intentionally stopped gateway backends',async()=>{
 const {realEffects}=await import('../lib/effects.mjs');
 const e=realEffects({env:{}});const starts=[];let verified=0;
 e.out=()=>{};
 e.run=async(cmd,args)=>{if(args.includes('up'))starts.push(args.at(-1));return {code:0,stdout:''}};
 e.verifyGateway=async()=>{verified++};
 const selected={mode:'docker',project:'ours-test',workDir:'/runtime',gateway:{},services:['daemon','cowork','gateway']};
 await e.serverLifecycle(selected,'start',['daemon','gateway']);
 assert.deepEqual(starts,['daemon','gateway']);assert.equal(verified,0);
 await e.serverLifecycle(selected,'start');assert.equal(verified,1);
});
test('missing administration images are built natively before Compose run',async()=>{
 const {realEffects}=await import('../lib/effects.mjs');
 const e=realEffects({env:{}});const calls=[];
 e.run=async(cmd,args)=>{
  calls.push(args);
  if(args.includes('config')){assert.ok(args.includes('--profile')&&args.includes('*'));return {code:0,stdout:JSON.stringify({services:{access:{image:'ours:maintenance',build:{context:'/build',target:'maintenance'}}}})};}
  if(args.includes('exists'))return {code:1,stdout:''};
  return {code:0,stdout:''};
 };
 await e.serverAccess({...record,project:'ours-test',workDir:'/runtime'},'access-init');
 const build=calls.findIndex(args=>args.includes('build'));
 const run=calls.findIndex(args=>args.includes('run'));
 assert.ok(build>=0&&run>build);assert.ok(calls[build].includes('maintenance'));
 assert.ok(!calls[build].includes('compose'));
});
test('namespace bindings reject subordinate UID/GID mapping changes',async()=>{
 const {bindPodman}=await import('../lib/container-engine.mjs');
 const info={host:{idMappings:{...maps,uidmap:[{container_id:0,host_id:process.getuid()+1,size:1}]},security:{rootless:true}},store:{graphRoot:'/store',runRoot:'/run/store',graphDriverName:'overlay'}};
 const e={env:{},platform:{platform:'linux'},run:async()=>({code:0,stdout:JSON.stringify(info)})};
 await assert.rejects(bindPodman(e,structuredClone(record)),/backend differs/);
 assert.throws(()=>namespaceDigest({host:{}}),/mappings are unavailable/);
});
test('repair and conversion native builds retain Docker image format',async()=>{
 let actual;const e={env:{},run:async(cmd,args)=>{actual=args;return {code:0,stdout:''}}};
 await runContainer(e,record,['build','--network=none','--tag','ours:repair','/build']);
 assert.deepEqual(actual.slice(actual.indexOf('build'),actual.indexOf('build')+3),['build','--format','docker']);
});
