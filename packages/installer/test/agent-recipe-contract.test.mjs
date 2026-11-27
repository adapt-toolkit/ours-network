import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSetupArgs} from '../lib/setup-options.mjs';
const guide=readFileSync(new URL('../docs/standalone-agent-quickstart.md',import.meta.url),'utf8');
test('documented ordinary recipe parses without a questionnaire for one/both clients and either supported engine',()=>{
 for(const clients of ['claude-code','codex','claude-code,codex'])for(const engine of ['docker','podman']){
  const x=parseSetupArgs(['--plugin-only','--state-dir','/fixture/install','--identity-name','Local-fixture','--integrations',clients,'--container-engine',engine],{home:'/fixture'});
  assert.equal(x.interactive,false);assert.equal(x.product,'plugin-only');assert.equal(x.mode,'docker');assert.equal(x.containerEngine,engine);assert.ok(!x.integrations.includes('fleet'));
 }
 assert.match(guide,/Neither supported client present: stop before installation/);
 assert.match(guide,/Neither ready: explain the missing prerequisite/);
 assert.match(guide,/all ordinary values supplied/);
 assert.doesNotMatch(guide,/ours-install --minimal|ours-install --demo/);
});
