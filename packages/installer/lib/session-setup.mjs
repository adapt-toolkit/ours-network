import {APPROVED_OURS_TOOLS,mergeClaudeApprovals,mergeCodexApprovals,privateLocalLabel} from './scoped-approvals.mjs';
export const SESSION_CAPABILITIES = Object.freeze(['automatic-session-identities-v1','identity-display-name-v1','identity-promotion-v1']);
export function planSessionSettings({harness,packageCapabilities,daemonCapabilities,sessionPolicy,claudeSettings={},codexText='',username,hostname,localLabel,codexApprovalQualified=false}){
 if(!['claude-code','codex'].includes(harness))throw new Error('Unsupported standalone harness');
 if(packageCapabilities?.schema!==1||packageCapabilities.harness!==harness||!packageCapabilities.capabilities?.includes('native-session-auto-v1')||!SESSION_CAPABILITIES.every(c=>daemonCapabilities?.includes(c)))return {configured:false,writes:[],reason:'Installed integration/daemon does not provide automatic identities and persistence; update the coordinated Ours packages. Existing settings and prompts retained.'};
 const writes=[],notes=[];
 if(sessionPolicy!==null&&sessionPolicy!==undefined){
  if(sessionPolicy.version!==1||['enabled','exposeLocal','localAutoAccept'].some(k=>typeof sessionPolicy[k]!=='boolean'))throw new Error('Existing standalone session policy is invalid; it was not overwritten');
  notes.push('Existing standalone lifecycle and local discovery policy retained.');
  if(!sessionPolicy.enabled)return {configured:false,writes:[],notes,localLabel:sessionPolicy.localLabel??privateLocalLabel(username,hostname,localLabel),reason:'Automatic identities disabled by existing user policy; settings and prompts retained.'};
 }else writes.push({kind:'session-policy',value:{version:1,enabled:true,exposeLocal:true,localAutoAccept:false,localLabel:privateLocalLabel(username,hostname,localLabel)}});
 if(harness==='claude-code'){
  const merged=mergeClaudeApprovals(claudeSettings);
  if(merged.added.length)writes.push({kind:'claude-settings',value:merged.settings});
  notes.push(`Exact Claude MCP grants added: ${merged.added.join(', ')||'none'}. Existing deny/ask rules retained.`);
 }else{
  const merged=mergeCodexApprovals(codexText,{supported:codexApprovalQualified});
  if(merged.added.length)writes.push({kind:'codex-settings',text:merged.text});
  notes.push(merged.reason??`Exact Codex plugin tool grants added: ${merged.added.join(', ')}.`);
 }
 return {configured:sessionPolicy?.enabled!==false,writes,notes,localLabel:sessionPolicy?.localLabel??privateLocalLabel(username,hostname,localLabel),approvedTools:[...APPROVED_OURS_TOOLS]};
}
