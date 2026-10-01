import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {selectServerPorts} from '../lib/server-ports.mjs';
import {__testables} from '../lib/effects.mjs';
test('fresh server avoids occupied daemon port and reserved peer ports',async()=>{
 const occupied=createServer();occupied.listen(0,'127.0.0.1');await once(occupied,'listening');
 const port=occupied.address().port;
 try {
   const record={port,coworkPort:3052,messengerPort:8420};
   selectServerPorts(record,__testables.portTakenSync);assert.notEqual(record.port,port);assert.equal(occupied.listening,true);
   assert.equal(__testables.portTakenSync(record.port),false);
   const collision={port:3050,coworkPort:3052,messengerPort:8420};selectServerPorts(collision,n=>n===3050);assert.equal(collision.port,3052);assert.equal(collision.coworkPort,3053);
   assert.throws(()=>selectServerPorts({port,coworkPort:3052,messengerPort:8420},__testables.portTakenSync,['port']),/unavailable/);
 } finally {await new Promise(resolve=>occupied.close(resolve));}
});

test('fresh preflight persists selected ports into configuration, gateway and lifecycle; retry retains them',async()=>{
 const {realEffects}=await import('../lib/effects.mjs');
 const {gatewayAddress,gatewayCompose,validateGatewayDiscovery,GATEWAY_SERVICES}=await import('../lib/gateway.mjs');
 const {mkdtempSync,readFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'installer-selected-ports-'));
 const occupied=createServer();occupied.listen(0,'127.0.0.1');await once(occupied,'listening');
 const effects=realEffects({env:{},out:()=>{}}),calls=[];
 // Prerequisite/lifecycle commands are recorded; no container or service is started.
 effects.run=async(command,args,options={})=>{calls.push({command,args,options});return {code:0,stdout:args.includes('version')?'2.35.0':''};};
 const manifest={packages:Object.fromEntries(['sdk','cli','daemon','tg-connector','cowork','messenger-server'].map(name=>['@ours.network/'+name,{type:'npm',version:'1.2.3'}]))};
 try{
  const record=effects.newInstallation(root,'docker');record.port=occupied.address().port;
  await effects.serverPreflight(record,'install',{sourceManifest:manifest});
  assert.notEqual(record.port,occupied.address().port);assert.equal(occupied.listening,true);
  await effects.initializeSelection(record,manifest);
  effects.writeJson(join(root,'installation.json'),JSON.stringify(record));
  const saved=JSON.parse(readFileSync(join(root,'installation.json'),'utf8'));
  assert.equal(JSON.parse(readFileSync(saved.configPath,'utf8')).port,saved.port);
  assert.match(gatewayCompose(saved),new RegExp('published: "'+saved.port+'"'));
  const address=gatewayAddress(saved);
  assert.equal(address.base,'http://127.0.0.1:'+saved.port);
  const profile=validateGatewayDiscovery({schema:1,instanceId:saved.instanceId,capabilities:['ours.gateway-v1','cowork.http-management-v1'],services:GATEWAY_SERVICES},address.base,join(root,'client-credential'));
  assert.equal(profile.endpoint,address.base+'/daemon');assert.equal(profile.expectedInstanceId,saved.instanceId);
  await effects.serverLifecycle(saved,'stop',['daemon']);
  assert.ok(calls.some(call=>call.options.env?.OURS_HOST_PORT===String(saved.port) && call.options.env.OURS_COWORK_PORT===String(saved.coworkPort) && call.options.env.OURS_MESSENGER_PORT===String(saved.messengerPort)));
  await effects.serverPreflight(saved,'install',{existing:true,sourceManifest:manifest});
  assert.deepEqual(saved,record);assert.equal(occupied.listening,true);
  const count=calls.length,explicit={...record,port:occupied.address().port};
  await assert.rejects(effects.serverPreflight(explicit,'install',{sourceManifest:manifest,explicitPorts:['port']}),/unavailable/);
  assert.equal(calls.length,count);assert.equal(occupied.listening,true);
 }finally{await new Promise(resolve=>occupied.close(resolve));rmSync(root,{recursive:true,force:true});}
});
