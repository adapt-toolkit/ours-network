import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHostProfile } from '../lib/target.mjs';
import { gatewayDiscovery, validateGatewayDiscovery, gatewayCompose, gatewayNginx } from '../lib/gateway.mjs';
const record={instanceId:'11111111-2222-3333-4444-555555555555',project:'ours-test',port:3050,coworkPort:3052};
test('gateway profile derives one daemon prefix and rejects cross-server discovery',()=>{
  const discovery=gatewayDiscovery(record);
  const profile=validateGatewayDiscovery('https://example.test/base/',discovery,'/private/token');
  assert.deepEqual(profile,{serverUrl:'https://example.test/base',endpoint:'https://example.test/base/daemon',expectedInstanceId:record.instanceId,credentialPath:'/private/token'});
  assert.deepEqual(validateHostProfile(profile),profile);
  assert.throws(()=>validateGatewayDiscovery('https://example.test', {...discovery,services:{...discovery.services,cowork:'https://evil.test'}},'/private/token'));
  assert.throws(()=>validateHostProfile({...profile,endpoint:'https://other.test/daemon'}));
});
test('legacy direct profiles remain unchanged',()=>{
 const profile={endpoint:'http://localhost:3050',expectedInstanceId:record.instanceId,credentialPath:'/private/token'};
 assert.deepEqual(validateHostProfile(profile),profile);
});

test('new Docker selections include gateway while existing and native selections retain layout', async t => {
  const {realEffects} = await import('../lib/effects.mjs');
  const {validateInstallation} = await import('../lib/plan.mjs');
  const {mkdtempSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const home=mkdtempSync(join(tmpdir(),'ours-gateway-selection-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const effects=realEffects({home,env:{}});
  const docker=effects.newInstallation(join(home,'docker'),'docker');
  assert.deepEqual(docker.gateway,{version:1});
  assert.deepEqual(docker.services,['daemon','telegram','cowork','messenger','gateway']);
  assert.doesNotThrow(()=>validateInstallation(docker,docker.root));
  const native=effects.newInstallation(join(home,'native'),'packages');
  assert.equal(native.gateway,undefined);
  assert.equal(native.services.includes('gateway'),false);
  const legacy={...docker,services:docker.services.filter(s=>s!=='gateway')};delete legacy.gateway;
  assert.doesNotThrow(()=>validateInstallation(legacy,legacy.root));
  assert.throws(()=>validateInstallation({...native,gateway:{version:1}},native.root));
});
