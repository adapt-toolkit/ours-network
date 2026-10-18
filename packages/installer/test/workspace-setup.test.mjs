import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { decodeWorkspacePayload,extractWorkspaceArgs } from '../lib/workspace-setup.mjs';
const now=Date.now(),payload={version:1,appOrigin:'https://app.ours.network',hostname:'alice-home.ours-tunnel.com',rootName:'alice@home',name:'Alice',surname:'Tester',connectorToken:'scoped-fixture',invitation:'fixture-invite',serverCid:'a'.repeat(64),challenge:{accountId:'a'.repeat(43),workspaceId:'w'.repeat(43),nonce:'n'.repeat(43),expiresAt:now+600000}};
const trusted={OURS_ACCOUNT_ORIGIN:payload.appOrigin,OURS_WORKSPACE_HOST:payload.hostname};
const encode=p=>Buffer.from(JSON.stringify(p)).toString('base64url');
test('private workspace transport validates boundaries, expiry and rejects broad management fields',()=>{
 assert.equal(decodeWorkspacePayload(encode(payload),now,trusted).rootName,'alice@home');
 assert.equal(decodeWorkspacePayload(encode({...payload,appOrigin:'https://app.ours-tunnel.com'}),now,{...trusted,OURS_ACCOUNT_ORIGIN:'https://app.ours-tunnel.com'}).appOrigin,'https://app.ours-tunnel.com');
 for(const appOrigin of ['http://app.ours-tunnel.com','https://app.ours-tunnel.com:443','https://app.ours-tunnel.com/','https://app.ours-tunnel.com.attacker.invalid','https://user@app.ours-tunnel.com'])assert.throws(()=>decodeWorkspacePayload(encode({...payload,appOrigin}),now,trusted));
 for(const patch of [{appOrigin:'https://attacker.invalid'},{hostname:'attacker.invalid'},{cloudflareApiToken:'never-accept'},{challenge:{...payload.challenge,expiresAt:now}},{connectorToken:'token\nlog'}])assert.throws(()=>decodeWorkspacePayload(encode({...payload,...patch}),now,trusted));
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
 const effects={home,env:{...trusted,OURS_DAEMON_URL:'http://unrelated'},out(){},readManagedClientProfile:()=>profile,async run(bin,args,options){calls.push({bin,args,options});if(args[0]==='workspace-enroll' && args.includes('--file')){payloadPath=args[args.indexOf('--file')+1];assert.equal(readFileSync(payloadPath,'utf8'),encode(payload));}return {ok:true,stdout:JSON.stringify({capabilities:['workspace.enroll.preserve-profile-v1']})};},async runInteractive(){throw Error('existing config must not be initialized');}};
 try{
  assert.equal(await runWorkspaceSetup(['--setup-workspace',encode(payload),'--fleet-settings=/private/settings','--workspace-migrate-app-origin'],effects,async()=>{throw Error('existing host must not reinstall/create root');}),0);
  assert.equal(calls.some(call=>call.args[0]==='init'),false);assert.deepEqual(readFileSync(config),original);
  const enrollment=calls.find(call=>call.args.includes('--file'));assert.equal(enrollment.options.env.OURS_CONFIG,join(home,'.ours-client','profile.json'));assert.equal(enrollment.options.env.OURS_DAEMON_URL,undefined);assert.ok(enrollment.args.includes('--preserve-profile'));assert.ok(enrollment.args.includes('--migrate-app-origin'));assert.equal(existsSync(payloadPath),false);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('explicit existing profile is retained and older Fleet fails before any setup',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');let setup=0;const calls=[];
 const effects={home:'/fixture',env:{...trusted,OURS_CONFIG:'/non-default/profile.json'},readManagedClientProfile:()=>null,out(){},async run(bin,args){calls.push(args);return {ok:true,stdout:JSON.stringify({capabilities:[]})};}};
 await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode(payload)],effects,async()=>{setup++;return 0;}),/profile-preserving Fleet/);assert.equal(setup,0);assert.deepEqual(calls,[['version','--json']]);
});
test('workspace dry run performs no enrollment or Fleet init',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');const calls=[];
 const effects={home:'/fixture',env:{...trusted},out(){},async run(bin,args){calls.push(args);return {ok:true};}};
 assert.equal(await runWorkspaceSetup(['--setup-workspace',encode(payload),'--dry-run'],effects,async options=>{assert.ok(options.includes('--identity-name'));return 0;}),0);
 assert.deepEqual(calls,[['workspace-enroll','--help'],['--version']]);
});
test('fresh setup failure resumes same workspace without a second root and still applies account name',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');const {mkdtempSync,writeFileSync,existsSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'workspace-retry-'));let selected=null,roots=0,attempts=0;const enrollment=[];
 const effects={home,env:{...trusted},out(){},readManagedClientProfile:()=>selected,async run(bin,args){if(args[0]==='init'){writeFileSync(join(home,'fleet.yaml'),'retained fresh config');return {ok:true};}if(args.includes('--file')){enrollment.push(args);attempts++;return {ok:attempts>1};}return {ok:true};},async runInteractive(){throw Error('settings required');}};
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
 const effects={home,env:{...trusted},out(){},readManagedClientProfile:()=>selected,async run(bin,args){if(args.includes('--file'))enrollments.push(args);return {ok:true};},async runInteractive(){throw Error('settings required');}};
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
 const actual=decodeWorkspacePayload(encode({...payload,...fields}),now,trusted);
 assert.deepEqual({fullName:actual.fullName,name:actual.name,surname:actual.surname},want);
});
for(const key of ['fullName','name','surname'])test('workspace decoder rejects malformed '+key,()=>{
 for(const value of [42,{},'bad\nname','x'.repeat(8193)])assert.throws(()=>decodeWorkspacePayload(encode({...payload,[key]:value}),now,trusted));
});
for(const fields of [{fullName:'Prince',name:null,surname:null},{name:undefined,surname:undefined},{fullName:'Alice Tester'},{name:'Alice',surname:null},{name:null,surname:'Tester'}])test('fresh optional profile checks installed Fleet before setup or retry marker writes '+JSON.stringify(fields),async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');
 const {mkdtempSync,existsSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'optional-profile-'));let setup=0;const calls=[];
 const effects={home,env:{...trusted},out(){},async run(bin,args){calls.push(args);return {ok:true,stdout:JSON.stringify({capabilities:[]})};}};
 try{await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode({...payload,...fields})],effects,async()=>{setup++;return 0;}),/update.*Fleet|Fleet.*update/i);
 assert.equal(setup,0);assert.deepEqual(calls,[['version','--json']]);assert.equal(existsSync(join(home,'.ours-client','workspace-setup-pending.json')),false);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('supported Fleet receives the original optional profile privately and only rootName becomes setup identity',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');const {mkdtempSync,readFileSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'optional-forward-'));let profile=null,forwarded;
 const encoded=encode({...payload,fullName:'Prince',name:null,surname:null});
 const effects={home,env:{...trusted},out(){},readManagedClientProfile:()=>profile,async run(bin,args){if(args[0]==='version')return {ok:true,stdout:JSON.stringify({capabilities:['workspace.enroll.optional-profile-v1']})};if(args[0]==='init')writeFileSync(join(home,'fleet.yaml'),'fixture');if(args.includes('--file'))forwarded=JSON.parse(Buffer.from(readFileSync(args[args.indexOf('--file')+1],'utf8'),'base64url'));return {ok:true};}};
 try{assert.equal(await runWorkspaceSetup(['--setup-workspace',encoded,'--fleet-settings=/fixture'],effects,async options=>{assert.equal(options[options.indexOf('--identity-name')+1],'alice@home');assert.ok(!options.includes('--name'));assert.ok(!options.includes('--surname'));profile={endpoint:'fixture'};return 0;}),0);assert.deepEqual({fullName:forwarded.fullName,name:forwarded.name,surname:forwarded.surname},{fullName:'Prince',name:null,surname:null});}finally{rmSync(home,{recursive:true,force:true});}
});

