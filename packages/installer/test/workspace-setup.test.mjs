import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWorkspacePayload,extractWorkspaceArgs } from '../lib/workspace-setup.mjs';
const now=Date.now(),payload={version:1,appOrigin:'https://app.ours.network',hostname:'alice-home.ours-tunnel.com',rootName:'alice@home',name:'Alice',surname:'Tester',connectorToken:'scoped-fixture',invitation:'fixture-invite',serverCid:'a'.repeat(64),challenge:{accountId:'a'.repeat(43),workspaceId:'w'.repeat(43),nonce:'n'.repeat(43),expiresAt:now+600000}};
const encode=p=>Buffer.from(JSON.stringify(p)).toString('base64url');
test('private workspace transport validates boundaries, expiry and rejects broad management fields',()=>{
 assert.equal(decodeWorkspacePayload(encode(payload),now).rootName,'alice@home');
 for(const patch of [{appOrigin:'https://attacker.invalid'},{hostname:'attacker.invalid'},{cloudflareApiToken:'never-accept'},{challenge:{...payload.challenge,expiresAt:now}},{connectorToken:'token\nlog'}])assert.throws(()=>decodeWorkspacePayload(encode({...payload,...patch}),now));
 assert.deepEqual(extractWorkspaceArgs(['--setup-workspace','-','--mode','docker','--workspace-fleet-bin=/fixture/fleet']).rest,['--mode','docker']);
 assert.throws(()=>extractWorkspaceArgs(['--setup-workspace','abc','--setup-workspace-file','file']));
});

test('existing-client workspace setup preserves selection and clears inherited daemon selectors', async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');
 const {mkdtempSync,readFileSync,existsSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'workspace-existing-'));const calls=[];let setupOptions,payloadPath;
 const effects={home,env:{OURS_CONFIG:'/unrelated/profile',OURS_DAEMON_URL:'http://unrelated'},out(){},readManagedClientProfile:()=>({serverUrl:'https://existing.invalid'}),async run(bin,args,options){calls.push({bin,args,options});if(args[0]==='workspace-enroll' && args.includes('--file')){payloadPath=args.at(-1);assert.equal(readFileSync(payloadPath,'utf8'),encode(payload));}return {ok:true};},async runInteractive(){throw Error('settings should avoid interactive init');}};
 try{
  assert.equal(await runWorkspaceSetup(['--setup-workspace',encode(payload),'--scope=client','--config=/private/network-profile','--fleet-settings=/private/settings'],effects,async options=>{setupOptions=options;return 0;}),0);
  assert.ok(setupOptions.includes('--scope=client'));assert.ok(!setupOptions.includes('--identity-name'));assert.deepEqual(setupOptions.slice(-2),['--integrations','none']);
  const enrollment=calls.find(call=>call.args.includes('--file'));assert.equal(enrollment.options.env.OURS_CONFIG,join(home,'.ours-client','profile.json'));assert.equal(enrollment.options.env.OURS_DAEMON_URL,undefined);assert.equal(enrollment.options.sensitive,true);assert.equal(existsSync(payloadPath),false);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('workspace dry run performs no enrollment or Fleet init',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');const calls=[];
 const effects={home:'/fixture',out(){},async run(bin,args){calls.push(args);return {ok:true};}};
 assert.equal(await runWorkspaceSetup(['--setup-workspace',encode(payload),'--dry-run'],effects,async options=>{assert.ok(options.includes('--identity-name'));return 0;}),0);
 assert.deepEqual(calls,[['workspace-enroll','--help'],['--version']]);
});
