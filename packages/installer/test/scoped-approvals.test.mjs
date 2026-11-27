import test from 'node:test';
import assert from 'node:assert/strict';
import {APPROVED_OURS_TOOLS,mergeClaudeApprovals,mergeCodexApprovals,privateLocalLabel} from '../lib/scoped-approvals.mjs';
test('Claude exact tools preserve unrelated settings and deny/ask restrictions',()=>{
 const input={env:{UNRELATED:'kept'},permissions:{allow:['Read'],deny:['mcp__ours__send_message'],ask:['mcp__ours__get_messages']},enabledPlugins:{'other@vendor':true}};
 const result=mergeClaudeApprovals(input);
 assert.equal(result.added.length,4);assert.ok(!result.settings.permissions.allow.includes('mcp__ours__send_message'));assert.deepEqual(result.settings.env,input.env);assert.deepEqual(input.permissions.allow,['Read']);assert.deepEqual(result.settings.permissions.deny,input.permissions.deny);
 assert.deepEqual(mergeClaudeApprovals(result.settings).settings,result.settings,'repeat is idempotent');
});
test('wildcard restrictions win, malformed config refuses, no shell/destructive/file grants',()=>{
 assert.equal(mergeClaudeApprovals({permissions:{deny:['mcp__*']}}).added.length,0);
 assert.equal(mergeClaudeApprovals({permissions:{ask:['mcp__ours__*']}}).added.length,0);
 assert.throws(()=>mergeClaudeApprovals({permissions:{allow:'all'}}));
 for(const tool of APPROVED_OURS_TOOLS)assert.ok(!/file|command|identity$/.test(tool)||['current_identity'].includes(tool));
 assert.ok(APPROVED_OURS_TOOLS.every(t=>!['keep_identity','remove_identity','send_file','send_command'].includes(t)));
});
test('Codex only qualified exact plugin tools, preserves comments and repeats',()=>{
 const original='# user comment\nmodel = "user-model"\n\n[plugins."ours@ours-codex-marketplace"]\nenabled = true\n';
 assert.equal(mergeCodexApprovals(original).text,original);
 const result=mergeCodexApprovals(original,{supported:true});assert.ok(result.text.startsWith(original));assert.equal(result.added.length,6);assert.match(result.text,/tools.current_identity\]\napproval_mode = "approve"/);assert.equal(mergeCodexApprovals(result.text,{supported:true}).text,result.text);
 for(const restriction of ['approval_policy = "on-request"','default_tools_approval_mode = "prompt"','disabled_tools = ["send_message"]','mcp_servers = {}'])assert.equal(mergeCodexApprovals(restriction,{supported:true}).text,restriction);
});
test('local labels sanitize OS values and preserve validated override without public-profile construction',()=>{
 assert.equal(privateLocalLabel('a user','machine/name'),'a-user@machine-name');assert.equal(privateLocalLabel('','','Team reviewer'),'Team reviewer');assert.throws(()=>privateLocalLabel('u','h','bad\nlabel'));
});

const {planSessionSettings,SESSION_CAPABILITIES}=await import('../lib/session-setup.mjs');
const capabilities=harness=>({schema:1,harness,capabilities:['native-session-auto-v1']});
test('capability gate precedes all settings and user labels, existing lifecycle policy is retained',()=>{
 const base={harness:'claude-code',packageCapabilities:capabilities('claude-code'),daemonCapabilities:SESSION_CAPABILITIES,username:'user',hostname:'host'};
 assert.deepEqual(planSessionSettings({...base,daemonCapabilities:[]}).writes,[]);
 const first=planSessionSettings(base);assert.equal(first.configured,true);assert.equal(first.writes[0].value.localLabel,'user@host');
 const policy={version:1,enabled:false,exposeLocal:false,localAutoAccept:false,localLabel:'Existing private label'};
 const repeat=planSessionSettings({...base,sessionPolicy:policy,claudeSettings:first.writes[1].value});assert.equal(repeat.configured,false);assert.equal(repeat.writes.length,0);assert.equal(repeat.localLabel,'Existing private label');
 assert.throws(()=>planSessionSettings({...base,sessionPolicy:{version:99}}));
});

test('alternative TOML quoting and explicit MCP tool restrictions retain original prompts',()=>{
 const input="[plugins.'ours@ours-codex-marketplace'.mcp_servers.ours.tools.send_message]\nenabled = false\n";
 assert.equal(mergeCodexApprovals(input,{supported:true}).text,input);
});
