import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import {parseSetupArgs} from './setup-options.mjs';
/** Base64 is transport, not encryption. Broad provider credentials are never accepted. */
export function decodeWorkspacePayload(encoded,now=Date.now()) {
  if(typeof encoded!=='string' || encoded.length>32768 || !/^[A-Za-z0-9_-]+$/.test(encoded.trim()))throw Error('Invalid private workspace payload');
  let p;try{p=JSON.parse(Buffer.from(encoded.trim(),'base64url'));}catch{throw Error('Invalid private workspace payload');}
  const allowed=['version','appOrigin','hostname','rootName','name','surname','connectorToken','invitation','serverCid','challenge'];
  if(!p || Object.keys(p).some(k=>!allowed.includes(k)) || p.version!==1 || !['https://app.ours.network','https://app.ours-tunnel.com'].includes(p.appOrigin) || !/^[a-z0-9][a-z0-9-]{2,60}\.ours-tunnel\.com$/.test(p.hostname) || !/^[a-z0-9-]{2,30}@[a-z0-9-]{2,30}$/.test(p.rootName) || !/^[a-f0-9]{64}$/i.test(p.serverCid))throw Error('Invalid workspace payload boundary');
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
  const migrateAppOrigin=args.includes('--workspace-migrate-app-origin');
  if(args.filter(arg=>arg==='--workspace-migrate-app-origin').length>1)throw Error('Duplicate workspace migration flag');
  const {values,rest}=extractWorkspaceArgs(args.filter(arg=>arg!=='--workspace-migrate-app-origin'));let encoded;
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
  // The saved gateway profile selects the actual host, including non-default server state.
  // Reuse it directly: server/client reinstall would also rewrite or downgrade retained setup.
  const managed=effects.readManagedClientProfile?.();
  const managedPath=join(effects.home,'.ours-client','profile.json');
  const existingProfile=parsed.config || effects.env?.OURS_CONFIG || (managed?managedPath:undefined);
  const existing=Boolean(existingProfile);
  const marker=join(effects.home,'.ours-client','workspace-setup-pending.json');
  let pending;
  if(existsSync(marker)){
    const stat=lstatSync(marker);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.uid!==process.getuid?.() || (stat.mode&0o077)!==0 || stat.size>4096)throw Error('Workspace retry marker must be owned and private');
    pending=JSON.parse(readFileSync(marker,'utf8'));
    if(pending.version!==1 || pending.accountId!==p.challenge.accountId || pending.workspaceId!==p.challenge.workspaceId || pending.appOrigin!==p.appOrigin)throw Error('Pending fresh installation belongs to another workspace; identity was not changed. Resume the original workspace, or back up the host and remove only ~/.ours-client/workspace-setup-pending.json to treat it as existing (preserving its profile)');
  }
  const preserveProfile=existing && !pending;
  if(existing && parsed.scope && parsed.scope!=='client')throw Error('Existing workspace setup requires client scope; root identity was not changed');
  if(!existing && !pending && (existsSync(join(root,'installation.json')) || existsSync(join(effects.home,'fleet.yaml'))))throw Error('Existing host requires its gateway client profile; no new root was created');
  const options=[...rest];
  if(!parsed.scope)options.push('--scope',existing?'client':'all');
  if(existing && !parsed.config)options.push('--config',existingProfile);
  if(!existing){if(!parsed.mode)options.push('--mode','docker');if(!parsed.stateDir)options.push('--state-dir',root);options.push('--identity-name',p.rootName);}
  options.push('--integrations','none');
  parseSetupArgs(options,{home:effects.home});
  if(preserveProfile){
    const version=await effects.run(fleetBin,['version','--json'],{sensitive:true});
    let info;try{info=JSON.parse(version.stdout);}catch{}
    if(!version.ok || !info?.capabilities?.includes('workspace.enroll.preserve-profile-v1'))throw Error('Existing-host setup requires a profile-preserving Fleet release; nothing was changed');
  }
  const help=await effects.run(fleetBin,['workspace-enroll','--help'],{sensitive:true});if(!help.ok)throw Error('Fleet workspace enrollment is unavailable');
  const tunnel=await effects.run('cloudflared',['--version'],{sensitive:true});if(!tunnel.ok)throw Error('Tunnel connector is unavailable');
  if(options.includes('--dry-run')){if(!existing)return runSetup(options,effects);return 0;}
  if(!existing){
    if(!pending){mkdirSync(join(effects.home,'.ours-client'),{recursive:true,mode:0o700});writeFileSync(marker,JSON.stringify({version:1,accountId:p.challenge.accountId,workspaceId:p.challenge.workspaceId,appOrigin:p.appOrigin})+'\n',{mode:0o600,flag:'wx'});}
    const result=await runSetup(options,effects);if(result!==0)return result;
  }
  const selected=existingProfile || effects.readManagedClientProfile();if(!selected)throw Error('Workspace client profile was not installed');
  const env={OURS_CONFIG:existingProfile || managedPath};
  for(const key of ['OURS_PORT','OURS_STATE_DIR','OURS_API_TOKEN','OURS_DAEMON_ID','OURS_DAEMON_URL','OURS_DAEMON_CREDENTIAL_PATH'])env[key]=undefined;
  const fleetHome=effects.env?.OURS_FLEET_HOME || effects.home,fleetConfig=join(fleetHome,'fleet.yaml');
  if(!existsSync(fleetConfig)){
    const initArgs=['init',...(fleetSettings?['--settings',fleetSettings]:[])];
    const initialized=fleetSettings?await effects.run(fleetBin,initArgs,{env}):await effects.runInteractive(fleetBin,initArgs,{env});if(!initialized.ok)throw Error('Fleet configuration incomplete');
  }
  mkdirSync(root,{recursive:true,mode:0o700});const temporary=mkdtempSync(join(root,'.workspace-payload-'));chmodSync(temporary,0o700);
  const payloadFile=join(temporary,'payload');writeFileSync(payloadFile,encoded,{mode:0o600,flag:'wx'});
  try{const enrolled=await effects.run(fleetBin,['workspace-enroll','--file',payloadFile,...(preserveProfile?['--preserve-profile']:[]),...(migrateAppOrigin?['--migrate-app-origin']:[])],{env,stream:true,sensitive:true});if(!enrolled.ok)throw Error('Workspace enrollment incomplete; existing identity and profile were retained');}
  finally{rmSync(temporary,{recursive:true,force:true});}
  if(pending || !existing)rmSync(marker);
  effects.out('Workspace proof submitted. Check verified binding/tunnel status in your account, then scan or paste the private device code.');return 0;
}
