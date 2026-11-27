import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureSessionSettings} from '../lib/session-settings-effect.mjs';
import {SESSION_CAPABILITIES} from '../lib/session-setup.mjs';
const fixture=()=>{const home=mkdtempSync(join(tmpdir(),'ours-session-settings-'));const packagePath=join(home,'package');mkdirSync(packagePath);return {home,packagePath,env:{},username:'local user',hostname:'host/name',profile:{endpoint:'http://127.0.0.1:1/daemon',expectedInstanceId:'fixture-instance'},fetchImpl:async()=>({ok:true,json:async()=>({instanceId:'fixture-instance',capabilities:SESSION_CAPABILITIES})})};};
const packageCaps=(f,harness)=>writeFileSync(join(f.packagePath,'integration-capabilities.json'),JSON.stringify({schema:1,harness,capabilities:['native-session-auto-v1']}));
test('actual Claude settings write is scoped, private local label and repeat leaves bytes unchanged',async()=>{
 const f=fixture();packageCaps(f,'claude-code');mkdirSync(join(f.home,'.claude'));
 const file=join(f.home,'.claude/settings.json');writeFileSync(file,JSON.stringify({permissions:{deny:['mcp__ours__send_message']},env:{KEEP:'yes'}}));
 const first=await configureSessionSettings({...f,harness:'claude-code'});assert.equal(first.configured,true);
 const bytes=readFileSync(file,'utf8');assert.equal(JSON.parse(bytes).env.KEEP,'yes');assert.ok(!(JSON.parse(bytes).permissions.allow??[]).includes('mcp__ours__send_message'));
 const policy=JSON.parse(readFileSync(join(f.home,'.ours-mcp/session-policy.json'),'utf8'));assert.match(policy.localLabel,/^local-[a-f0-9]{12}$/);assert.ok(!policy.localLabel.includes('host-name'));assert.equal(policy.localAutoAccept,false);
 const repeat=await configureSessionSettings({...f,harness:'claude-code'});assert.equal(repeat.writes.length,0);assert.equal(readFileSync(file,'utf8'),bytes);
});
test('capability mismatch never writes configuration, unknown Codex keeps approval prompts',async()=>{
 const f=fixture();packageCaps(f,'codex');
 const result=await configureSessionSettings({...f,harness:'codex'});assert.equal(result.configured,true);assert.ok(!existsSync(join(f.home,'.codex/config.toml')));assert.match(result.notes[0],/not been qualified/);
 const bad=fixture();packageCaps(bad,'codex');await assert.rejects(()=>configureSessionSettings({...bad,harness:'codex',fetchImpl:async()=>({ok:true,json:async()=>({instanceId:'wrong',capabilities:SESSION_CAPABILITIES})})}));assert.ok(!existsSync(join(bad.home,'.ours-mcp')));
});
test('qualified Codex appends only exact tool tables, preserves restrictions and symlink target',async()=>{
 const f=fixture();packageCaps(f,'codex');mkdirSync(join(f.home,'.codex'));const path=join(f.home,'.codex/config.toml');writeFileSync(path,'# original\nmodel = "kept"\n');
 const r=await configureSessionSettings({...f,harness:'codex',codexApprovalQualified:true});assert.equal(r.configured,true);assert.ok(readFileSync(path,'utf8').startsWith('# original\nmodel = "kept"\n'));assert.match(readFileSync(path,'utf8'),/tools.current_identity\]/);assert.doesNotMatch(readFileSync(path,'utf8'),/tools.keep_identity|tools.send_file|default_tools_approval/);
 const g=fixture();packageCaps(g,'claude-code');mkdirSync(join(g.home,'.claude'));const target=join(g.home,'unrelated.json');writeFileSync(target,'{"kept":true}');symlinkSync(target,join(g.home,'.claude/settings.json'));
 await assert.rejects(()=>configureSessionSettings({...g,harness:'claude-code'}),/non-regular/);assert.equal(readFileSync(target,'utf8'),'{"kept":true}');assert.ok(!existsSync(join(g.home,'.ours-mcp')));
});

test('malformed existing JSON never echoes authentication/settings contents or writes lifecycle policy',async()=>{
 const f=fixture();packageCaps(f,'claude-code');mkdirSync(join(f.home,'.claude'));const path=join(f.home,'.claude/settings.json');writeFileSync(path,'{"secret":"synthetic-private-value", invalid}');
 await assert.rejects(()=>configureSessionSettings({...f,harness:'claude-code'}),error=>/Existing settings JSON is invalid/.test(error.message)&&!error.message.includes('synthetic-private-value'));
 assert.ok(!existsSync(join(f.home,'.ours-mcp')));assert.equal(readFileSync(path,'utf8'),'{"secret":"synthetic-private-value", invalid}');
});
