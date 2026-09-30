import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import {parseSetupArgs} from './setup-options.mjs';
/** Base64 is transport, not encryption. Broad provider credentials are never accepted. */
export function decodeWorkspacePayload(encoded,now=Date.now()) {
  if(typeof encoded!=='string' || encoded.length>32768 || !/^[A-Za-z0-9_-]+$/.test(encoded.trim()))throw Error('Invalid private workspace payload');
  let p;try{p=JSON.parse(Buffer.from(encoded.trim(),'base64url'));}catch{throw Error('Invalid private workspace payload');}
  const allowed=['version','appOrigin','hostname','rootName','name','surname','connectorToken','invitation','serverCid','challenge'];
  if(!p || Object.keys(p).some(k=>!allowed.includes(k)) || p.version!==1 || p.appOrigin!=='https://app.ours.network' || !/^[a-z0-9][a-z0-9-]{2,60}\.ours-tunnel\.com$/.test(p.hostname) || !/^[a-z0-9-]{2,30}@[a-z0-9-]{2,30}$/.test(p.rootName) || !/^[a-f0-9]{64}$/i.test(p.serverCid))throw Error('Invalid workspace payload boundary');
  for(const key of ['name','surname','connectorToken','invitation'])if(typeof p[key]!=='string' || !p[key].trim() || p[key].length>8192 || /[\x00-\x1f\x7f]/.test(p[key]))throw Error('Invalid private workspace payload');
  if(!p.challenge || !['nonce','accountId','workspaceId'].every(k=>/^[\w-]{43}$/.test(p.challenge[k])) || !Number.isFinite(p.challenge.expiresAt) || p.challenge.expiresAt<=now || p.challenge.expiresAt>now+16*60000)throw Error('Workspace challenge expired or invalid');
  return p;
}
export function extractWorkspaceArgs(args){
  const flags=['--setup-workspace','--setup-workspace-file','--workspace-fleet-bin','--fleet-settings'];const values={},rest=[];
  for(let i=0;i<args.length;i++){const at=args[i].indexOf('='),flag=at<0?args[i]:args[i].slice(0,at);if(!flags.includes(flag)){rest.push(args[i]);continue;}if(values[flag]!==undefined)throw Error('Duplicate workspace flag');const value=at<0?args[++i]:args[i].slice(at+1);if(!value || value.startsWith('--'))throw Error('Workspace flag requires a value');values[flag]=value;}
  if(values['--setup-workspace'] && values['--setup-workspace-file'])throw Error('Choose one private payload transport');
  return {values,rest};
}
export async function runWorkspaceSetup(args,effects,runSetup){
  const {values,rest}=extractWorkspaceArgs(args);let encoded;
  if(values['--setup-workspace-file']){const path=resolve(values['--setup-workspace-file']),stat=lstatSync(path);if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.uid!==process.getuid?.() || stat.size>32768 || (stat.mode&0o077)!==0)throw Error('Setup file must be owned and private (chmod 600)');encoded=readFileSync(path,'utf8').trim();}
  else if(values['--setup-workspace']==='-'){const chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>32768)throw Error('Private payload too large');chunks.push(chunk);}encoded=Buffer.concat(chunks).toString().trim();}
  else encoded=values['--setup-workspace'];
  const p=decodeWorkspacePayload(encoded),fleetBin=values['--workspace-fleet-bin'] || 'ours-fleet';
  const parsed=parseSetupArgs(rest,{home:effects.home,validate:false});
  if(parsed.scope==='server')throw Error('Workspace setup requires all or client scope');
  if(parsed.identityName!==undefined || parsed.integrations!==undefined)throw Error('Workspace setup supplies identity and client integration selection');
  // Check feature availability before changing an installation. Task acceptance uses
  // an exact task-built binary; @latest cannot contain an unmerged feature.
  const root=parsed.stateDir || join(effects.home,'.ours-network','workspace'),fleetSettings=values['--fleet-settings'];
  const options=[...rest];if(!parsed.scope)options.push('--scope',parsed.config?'client':'all');if(!parsed.mode && !parsed.config)options.push('--mode','docker');if(!parsed.stateDir && !parsed.config)options.push('--state-dir',root);
  if(!parsed.config)options.push('--identity-name',p.rootName);options.push('--integrations','none');
  parseSetupArgs(options,{home:effects.home});
  await effects.run(fleetBin,['workspace-enroll','--help'],{sensitive:true});
  await effects.run('cloudflared',['--version'],{sensitive:true});
  const result=await runSetup(options,effects);if(result!==0)return result;
  if(options.includes('--dry-run'))return 0;
  const initArgs=['init',...(fleetSettings?['--settings',fleetSettings]:[])];
  const selected=effects.readManagedClientProfile();if(!selected)throw Error('Workspace client profile was not installed');
  const env={OURS_CONFIG:join(effects.home,'.ours-client','profile.json')};
  // An explicit managed gateway profile must not compete with inherited daemon selectors.
  for(const key of ['OURS_PORT','OURS_STATE_DIR','OURS_API_TOKEN','OURS_DAEMON_ID','OURS_DAEMON_URL','OURS_DAEMON_CREDENTIAL_PATH'])env[key]=undefined;
  const initialized=fleetSettings?await effects.run(fleetBin,initArgs,{env}):await effects.runInteractive(fleetBin,initArgs,{env});if(!initialized.ok)throw Error('Fleet configuration incomplete');
  mkdirSync(root,{recursive:true,mode:0o700});const temporary=mkdtempSync(join(root,'.workspace-payload-'));chmodSync(temporary,0o700);
  const payloadFile=join(temporary,'payload');writeFileSync(payloadFile,encoded,{mode:0o600,flag:'wx'});
  try{await effects.run(fleetBin,['workspace-enroll','--file',payloadFile],{env,stream:true,sensitive:true});}
  finally{rmSync(temporary,{recursive:true,force:true});}
  effects.out('Workspace proof submitted. Check verified binding/tunnel status in your account, then scan or paste the private device code.');return 0;
}
