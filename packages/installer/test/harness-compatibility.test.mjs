import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginCliCompatibility } from '../lib/harness-compatibility.mjs';
test('plugin registration requires actual CLI features, not merely a version string',()=>{
 for(const name of ['claude-code','codex']) {
  assert.equal(pluginCliCompatibility(name,{ok:true,stdout:'Commands: marketplace install add'}).ok,true);
  for(const result of [{ok:false},{ok:true,stdout:'old CLI'}, {ok:false,timedOut:true}]) {
   const answer=pluginCliCompatibility(name,result);
   assert.equal(answer.ok,false);assert.match(answer.detail,/resume ours-install client/);
   assert.match(answer.detail,/were not replaced/);
  }
 }
});
