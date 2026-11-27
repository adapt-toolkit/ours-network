import {readFileSync,lstatSync,mkdirSync,chmodSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {atomicWriteConfig,snapshotConfig,restoreConfig} from './config.mjs';
import {planSessionSettings} from './session-setup.mjs';
const read=(path,fallback)=>{try{const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink())throw new Error(`Refusing non-regular settings file: ${path}`);return readFileSync(path,'utf8');}catch(error){if(error.code==='ENOENT')return fallback;throw error;}};
const json=(path,fallback)=>{const text=read(path,null);return text===null?fallback:JSON.parse(text);};
/** Only called for an explicitly selected, successfully installed native integration. */
export async function configureSessionSettings({home,env,username,hostname,harness,packagePath,profile,codexApprovalQualified=false,fetchImpl=fetch}){
 const capabilities=json(join(packagePath,'integration-capabilities.json'),null);
 if(!capabilities)return {configured:false,reason:'This integration predates automatic session identities; existing settings retained.',writes:[]};
 const response=await fetchImpl(profile.endpoint.replace(/\/$/,'')+'/selection',{redirect:'error',signal:AbortSignal.timeout(1500)});
 const selection=await response.json();
 if(!response.ok||selection.instanceId!==profile.expectedInstanceId)throw new Error('Standalone settings refused: selected daemon instance does not match.');
 const paths={
  'session-policy':resolve(env.OURS_SESSION_POLICY||join(home,'.ours-mcp','session-policy.json')),
  'claude-settings':join(resolve(env.CLAUDE_CONFIG_DIR||join(home,'.claude')),'settings.json'),
  'codex-settings':join(resolve(env.CODEX_HOME||join(home,'.codex')),'config.toml'),
 };
 const plan=planSessionSettings({harness,packageCapabilities:capabilities,daemonCapabilities:selection.capabilities,sessionPolicy:json(paths['session-policy'],null),claudeSettings:harness==='claude-code'?json(paths['claude-settings'],{}):{},codexText:harness==='codex'?read(paths['codex-settings'],''):'',username,hostname,codexApprovalQualified});
 const written=[];
 try{
  for(const write of plan.writes){
   const path=paths[write.kind],before=snapshotConfig(path);read(path,null);
   mkdirSync(dirname(path),{recursive:true,mode:0o700});
   // Keep unrelated user-file permissions; only new files/private lifecycle policy default to 0600.
   written.push({path,before});
   atomicWriteConfig(path,write.text??JSON.stringify(write.value,null,2)+'\n');
   if(before.exists&&write.kind!=='session-policy')chmodSync(path,before.mode);
  }
 }catch(error){for(const entry of written.reverse())restoreConfig(entry.path,entry.before);throw error;}
 return {...plan,paths:written.map(x=>x.path)};
}
