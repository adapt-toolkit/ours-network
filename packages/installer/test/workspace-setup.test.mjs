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
test('fresh setup failure resumes same workspace without a second root and still applies account name',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');const {mkdtempSync,writeFileSync,existsSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'workspace-retry-'));let selected=null,roots=0,attempts=0;const enrollment=[];
 const effects={home,env:{},out(){},readManagedClientProfile:()=>selected,async run(bin,args){if(args[0]==='init'){writeFileSync(join(home,'fleet.yaml'),'retained fresh config');return {ok:true};}if(args.includes('--file')){enrollment.push(args);attempts++;return {ok:attempts>1};}return {ok:true};},async runInteractive(){throw Error('settings required');}};
 const args=['--setup-workspace',encode(payload),'--fleet-settings=/fixture/settings'];
 try{
  await assert.rejects(runWorkspaceSetup(args,effects,async()=>{roots++;selected={endpoint:'https://retained.invalid/daemon'};return 0;}),/enrollment incomplete/);
  const marker=join(home,'.ours-client','workspace-setup-pending.json');assert.equal(existsSync(marker),true);
  await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode({...payload,challenge:{...payload.challenge,workspaceId:'z'.repeat(43)}})],effects,async()=>{throw Error('must not create root');}),/another workspace/);
  assert.equal(await runWorkspaceSetup(args,effects,async()=>{roots++;return 0;}),0);
  assert.equal(roots,1);assert.equal(enrollment.length,2);assert.ok(enrollment.every(args=>!args.includes('--preserve-profile')),'same fresh workspace still fills Name/Surname');assert.equal(existsSync(marker),false);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('partial server setup failure resumes before client profile publication',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');const {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'workspace-partial-'));let selected=null,resumes=0,roots=0;const enrollments=[];
 const root=join(home,'.ours-network','workspace'),record=join(root,'installation.json');
 const effects={home,env:{},out(){},readManagedClientProfile:()=>selected,async run(bin,args){if(args.includes('--file'))enrollments.push(args);return {ok:true};},async runInteractive(){throw Error('settings required');}};
 const setup=async()=>{resumes++;if(!existsSync(record)){roots++;mkdirSync(root,{recursive:true});writeFileSync(record,'retained fixture record');return 1;}selected={endpoint:'https://retained.invalid/daemon'};return 0;};
 const args=['--setup-workspace',encode(payload),'--fleet-settings=/fixture/settings'];
 try{assert.equal(await runWorkspaceSetup(args,effects,setup),1);assert.equal(selected,null);assert.equal(await runWorkspaceSetup(args,effects,setup),0);assert.equal(resumes,2);assert.equal(roots,1);assert.equal(enrollments.length,1);assert.ok(!enrollments[0].includes('--preserve-profile'));}finally{rmSync(home,{recursive:true,force:true});}
});

for(const [label,fields,want] of [
 ['full only',{fullName:'Prince',name:null,surname:null},{fullName:'Prince',name:null,surname:null}],
 ['absent',{name:undefined,surname:undefined},{fullName:null,name:null,surname:null}],
 ['given only',{name:'Alice',surname:null},{fullName:null,name:'Alice',surname:null}],
 ['surname only',{name:null,surname:'Tester'},{fullName:null,name:null,surname:'Tester'}],
 ['legacy',{},{fullName:null,name:'Alice',surname:'Tester'}],
])test('workspace decoder retains optional profile: '+label,()=>{
 const actual=decodeWorkspacePayload(encode({...payload,...fields}),now);
 assert.deepEqual({fullName:actual.fullName,name:actual.name,surname:actual.surname},want);
});
for(const key of ['fullName','name','surname'])test('workspace decoder rejects malformed '+key,()=>{
 for(const value of [42,{},'bad\nname','x'.repeat(8193)])assert.throws(()=>decodeWorkspacePayload(encode({...payload,[key]:value}),now));
});
for(const fields of [{fullName:'Prince',name:null,surname:null},{name:undefined,surname:undefined},{fullName:'Alice Tester'},{name:'Alice',surname:null},{name:null,surname:'Tester'}])test('fresh optional profile checks installed Fleet before setup or retry marker writes '+JSON.stringify(fields),async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');
 const {mkdtempSync,existsSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'optional-profile-'));let setup=0;const calls=[];
 const effects={home,out(){},async run(bin,args){calls.push(args);return {ok:true,stdout:JSON.stringify({capabilities:[]})};}};
 try{await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode({...payload,...fields})],effects,async()=>{setup++;return 0;}),/update.*Fleet|Fleet.*update/i);
 assert.equal(setup,0);assert.deepEqual(calls,[['version','--json']]);assert.equal(existsSync(join(home,'.ours-client','workspace-setup-pending.json')),false);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('supported Fleet receives the original optional profile privately and only rootName becomes setup identity',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');const {mkdtempSync,readFileSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'optional-forward-'));let profile=null,forwarded;
 const encoded=encode({...payload,fullName:'Prince',name:null,surname:null});
 const effects={home,env:{},out(){},readManagedClientProfile:()=>profile,async run(bin,args){if(args[0]==='version')return {ok:true,stdout:JSON.stringify({capabilities:['workspace.enroll.optional-profile-v1']})};if(args[0]==='init')writeFileSync(join(home,'fleet.yaml'),'fixture');if(args.includes('--file'))forwarded=JSON.parse(Buffer.from(readFileSync(args[args.indexOf('--file')+1],'utf8'),'base64url'));return {ok:true};}};
 try{assert.equal(await runWorkspaceSetup(['--setup-workspace',encoded,'--fleet-settings=/fixture'],effects,async options=>{assert.equal(options[options.indexOf('--identity-name')+1],'alice@home');assert.ok(!options.includes('--name'));assert.ok(!options.includes('--surname'));profile={endpoint:'fixture'};return 0;}),0);assert.deepEqual({fullName:forwarded.fullName,name:forwarded.name,surname:forwarded.surname},{fullName:'Prince',name:null,surname:null});}finally{rmSync(home,{recursive:true,force:true});}
});

