import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planHarnessPlugins } from '../lib/extras.mjs';
test('generic Claude guidance and README require installer local acquisition', () => {
  const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
  assert.match(readme,/Do not use the public GitHub marketplace/);
  for(const status of ['ok','alias','unsafe']) {
    const [plan]=planHarnessPlugins({harnesses:[{name:'claude-code',status}]});
    assert.ok(plan.manual.includes('ours-install client --integrations claude-code'));
    assert.ok(!JSON.stringify(plan).includes('ours-claude-marketplace'));
    if(status==='ok') {assert.deepEqual(plan.steps,[]);assert.equal(plan.requiresExactMarketplace,true);}
  }
});
test('committed generated release assets agree with the installer package version',()=>{
 const read=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
 const pkg=read('../package.json'),release=read('../assets/release.json'),sources=read('../assets/sources.json');
 assert.equal(release.installerVersion,pkg.version);
 assert.deepEqual(sources.release,release);
});
