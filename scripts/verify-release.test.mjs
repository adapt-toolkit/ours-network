import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PACKAGE_NAMES } from './release-manifest.mjs';
for (const mode of ['valid','wrong-bytes','nested-drift','registry-failure']) {
 test(`official artifact gate: ${mode}`,()=>{
  const dir=mkdtempSync(join(tmpdir(),'release-gate-fixture-'));
  try {
   for(const p of ['scripts','releases','packages/installer/assets','bin','home'])mkdirSync(join(dir,p),{recursive:true});
   for(const file of ['release-manifest.mjs','verify-release.mjs','prepare-installer.mjs'])cpSync(new URL(file,import.meta.url),join(dir,'scripts',file));
   const integrity=`sha512-${createHash('sha512').update('fixture archive').digest('base64')}`;
   const manifest={schema:1,channel:'stable',installerVersion:'9.9.9',packages:Object.fromEntries(PACKAGE_NAMES.map(n=>[n,{version:'9.9.9',integrity}]))};
   writeFileSync(join(dir,'releases/stable.json'),JSON.stringify(manifest));
   writeFileSync(join(dir,'packages/installer/package.json'),JSON.stringify({version:'9.9.9'}));
   writeFileSync(join(dir,'bin/npm'),`#!${process.execPath}
const fs=require('node:fs');
if(process.env.RELEASE_GATE_FIXTURE==='registry-failure')process.exit(42);
if(process.argv[2]==='pack'){
 const spec=process.argv[3];const pos=spec.lastIndexOf('@');const name=spec.slice(0,pos),version=spec.slice(pos+1);
 fs.writeFileSync('fixture.tgz',process.env.RELEASE_GATE_FIXTURE==='wrong-bytes'?'wrong bytes':'fixture archive');
 console.log(JSON.stringify([{name,version,filename:'fixture.tgz'}]));
}else if(process.argv[2]==='install'){
 const deps=JSON.parse(fs.readFileSync('package.json')).dependencies;
 const packages=Object.fromEntries(Object.entries(deps).map(([name,version])=>['node_modules/'+name,{version,integrity:${JSON.stringify(integrity)}}]));
 if(process.env.RELEASE_GATE_FIXTURE==='nested-drift')packages['node_modules/@ours.network/fleet/node_modules/@ours.network/sdk']={version:'2.0.1',integrity:${JSON.stringify(integrity)}};
 fs.writeFileSync('package-lock.json',JSON.stringify({packages}));
}else process.exit(91);
`,{mode:0o755});
   const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('OURS_')&&!k.toLowerCase().startsWith('npm_config_')));
   Object.assign(env,{PATH:`${join(dir,'bin')}:${env.PATH}`,HOME:join(dir,'home'),RELEASE_GATE_FIXTURE:mode});
   const r=spawnSync(process.execPath,[join(dir,'scripts/verify-release.mjs')],{env,encoding:'utf8',timeout:30_000});
   assert.equal(r.status===0,mode==='valid',r.stdout+r.stderr);
   assert.equal(existsSync(join(dir,'packages/installer/assets/release-lock.json')),mode==='valid');
   if(mode==='valid'){
    const prepared=spawnSync(process.execPath,[join(dir,'scripts/prepare-installer.mjs')],{env,encoding:'utf8'});
    assert.equal(prepared.status,0,prepared.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'packages/installer/assets/release.json'))),manifest);
    const sources=JSON.parse(readFileSync(join(dir,'packages/installer/assets/sources.json')));
    assert.equal(Object.keys(sources.packages).length,9);
    assert.deepEqual(sources.release,manifest);
    assert.deepEqual(sources.packages['@ours.network/sdk'],{type:'npm',version:'9.9.9'});
   }
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
}
