import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayCompose, gatewayNginx } from '../lib/gateway.mjs';

for (const prefix of ['', '/nested/ours']) test(`gateway ${prefix || '/'} routes, auth, WebSocket and DNS refresh`, {skip: process.env.OURS_TEST_DOCKER !== '1' && process.env.OURS_TEST_PODMAN !== '1', timeout:180000}, async t => {
  const root = mkdtempSync(join(tmpdir(),'ours-gateway-test-'));
  const project = `ours-gateway-test-${process.pid}-${prefix ? 'nested' : 'root'}`;
  const record = {project, instanceId:'11111111-2222-3333-4444-555555555555',port:0,coworkPort:3052,gateway:{serverUrl:'http://localhost'+prefix}};
  const engine = process.env.OURS_TEST_PODMAN === '1' ? 'podman' : 'docker';
  const docker = args => execFileSync(engine,engine === 'podman' && args[0] === 'compose' && process.env.OURS_PODMAN_SOCKET ? ['--remote','--url','unix://'+process.env.OURS_PODMAN_SOCKET,...args] : args,{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});
  const compose = args => docker(['compose','-p',project,'--project-directory',root,'-f',join(root,'base.yaml'),'-f',join(root,'gateway.yaml'),...args]);
  t.after(()=>{try {docker(['rm','-f',project+'-old-ip']);} catch {} });
  t.after(()=>{try {compose(['down','--timeout','3','--remove-orphans']);} finally {try {docker(['image','rm',`${project}:gateway`]);} finally {rmSync(root,{recursive:true,force:true});}}});
  const fixture = `const http=require('http'); for(const port of [3050,3051,3052,8420]) http.createServer((q,s)=>{if(q.url==='/identities'&&q.headers['x-ours-api-token']!=='test-token'){s.writeHead(401);return s.end();}s.setHeader('content-type','application/json');s.end(JSON.stringify({path:q.url,port,token:q.headers['x-ours-api-token']}));}).on('upgrade',(q,s)=>{if(q.url!=='/ws')return s.destroy();const accept=require('crypto').createHash('sha1').update(q.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');s.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');s.end();}).listen(port,'0.0.0.0');`;
  writeFileSync(join(root,'server.cjs'),fixture);
  writeFileSync(join(root,'base.yaml'),`services:\n  daemon:\n    image: node:24\n    command: [node, /fixture/server.cjs]\n    volumes: ["${root}:/fixture:ro,z"]\n    ports: ["3050"]\n    networks:\n      ours:\n        aliases: [cowork, messenger, telegram]\n  telegram:\n    image: node:24\n  cowork:\n    image: node:24\n    ports: ["3052"]\n  messenger:\n    image: node:24\n    ports: ["8420"]\nnetworks:\n  ours: {}\n`);
  writeFileSync(join(root,'gateway.yaml'),gatewayCompose(record));
  writeFileSync(join(root,'nginx.conf'),gatewayNginx(record));
  cpSync(new URL('../assets/Dockerfile.gateway',import.meta.url),join(root,'Dockerfile.gateway'));
  cpSync(new URL('../assets/gateway-entrypoint.sh',import.meta.url),join(root,'gateway-entrypoint.sh'));
  const config = JSON.parse(compose(['config','--format','json']));
  assert.equal(config.services.daemon.ports,undefined);
  assert.equal(config.services.cowork.ports,undefined);
  assert.equal(config.services.messenger.ports,undefined);
  assert.equal(config.services.gateway.ports.length,1);
  if (engine === 'podman') docker(['build', '-f', join(root,'Dockerfile.gateway'), '-t', `${project}:gateway`, root]);
  try { compose(['up','-d',engine === 'podman' ? '--no-build' : '--build','--wait','daemon','gateway']); }
  catch (error) { throw new Error(compose(['logs','--no-color','gateway']), {cause:error}); }
  const clientScript = `const assert=require('assert/strict');(async()=>{const r=await fetch('http://gateway:8080${prefix}/cowork/rpc',{method:'POST',headers:{Host:'localhost:3052'},body:'{}'});assert.equal(r.status,403);const d=await fetch('http://gateway:8080${prefix}/.well-known/ours').then(r=>r.json());assert.equal(d.instanceId,'${record.instanceId}');for(const [prefix,port] of [['daemon',3050],['cowork',3052],['messenger',8420]]){const data=await fetch('http://gateway:8080${prefix}/'+prefix+'/hello?x=1').then(r=>r.json());assert.equal(data.path,'/hello?x=1');assert.equal(data.port,port);}assert.equal((await fetch('http://gateway:8080${prefix}/tg-connector/status')).status,401);const tg=await fetch('http://gateway:8080${prefix}/tg-connector/status',{headers:{'x-ours-api-token':'test-token'}}).then(r=>r.json());assert.equal(tg.port,3051);assert.equal(tg.path,'/status');await new Promise((resolve,reject)=>{const ws=new WebSocket('ws://gateway:8080${prefix}/daemon/ws');ws.onopen=()=>{ws.close();resolve()};ws.onerror=reject;});process.exit(0);})().catch(e=>{console.error(e);process.exit(1)});`;
  const client = () => docker(['run','--rm','--network',`${project}_ours`,'node:24','-e',clientScript]);
  client();
  const id = compose(['ps','-q','daemon']).trim();
  const before = Object.values(JSON.parse(docker(['inspect',id]))[0].NetworkSettings.Networks)[0].IPAddress;
  compose(['rm','-s','-f','daemon']);
  docker(['run','-d','--name',project+'-old-ip','--network',`${project}_ours`,'--ip',before,'node:24','sleep','120']);
  compose(['up','-d','--no-build','--wait','daemon']);
  const after = Object.values(JSON.parse(docker(['inspect',compose(['ps','-q','daemon']).trim()]))[0].NetworkSettings.Networks)[0].IPAddress;
  assert.notEqual(after,before);
  let failure;
  for(let attempt=0;attempt<10;attempt++){
    try {client();failure=null;break;} catch(error){failure=error;await new Promise(resolve=>setTimeout(resolve,1000));}
  }
  if(failure)throw failure;
});
