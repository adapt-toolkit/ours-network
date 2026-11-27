import { createHash } from 'node:crypto';
// Exact MCP tool grants only. No shell, command runner, file transfer or destructive identity tools.
export const APPROVED_OURS_TOOLS = Object.freeze(['current_identity','list_identities','list_local_contact_book','list_local_sessions']);
const unsafe = new Set(['send_file','save_file','send_command','remove_identity','close_temporary_identity','keep_identity','choose_identity','create_identity','create_root_identity','create_temporary_identity']);
const rulePattern = rule => new RegExp('^'+rule.split('(')[0].replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*')+'$');
export function mergeClaudeApprovals(input, { server = 'plugin_ours_ours', qualified = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Claude settings must be a JSON object');
  if (!/^[a-zA-Z0-9_-]+$/.test(server)) throw new Error('Invalid MCP server name');
  const output = structuredClone(input), permissions = output.permissions ?? {};
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) throw new Error('Claude permissions must be an object');
  for (const key of ['allow','ask','deny']) if (permissions[key] !== undefined && (!Array.isArray(permissions[key]) || permissions[key].some(v=>typeof v!=='string'))) throw new Error(`Claude permissions.${key} must be an array of rules`);
  if (!qualified) return {settings:output,added:[],preservedRestrictions:[],reason:'Claude plugin-qualified tool names have not been qualified in this CLI; existing prompts retained.'};
  const existing = permissions.allow ?? [], restricted = [...(permissions.ask??[]),...(permissions.deny??[])];
  const added=[],kept=[];
  for (const tool of APPROVED_OURS_TOOLS) {
    if(unsafe.has(tool))throw new Error('Destructive or arbitrary-operation grant refused');
    const rule=`mcp__${server}__${tool}`;
    if(restricted.some(r=>rulePattern(r).test(rule) || r.split('(')[0] === `mcp__${server}` || r.split('(')[0] === 'mcp__ours')){kept.push(rule);continue;}
    if(!existing.includes(rule))added.push(rule);
  }
  if(added.length)output.permissions={...permissions,allow:[...existing,...added]};
  return {settings:output,added,preservedRestrictions:kept};
}

/** Conservative append: retain user text byte-for-byte; ambiguous/restrictive TOML keeps prompts. */
export function mergeCodexApprovals(text, { plugin = 'ours@ours-codex-marketplace', supported = false } = {}) {
  if(typeof text!=='string'||!/^[a-zA-Z0-9@._-]+$/.test(plugin))throw new Error('Invalid Codex settings input');
  if(!supported)return {text,added:[],reason:'Per-tool approval support has not been qualified; existing prompts retained.'};
  const marker='# Ours exact tool approvals v1';
  if(text.includes(marker))return {text,added:[],reason:'Existing Ours approval block retained.'};
  // Explicit restrictions and inline/multiline parents require human-owned policy, not an installer rewrite.
  const active=text.split('\n').map(line=>line.replace(/\s+#.*$/,'')).filter(line=>!/^\s*#/.test(line)).join('\n');
  if(/mcp_servers|approval_policy\s*=|default_tools_approval_mode\s*=|approval_mode\s*=|enabled_tools\s*=|disabled_tools\s*=|^\s*(?:plugins|mcp_servers)\s*=|"""|'''/m.test(active))return {text,added:[],reason:'Explicit or ambiguous existing tool policy retained; no approval rules changed.'};
  if(/^\s*\[\[/.test(active))return {text,added:[],reason:'Complex existing TOML retained; no approval rules changed.'};
  const prefix=`plugins."${plugin}".mcp_servers.ours.tools.`;
  if(active.includes(prefix))return {text,added:[],reason:'Existing per-tool settings retained.'};
  const block=APPROVED_OURS_TOOLS.map(tool=>`[${prefix}${tool}]\napproval_mode = "approve"`).join('\n\n');
  return {text:text+(text.endsWith('\n')||!text?'':'\n')+'\n'+marker+'\n'+block+'\n',added:[...APPROVED_OURS_TOOLS]};
}

export function privateLocalLabel(username, hostname, override) {
  if(override!==undefined){if(typeof override!=='string'||!override.trim()||override.length>80||/[\p{C}\p{Zl}\p{Zp}]/u.test(override))throw new Error('Local label must contain 1–80 characters without controls');return override.trim().normalize('NFC');}
  return 'local-' + createHash('sha256').update(String(username??'')+'\0'+String(hostname??'')).digest('hex').slice(0,12);
}
