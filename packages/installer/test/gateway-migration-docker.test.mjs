// Real Compose lifecycle and routing rollback; service state/API payloads are
// fixtures. gateway-services.test.mjs independently qualifies the real services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realEffects } from '../lib/effects.mjs';
import { enableGateway } from '../lib/gateway-transition.mjs';

test('Docker gateway cutover failure restores actual legacy ports, then migration and rerun succeed', { skip: process.env.OURS_TEST_DOCKER !== '1', timeout: 120000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'ours-gateway-migrate-'));
  const effects = realEffects({ home, env: { ...process.env }, out() {} });
  const root = join(home, 'installation'); mkdirSync(root, { mode: 0o700 });
  const record = effects.newInstallation(root, 'docker'); delete record.gateway; record.services = record.services.filter(name => name !== 'gateway');
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); record.port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  mkdirSync(record.workDir, { mode: 0o700 });
  mkdirSync(join(home, '.ours-client'), { mode: 0o700 });
  const credentialPath = join(home, '.ours-client', 'credential');
  writeFileSync(credentialPath, 'fixture-issued', { mode: 0o600 });
  const profilePath = join(home, '.ours-client', 'profile.json');
  const profile = { endpoint: `http://127.0.0.1:${record.port}`, expectedInstanceId: record.instanceId, credentialPath, installer: { integrations: ['fleet'] } };
  writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600 });
  writeFileSync(join(root, 'installation.json'), JSON.stringify(record), { mode: 0o600 });
  const fixtureDir = join(root, 'fixture'); mkdirSync(fixtureDir, { mode: 0o755 });
  writeFileSync(join(fixtureDir, 'daemon-token'), 'fixture-issued', { mode: 0o644 });
  writeFileSync(join(fixtureDir, 'server.cjs'), `const http=require('http');http.createServer((q,s)=>{
    s.setHeader('content-type','application/json');
    if(q.url==='/selection')return s.end(JSON.stringify({schema:1,instanceId:${JSON.stringify(record.instanceId)},capabilities:['external-sessions-v1']}));
    if(q.headers['x-ours-api-token']!=='fixture-issued'){s.writeHead(401);return s.end('{}');}
    if(q.url==='/identities')return s.end('{"identities":[]}');
    if(q.url==='/management/rpc'){let b='';q.on('data',c=>b+=c);q.on('end',()=>s.end(JSON.stringify({version:1,id:JSON.parse(b).id,result:[]})));return;}
    s.end('{}');}).listen(Number(process.env.PORT),'0.0.0.0');`, { mode: 0o644 });
  const services = [['daemon',3050],['telegram',3051],['cowork',3052],['messenger',8420]];
  const composePath = join(record.workDir, 'docker-compose.yaml');
  writeFileSync(composePath, 'services:\n' + services.map(([name,port]) => `  ${name}:
    image: node:24
    command: [node, /var/lib/ours/server.cjs]
    environment: { PORT: "${port}" }
    labels: { fixture-preserve: "yes" }
    volumes: ["${fixtureDir}:/var/lib/ours:ro"]
    networks: [ours]
    ports:
      - { target: ${port}, published: "${name==='daemon'?record.port:0}", host_ip: "127.0.0.1" }
`).join('') + 'networks:\n  ours: {}\n', { mode: 0o600 });
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  const compose = args => docker(['compose','-p',record.project,'-f',composePath,...args]);
  t.after(() => {
    try { compose(['down','--timeout','2','--remove-orphans']); }
    finally { try { docker(['image','rm',`${record.project}:gateway`]); } catch {} rmSync(home,{recursive:true,force:true}); }
  });
  // Capability behavior has separate negative/positive artifact tests; this
  // fixture deliberately supplies protocol servers instead of released images.
  effects.qualifyInstalledGatewayClient = async () => {};
  effects.qualifyGatewayRuntime = async () => {};
  await effects.serverLifecycle(record, 'start');
  const originalCompose = readFileSync(composePath), originalProfile = readFileSync(profilePath);
  const verify = effects.verifyGateway;
  effects.verifyGateway = async candidate => { await verify(candidate); throw new Error('injected post-readiness failure'); };
  await assert.rejects(enableGateway(record, {}, effects), /previous routing/);
  assert.deepEqual(readFileSync(composePath), originalCompose);
  assert.deepEqual(readFileSync(profilePath), originalProfile);
  assert.equal((await fetch(profile.endpoint+'/selection')).status, 200);
  assert.deepEqual((await effects.serverLifecycle(record,'status')).sort(), record.services.slice().sort());
  effects.verifyGateway = verify;
  const candidate = await enableGateway(record, {}, effects);
  await verify(candidate);
  const selected = JSON.parse(readFileSync(profilePath));
  assert.equal(selected.endpoint, profile.endpoint+'/daemon');
  assert.equal(selected.credentialPath, credentialPath);
  assert.equal(readFileSync(credentialPath,'utf8'),'fixture-issued');
  assert.equal((await fetch(profile.endpoint+'/selection')).status,404);
  assert.equal((await fetch(selected.endpoint+'/selection')).status,200);
  for (const service of record.services) {
    const id = compose(['ps','-q',service]).trim();
    const inspect = JSON.parse(docker(['inspect',id]))[0];
    assert.deepEqual(inspect.HostConfig.PortBindings,{});
    assert.equal(inspect.Config.Labels['fixture-preserve'],'yes');
  }
  await enableGateway(candidate, {}, effects);
});