const grant={version:2,appOrigin:payload.appOrigin,code:'g'.repeat(43),expiresAt:now+600000};
// Read-only effects used by the setup plan preflight before a grant is redeemed.
// '/fixture' is the complete Fleet settings file these grant tests name.
const fleetModel={harness:'codex',session:'acp',model:'gpt-6-astra',efforts:['low','medium','high']};
const fleetSettings={subscriptions:['codex'],assignmentStrategy:'one-model',reasoning:'balanced',models:{development:fleetModel,review:fleetModel,coordination:fleetModel}};
const planning={platform:{platform:'linux'},readJson:path=>path==='/fixture'?fleetSettings:null,packagedSourcePolicy:()=>({}),readManagedClientProfile:()=>null};
test('minimal grant is redeemed privately through the actual fresh setup path without logging its envelope',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');const {mkdtempSync,readFileSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'grant-forward-'));let profile=null,forwarded,setup=0;const visible=[];
 const privatePayload=encode({...payload,fullName:'Prince',name:null,surname:null});
 const effects={home,env:{...trusted},out:value=>visible.push(value),...planning,readManagedClientProfile:()=>profile,async run(bin,args){visible.push(JSON.stringify(args));if(args[0]==='version')return {ok:true,stdout:JSON.stringify({capabilities:['workspace.enroll.optional-profile-v1']})};if(args[0]==='init')writeFileSync(join(home,'fleet.yaml'),'fixture');if(args.includes('--file'))forwarded=readFileSync(args[args.indexOf('--file')+1],'utf8');return {ok:true};}};
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
 ['origin mismatch',grant,()=>new Response(JSON.stringify({payload:encode({...payload,appOrigin:'https://app.ours-tunnel.com'})})),/origin mismatch|payload boundary/i],
])test('grant '+label+' fails before setup without leaking private data',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');let setup=0,requests=0;const runs=[];
 await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode(input)],{home:'/fixture',env:{...trusted},...planning,async run(bin,args){runs.push(args);return {ok:true};}},async()=>{setup++;return 0;},async()=>{requests++;return response();}),error);
 const local=['origin','expired','extra field'].includes(label);
 assert.equal(setup,0);assert.deepEqual(runs,local?[]:[['workspace-enroll','--help'],['--version']]);assert.equal(requests,local?0:1);
});
// One-use App grant: SetupGrants.redeem deletes the code on the first POST.
function grantServer(privatePayload){
 const live=new Set([grant.code]),posts=[];
 const request=async(url,options)=>{posts.push(url);const {code}=JSON.parse(options.body);if(!live.delete(code))return new Response('{}',{status:410});return new Response(JSON.stringify({payload:privatePayload}));};
 return {request,posts};
}
function freshEffects(home,state,capabilities=['workspace.enroll.optional-profile-v1']){
 return {home,env:{...trusted},out(){},...planning,readManagedClientProfile:()=>state.profile,async run(bin,args){state.runs.push(args);if(args[0]==='version')return {ok:true,stdout:JSON.stringify({capabilities})};if(args[0]==='init')writeFileSync(join(home,'fleet.yaml'),'fixture');if(args.includes('--file'))state.enrolled++;return {ok:true};}};
}
const {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
test('grant dry run previews without redemption and the same command then redeems exactly once',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');
 const home=mkdtempSync(join(tmpdir(),'grant-preview-'));const state={profile:null,runs:[],enrolled:0},server=grantServer(encode(payload)),previews=[],installs=[];
 const command=['--setup-workspace',encode(grant),'--fleet-settings=/fixture'];
 try{
  assert.equal(await runWorkspaceSetup([...command,'--dry-run'],freshEffects(home,state),async options=>{previews.push(options);return 0;},server.request),0);
  assert.equal(server.posts.length,0);assert.equal(previews.length,1);assert.ok(previews[0].includes('--dry-run'));assert.equal(state.enrolled,0);assert.equal(existsSync(join(home,'.ours-client','workspace-setup-pending.json')),false);
  assert.equal(await runWorkspaceSetup(command,freshEffects(home,state),async options=>{installs.push(options);state.profile={endpoint:'fixture'};return 0;},server.request),0);
  assert.equal(server.posts.length,1);assert.equal(installs.length,1);assert.equal(installs[0][installs[0].indexOf('--identity-name')+1],'alice@home');assert.equal(state.enrolled,1);
  // Replaying the spent command on another fresh host reaches the App and is refused.
  const other=mkdtempSync(join(tmpdir(),'grant-replay-')),replay={profile:null,runs:[],enrolled:0};
  try{await assert.rejects(runWorkspaceSetup(command,freshEffects(other,replay),async()=>{throw Error('used grant must not reach setup');},server.request),/used|expired/i);}finally{rmSync(other,{recursive:true,force:true});}
  assert.equal(server.posts.length,2);assert.equal(state.enrolled,1);assert.equal(replay.enrolled,0);
 }finally{rmSync(home,{recursive:true,force:true});}
});
for(const [label,args,error] of [
 ['server scope',['--scope','server'],/all or client scope/],
 ['identity override',['--identity-name','other@host'],/supplies identity/],
 ['integration override',['--integrations','codex'],/supplies identity/],
 ['unknown option',['--no-such-option'],/./],
 ['invalid mode',['--mode','vm'],/Mode/],
])test('grant is not redeemed for invalid setup arguments: '+label,async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');
 const home=mkdtempSync(join(tmpdir(),'grant-invalid-'));const state={profile:null,runs:[],enrolled:0},server=grantServer(encode(payload));
 try{
  await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode(grant),...args],freshEffects(home,state),async()=>{throw Error('must not set up');},server.request),error);
  await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode(grant),...args,'--dry-run'],freshEffects(home,state),async()=>{throw Error('must not preview');},server.request),error);
  assert.equal(server.posts.length,0);assert.equal(state.enrolled,0);
 }finally{rmSync(home,{recursive:true,force:true});}
});
for(const [label,prepare,error,extra=[]] of [
 ['client daemon token override',state=>{state.env={OURS_API_TOKEN:'fixture'};},/OURS_API_TOKEN conflicts/],
 ['client port override',state=>{state.env={OURS_PORT:'3050'};},/OURS_PORT conflicts/],
 ['direct Windows Node',state=>{state.platform='win32';},/WSL/],
 ['invalid Fleet settings',state=>{state.json={'/fixture/settings.json':{subscriptions:['codex']}};},/Fleet settings/,['--fleet-settings=/fixture/settings.json']],
 ['unreadable source policy',()=>{},/Source policy/,['--sources','/fixture/missing-sources.json']],
 ['enrollment unavailable',state=>{state.fail='workspace-enroll';},/enrollment is unavailable/],
 ['tunnel connector unavailable',state=>{state.fail='--version';},/Tunnel connector/],
 ['existing host lacks profile-preserving Fleet',state=>{state.profile={endpoint:'existing'};state.capabilities=[];},/profile-preserving Fleet/],
 ['existing root without client profile',(state,home)=>{mkdirSync(join(home,'.ours-network','workspace'),{recursive:true});writeFileSync(join(home,'.ours-network','workspace','installation.json'),'{}');},/Existing host requires/],
])test('grant is not redeemed when local preflight fails: '+label,async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');
 const home=mkdtempSync(join(tmpdir(),'grant-preflight-'));const state={profile:null,runs:[],enrolled:0,capabilities:['workspace.enroll.optional-profile-v1']},server=grantServer(encode(payload));
 prepare(state,home);
 const effects={home,env:{...trusted,...state.env},out(){},...planning,platform:{platform:state.platform||'linux'},readJson:path=>state.json?.[path]??null,readManagedClientProfile:()=>state.profile,async run(bin,args){state.runs.push(args);if(args[0]===state.fail)return {ok:false};if(args[0]==='version')return {ok:true,stdout:JSON.stringify({capabilities:state.capabilities})};return {ok:true};}};
 try{
  for(const mode of [[],['--dry-run']])await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode(grant),...extra,...mode],effects,async()=>{throw Error('must not set up');},server.request),error);
  assert.equal(server.posts.length,0);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('grant preview with a valid explicit profile plans its derived identity, then the same command redeems once',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');const {runSetup}=await import('../lib/setup.mjs');
 const home=mkdtempSync(join(tmpdir(),'grant-profile-preview-'));const state={profile:null,runs:[],enrolled:0},server=grantServer(encode(payload)),out=[],installs=[];
 const command=['--setup-workspace',encode(grant),'--fleet-settings=/fixture','--username','alice','--name','Alice','--surname','Tester','--hostname','home'];
 try{
  assert.equal(await runWorkspaceSetup([...command,'--dry-run'],{...freshEffects(home,state),out:value=>out.push(value)},runSetup,server.request),0);
  assert.equal(server.posts.length,0);assert.ok(out.some(line=>String(line).includes('Preview only')),out.join('\n'));assert.ok(!out.join('\n').includes('conflicts'));
  assert.equal(await runWorkspaceSetup(command,freshEffects(home,state),async options=>{installs.push(options);state.profile={endpoint:'fixture'};return 0;},server.request),0);
  assert.equal(server.posts.length,1);assert.equal(installs[0][installs[0].indexOf('--identity-name')+1],'alice@home');assert.equal(state.enrolled,1);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('payload-dependent optional profile support is checked after redemption, before any setup',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');
 const home=mkdtempSync(join(tmpdir(),'grant-optional-'));const state={profile:null,runs:[],enrolled:0},server=grantServer(encode({...payload,fullName:'Prince',name:null,surname:null}));
 try{
  await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode(grant)],freshEffects(home,state,[]),async()=>{throw Error('must not set up');},server.request),/update.*Fleet.*fresh command/i);
  assert.equal(server.posts.length,1);assert.equal(state.enrolled,0);assert.equal(existsSync(join(home,'.ours-client','workspace-setup-pending.json')),false);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('private renewal preserves existing credential ownership checks downstream',()=>{
 const decoded=decodeWorkspacePayload(encode({...payload,connectorToken:undefined,renewal:true}),now,trusted);assert.equal(decoded.connectorToken,undefined);assert.equal(decoded.renewal,true);
});

test('connector omission is limited to a valid renewal envelope',()=>{
 for(const fields of [{connectorToken:undefined},{connectorToken:undefined,renewal:false},{renewal:'true'},{renewal:42}])assert.throws(()=>decodeWorkspacePayload(encode({...payload,...fields}),now,trusted));
});

for(const origin of ['https://accounts.example.test','https://relocated.example.test'])test('configured installer authorities stay exact through redemption and enrollment: '+origin,async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');
 const home=mkdtempSync(join(tmpdir(),'configured-authority-')),calls=[],posts=[];
 const hostname='retained.previous.example.test',envelope=encode({...payload,appOrigin:origin,hostname});
 writeFileSync(join(home,'fleet.yaml'),'retained fixture config');
 const effects={home,env:{OURS_ACCOUNT_ORIGIN:origin,OURS_WORKSPACE_HOST:hostname,OURS_WORKSPACE_DOMAIN:'new.example.test'},out(){},...planning,readManagedClientProfile:()=>({endpoint:'retained'}),async run(bin,args,options){calls.push({args,options});if(args[0]==='version')return {ok:true,stdout:JSON.stringify({capabilities:['workspace.enroll.preserve-profile-v1']})};if(args.includes('--file'))assert.equal(readFileSync(args[args.indexOf('--file')+1],'utf8'),envelope);return {ok:true};}};
 try{
  assert.equal(await runWorkspaceSetup(['--setup-workspace',encode({...grant,appOrigin:origin})],effects,async()=>{throw Error('existing host must not install');},async(url)=>{posts.push(url);return new Response(JSON.stringify({payload:envelope}));}),0);
  assert.deepEqual(posts,[origin+'/account-api/workspace-install-redeem']);
  const enrollment=calls.find(call=>call.args.includes('--file'));
  assert.equal(enrollment.options.env.OURS_ACCOUNT_ORIGIN,origin);
  assert.equal(enrollment.options.env.OURS_WORKSPACE_HOST,hostname);
  const before=calls.length;
  await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode({...grant,appOrigin:'https://third.example.test'})],effects,async()=>{throw Error('must not install');},async()=>{throw Error('must not redeem');}),/origin|boundary|invalid/i);
  assert.equal(calls.length,before);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('private envelope trust is explicit, exact-host first and suffix matching uses a single label boundary',()=>{
 const origin='https://accounts.example.test',hostname='desk.workspaces.example.test';
 const p={...payload,appOrigin:origin,hostname},env={OURS_ACCOUNT_ORIGIN:origin,OURS_WORKSPACE_DOMAIN:'workspaces.example.test'};
 assert.equal(decodeWorkspacePayload(encode(p),now,env).hostname,hostname);
 assert.equal(decodeWorkspacePayload(encode({...p,hostname:'retained.previous.example.test'}),now,{...env,OURS_WORKSPACE_HOST:'retained.previous.example.test'}).hostname,'retained.previous.example.test');
 for(const candidate of ['workspaces.example.test','evilworkspaces.example.test','desk.workspaces.example.test.attacker.invalid','nested.desk.workspaces.example.test'])assert.throws(()=>decodeWorkspacePayload(encode({...p,hostname:candidate}),now,env));
 assert.throws(()=>decodeWorkspacePayload(encode(p),now,{...env,OURS_WORKSPACE_HOST:'other.workspaces.example.test'}));
 assert.throws(()=>decodeWorkspacePayload(encode(p),now,{}));
 for(const invalid of ['https://accounts.example.test/','https://user@accounts.example.test','http://accounts.example.test'])assert.throws(()=>decodeWorkspacePayload(encode({...p,appOrigin:invalid}),now,{...env,OURS_ACCOUNT_ORIGIN:invalid}));
});


