import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateRelease } from './release-manifest.mjs';
const root=new URL('../',import.meta.url);
const pkg=JSON.parse(readFileSync(new URL('packages/installer/package.json',root)));
const channel=pkg.version.includes('-nightly.')?'nightly':'stable';
const manifest=validateRelease(JSON.parse(readFileSync(new URL(`releases/${channel}.json`,root))),pkg.version);
const policy={packages:Object.fromEntries(Object.entries(manifest.packages).map(([name,p])=>[name,{type:'npm',version:p.version}]))};
// Only a fully bound, channel-correct manifest may replace development Git inputs.
writeFileSync(new URL('packages/installer/assets/sources.json',root),JSON.stringify(policy,null,2)+'\n');
writeFileSync(new URL('packages/installer/assets/release.json',root),JSON.stringify(manifest,null,2)+'\n');
console.error(`Prepared ${channel} installer ${pkg.version} with immutable packaged release manifest`);
