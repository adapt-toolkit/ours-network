import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWorkspacePayload,extractWorkspaceArgs } from '../lib/workspace-setup.mjs';
const now=Date.now(),payload={version:1,appOrigin:'https://app.ours.network',hostname:'alice-home.ours-tunnel.com',rootName:'alice@home',name:'Alice',surname:'Tester',connectorToken:'scoped-fixture',invitation:'fixture-invite',serverCid:'a'.repeat(64),challenge:{accountId:'a'.repeat(43),workspaceId:'w'.repeat(43),nonce:'n'.repeat(43),expiresAt:now+600000}};
const encode=p=>Buffer.from(JSON.stringify(p)).toString('base64url');
test('private workspace transport validates boundaries, expiry and rejects broad management fields',()=>{
 assert.equal(decodeWorkspacePayload(encode(payload),now).rootName,'alice@home');
 assert.equal(decodeWorkspacePayload(encode({...payload,appOrigin:'https://app.ours-tunnel.com'}),now).appOrigin,'https://app.ours-tunnel.com');
 for(const appOrigin of ['http://app.ours-tunnel.com','https://app.ours-tunnel.com:443','https://app.ours-tunnel.com/','https://app.ours-tunnel.com.attacker.invalid','https://user@app.ours-tunnel.com'])assert.throws(()=>decodeWorkspacePayload(encode({...payload,appOrigin}),now));
 for(const patch of [{appOrigin:'https://attacker.invalid'},{hostname:'attacker.invalid'},{cloudflareApiToken:'never-accept'},{challenge:{...payload.challenge,expiresAt:now}},{connectorToken:'token\nlog'}])assert.throws(()=>decodeWorkspacePayload(encode({...payload,...patch}),now));
 assert.deepEqual(extractWorkspaceArgs(['--setup-workspace','-','--mode','docker','--workspace-fleet-bin=/fixture/fleet']).rest,['--mode','docker']);
 assert.throws(()=>extractWorkspaceArgs(['--setup-workspace','abc','--setup-workspace-file','file']));
});

test('automatic existing host preserves non-default gateway selection and Fleet config', async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');
 const {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'workspace-existing-'));const calls=[];let payloadPath;
 const config=join(home,'fleet.yaml');writeFileSync(config,'retained models and agents');
 const original=readFileSync(config),profile={endpoint:'https://existing.invalid/non-default/daemon'};
 const effects={home,env:{OURS_DAEMON_URL:'http://unrelated'},out(){},readManagedClientProfile:()=>profile,async run(bin,args,options){calls.push({bin,args,options});if(args[0]==='workspace-enroll' && args.includes('--file')){payloadPath=args[args.indexOf('--file')+1];assert.equal(readFileSync(payloadPath,'utf8'),encode(payload));}return {ok:true,stdout:JSON.stringify({capabilities:['workspace.enroll.preserve-profile-v1']})};},async runInteractive(){throw Error('existing config must not be initialized');}};
 try{
  assert.equal(await runWorkspaceSetup(['--setup-workspace',encode(payload),'--fleet-settings=/private/settings','--workspace-migrate-app-origin'],effects,async()=>{throw Error('existing host must not reinstall/create root');}),0);
  assert.equal(calls.some(call=>call.args[0]==='init'),false);assert.deepEqual(readFileSync(config),original);
  const enrollment=calls.find(call=>call.args.includes('--file'));assert.equal(enrollment.options.env.OURS_CONFIG,join(home,'.ours-client','profile.json'));assert.equal(enrollment.options.env.OURS_DAEMON_URL,undefined);assert.ok(enrollment.args.includes('--preserve-profile'));assert.ok(enrollment.args.includes('--migrate-app-origin'));assert.equal(existsSync(payloadPath),false);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('explicit existing profile is retained and older Fleet fails before any setup',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');let setup=0;const calls=[];
 const effects={home:'/fixture',env:{OURS_CONFIG:'/non-default/profile.json'},readManagedClientProfile:()=>null,out(){},async run(bin,args){calls.push(args);return {ok:true,stdout:JSON.stringify({capabilities:[]})};}};
 await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode(payload)],effects,async()=>{setup++;return 0;}),/profile-preserving Fleet/);assert.equal(setup,0);assert.deepEqual(calls,[['version','--json']]);
});
test('workspace dry run performs no enrollment or Fleet init',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');const calls=[];
 const effects={home:'/fixture',out(){},async run(bin,args){calls.push(args);return {ok:true};}};
 assert.equal(await runWorkspaceSetup(['--setup-workspace',encode(payload),'--dry-run'],effects,async options=>{assert.ok(options.includes('--identity-name'));return 0;}),0);
 assert.deepEqual(calls,[['workspace-enroll','--help'],['--version']]);
});