test('missing or mismatched trusted invocation origin rejects a grant before effects or network',async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');
 for(const env of [{}, {...trusted,OURS_ACCOUNT_ORIGIN:undefined}, {...trusted,OURS_ACCOUNT_ORIGIN:'https://third.example.test'}, {...trusted,OURS_ACCOUNT_ORIGIN:'https://app.ours.network/'}, {...trusted,OURS_ACCOUNT_ORIGIN:'https://*.ours.network'}]) {
  let runs=0,requests=0,setup=0;
  await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode(grant)],{home:'/fixture',env,out(){},async run(){runs++;return {ok:true};}},async()=>{setup++;return 0;},async()=>{requests++;return new Response('{}');}),/invalid|expired/i);
  assert.equal(runs,0);assert.equal(requests,0);assert.equal(setup,0);
 }
});

for(const patch of [{hostname:'other.ours-tunnel.com'},{appOrigin:'https://third.example.test'}])test('redeemed envelope mismatch cannot enroll or write setup state '+JSON.stringify(patch),async()=>{
 const {runWorkspaceSetup}=await import('../lib/workspace-setup.mjs');
 const home=mkdtempSync(join(tmpdir(),'authority-mismatch-')),state={profile:null,runs:[],enrolled:0};let setup=0,requests=0;
 try {
  await assert.rejects(runWorkspaceSetup(['--setup-workspace',encode(grant)],freshEffects(home,state),async()=>{setup++;return 0;},async()=>{requests++;return new Response(JSON.stringify({payload:encode({...payload,...patch})}));}),/payload boundary|origin mismatch/i);
  assert.equal(requests,1);assert.equal(setup,0);assert.equal(state.enrolled,0);
  assert.equal(existsSync(join(home,'.ours-client','workspace-setup-pending.json')),false);
 } finally {rmSync(home,{recursive:true,force:true});}
});
