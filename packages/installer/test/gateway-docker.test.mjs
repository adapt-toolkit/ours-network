import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayCompose, gatewayNginx } from '../lib/gateway.mjs';

test('isolated gateway routes service prefixes and rejects forged-host legacy RPC', {skip: process.env.OURS_TEST_DOCKER !== '1', timeout:120000}, async t => {
  const root = mkdtempSync(join(tmpdir(),'ours-gateway-test-'));
  const project = `ours-gateway-test-${process.pid}`;
  const record = {project, instanceId:'11111111-2222-3333-4444-555555555555',port:0,coworkPort:3052};
  const docker = args => execFileSync('docker',args,{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});
  const compose = args => docker(['compose','-p',project,'--project-directory',root,'-f',join(root,'base.yaml'),'-f',join(root,'gateway.yaml'),...args]);
  t.after(()=>{try {compose(['down','--timeout','3','--remove-orphans']);} finally {try {docker(['image','rm',`${project}:gateway`]);} finally {rmSync(root,{recursive:true,force:true});}}});
  const fixture = `const http=require('http'); for(const port of [3050,3051,3052,8420]) http.createServer((q,s)=>{if(q.url==='/identities'&&q.headers['x-ours-api-token']!=='test-token'){s.writeHead(401);return s.end();}s.setHeader('content-type','application/json');s.end(JSON.stringify({path:q.url,port,token:q.headers['x-ours-api-token']}));}).listen(port,'0.0.0.0');`;
  writeFileSync(join(root,'server.cjs'),fixture);
  writeFileSync(join(root,'base.yaml'),`services:\n  daemon:\n    image: node:24\n    command: [node, /fixture/server.cjs]\n    volumes: ["${root}:/fixture:ro"]\n    ports: ["3050"]\n    networks:\n      ours:\n        aliases: [cowork, messenger, telegram]\n  telegram:\n    image: node:24\n  cowork:\n    image: node:24\n    ports: ["3052"]\n  messenger:\n    image: node:24\n    ports: ["8420"]\nnetworks:\n  ours: {}\n`);
  writeFileSync(join(root,'gateway.yaml'),gatewayCompose(record));
  writeFileSync(join(root,'nginx.conf'),gatewayNginx(record));
  cpSync(new URL('../assets/Dockerfile.gateway',import.meta.url),join(root,'Dockerfile.gateway'));
  const config = JSON.parse(compose(['config','--format','json']));
  assert.equal(config.services.daemon.ports,undefined);
  assert.equal(config.services.cowork.ports,undefined);
  assert.equal(config.services.messenger.ports,undefined);
  assert.equal(config.services.gateway.ports.length,1);
  try { compose(['up','-d','--build','--wait','daemon','gateway']); }
  catch (error) { throw new Error(compose(['logs','--no-color','gateway']), {cause:error}); }
  const clientScript = `const assert=require('assert/strict');(async()=>{const r=await fetch('http://gateway:8080/cowork/rpc',{method:'POST',headers:{Host:'localhost:3052'},body:'{}'});assert.equal(r.status,403);const d=await fetch('http://gateway:8080/.well-known/ours').then(r=>r.json());assert.equal(d.instanceId,'${record.instanceId}');for(const [prefix,port] of [['daemon',3050],['cowork',3052],['messenger',8420]]){const data=await fetch('http://gateway:8080/'+prefix+'/hello?x=1').then(r=>r.json());assert.equal(data.path,'/hello?x=1');assert.equal(data.port,port);}assert.equal((await fetch('http://gateway:8080/tg-connector/status')).status,401);const tg=await fetch('http://gateway:8080/tg-connector/status',{headers:{'x-ours-api-token':'test-token'}}).then(r=>r.json());assert.equal(tg.port,3051);assert.equal(tg.path,'/status');})().catch(e=>{console.error(e);process.exit(1)});`;
  docker(['run','--rm','--network',`${project}_ours`,'node:24','-e',clientScript]);
});