const grant={version:2,appOrigin:payload.appOrigin,code:'g'.repeat(43),expiresAt:now+600000};
test('minimal grant is redeemed privately through the actual fresh setup path without logging its envelope',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');const {mkdtempSync,readFileSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'grant-forward-'));let profile=null,forwarded,setup=0;const visible=[];
 const privatePayload=encode({...payload,fullName:'Prince',name:null,surname:null});
 const effects={home,env:{},out:value=>visible.push(value),readManagedClientProfile:()=>profile,async run(bin,args){visible.push(JSON.stringify(args));if(args[0]==='version')return {ok:true,stdout:JSON.stringify({capabilities:['workspace.enroll.optional-profile-v1']})};if(args[0]==='init')writeFileSync(join(home,'fleet.yaml'),'fixture');if(args.includes('--file'))forwarded=readFileSync(args[args.indexOf('--file')+1],'utf8');return {ok:true};}};
 const request=async(url,options)=>{assert.equal(url,'https://app.ours.network/account-api/workspace-install-redeem');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers.Origin,grant.appOrigin);assert.deepEqual(JSON.parse(options.body),{code:'g'.repeat(43)});return new Response(JSON.stringify({payload:privatePayload}));};
 try{assert.equal(await runWorkspaceSetup(['--setup-workspace',encode(grant),'--fleet-settings=/fixture'],effects,async options=>{visible.push(JSON.stringify(options));setup++;profile={endpoint:'fixture'};return 0;},request),0);assert.equal(setup,1);assert.equal(forwarded,privatePayload);assert.ok(!visible.join('').includes(privatePayload));assert.ok(!visible.join('').includes('Prince'));}finally{rmSync(home,{recursive:true,force:true});}
});
for(const [label,input,response,error] of [
 ['origin', {...grant,appOrigin:'https://attacker.invalid'},()=>new Response('{}'),/invalid|expired/i],
 ['expired', {...grant,expiresAt:now-1},()=>new Response('{}'),/invalid|expired/i],
 ['extra field', {...grant,connectorToken:'secret'},()=>new Response('{}'),/invalid|expired/i],
 ['used', grant,()=>new Response('{}',{status:410}),/used|expired/i],
 ['redirect',grant,()=>new Response('',{status:302,headers:{Location:'https://attacker.invalid'}}),/redemption/i],
 ['oversize',grant,()=>new Response('x'.repeat(40000)),/response/i],
 ['malformed',grant,()=>new Response('bad-json'),/response/i],
 ['origin mismatch',grant,()=>new Response(JSON.stringify({payload:encode({...payload,appOrigin:'https://app.ours-tunnel.com'})})),/origin mismatch/i],
])test('grant '+label+' fails before setup without leaking private data',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');let setup=0,runs=0,requests=0;
 await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode(input)],{home:'/fixture',async run(){runs++;return {ok:true};}},async()=>{setup++;return 0;},async()=>{requests++;return response();}),error);
 assert.equal(setup,0);assert.equal(runs,0);assert.equal(requests,['origin','expired','extra field'].includes(label)?0:1);
});
test('private renewal preserves existing credential ownership checks downstream',()=>{
 const decoded=decodeWorkspacePayload(encode({...payload,connectorToken:undefined,renewal:true}),now);assert.equal(decoded.connectorToken,undefined);assert.equal(decoded.renewal,true);
});

test('connector omission is limited to a valid renewal envelope',()=>{
 for(const fields of [{connectorToken:undefined},{connectorToken:undefined,renewal:false},{renewal:'true'},{renewal:42}])assert.throws(()=>decodeWorkspacePayload(encode({...payload,...fields}),now));
});
