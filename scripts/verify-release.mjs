import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateRelease } from './release-manifest.mjs';
const root=new URL('../',import.meta.url);
const pkg=JSON.parse(readFileSync(new URL('packages/installer/package.json',root)));
const channel=pkg.version.includes('-nightly.')?'nightly':'stable';
const release=validateRelease(JSON.parse(readFileSync(new URL(`releases/${channel}.json`,root))),pkg.version);
const dir=mkdtempSync(join(tmpdir(),'ours-release-verify-'));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('OURS_')&&!key.toLowerCase().startsWith('npm_config_')));
mkdirSync(join(dir,'home'));Object.assign(env,{HOME:join(dir,'home'),NPM_CONFIG_USERCONFIG:join(dir,'home/.npmrc'),NPM_CONFIG_CACHE:join(dir,'cache')});
const npm=(args)=>execFileSync('npm',[...args,'--registry=https://registry.npmjs.org'],{cwd:dir,env,encoding:'utf8',timeout:180_000,maxBuffer:8*1024*1024});
try {
 const archives={};
 for(const [name,p] of Object.entries(release.packages)) {
  const [packed]=JSON.parse(npm(['pack',`${name}@${p.version}`,'--ignore-scripts','--json']));
  if(packed.name!==name||packed.version!==p.version)throw new Error(`Registry package identity mismatch: ${name}`);
  const sri=`sha512-${createHash('sha512').update(readFileSync(join(dir,packed.filename))).digest('base64')}`;
  if(sri!==p.integrity)throw new Error(`Registry archive integrity mismatch: ${name}`);
  archives[name]=packed.filename;
 }
 writeFileSync(join(dir,'package.json'),JSON.stringify({name:'ours-release-set-verification',version:'0.0.0',private:true,dependencies:Object.fromEntries(Object.entries(release.packages).map(([name,p])=>[name,p.version]))}));
 npm(['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund']);
 const lock=JSON.parse(readFileSync(join(dir,'package-lock.json')));
 for(const [path,p] of Object.entries(lock.packages)) {
  const match=path.match(/(?:^|\/)node_modules\/(@ours\.network\/[^/]+)$/);
  if(!match)continue;
  const selected=release.packages[match[1]];
  if(!selected||p.version!==selected.version||p.integrity!==selected.integrity)throw new Error(`Unselected nested ours artifact: ${path}@${p.version}`);
 }
 writeFileSync(new URL('packages/installer/assets/release-lock.json',root),JSON.stringify(lock,null,2)+'\n');
 if(process.argv.includes('--installed')) {
  const { verifyReleaseGraph }=await import('../packages/installer/assets/scripts/maintenance/release-graph.mjs');
  const policy={release,packages:Object.fromEntries(Object.entries(release.packages).map(([name,p])=>[name,{type:'npm',version:p.version}]))};
  npm(['ci','--ignore-scripts','--no-audit','--no-fund']);
  verifyReleaseGraph(dir,policy);
  // The server installs original registry archives through local file references.
  rmSync(join(dir,'node_modules'),{recursive:true,force:true});
  rmSync(join(dir,'package-lock.json'));
  writeFileSync(join(dir,'package.json'),JSON.stringify({name:'ours-vendor-set-verification',version:'0.0.0',private:true,dependencies:Object.fromEntries(Object.entries(archives).map(([name,file])=>[name,`file:${file}`]))}));
  npm(['install','--ignore-scripts','--no-audit','--no-fund']);
  verifyReleaseGraph(dir,policy);
  console.log('Verified actual registry and local-vendor installed ours graphs without lifecycle scripts.');
 }

 console.log('Verified nine official archive identities/SHA512 and complete nested ours version/integrity selection. Runtime qualification remains separate.');
} finally {rmSync(dir,{recursive:true,force:true});}
