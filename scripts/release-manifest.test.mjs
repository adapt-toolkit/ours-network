import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease, PACKAGE_NAMES } from './release-manifest.mjs';
function manifest(channel='stable') {
 const version=channel==='stable'?'9.9.9':'9.9.9-nightly.1';
 return {schema:1,channel,installerVersion:version,packages:Object.fromEntries(PACKAGE_NAMES.map(name=>[name,{version,integrity:`sha512-${Buffer.alloc(64).toString('base64')}`}]))};
}
test('exact stable and nightly sets accepted',()=>{for(const channel of ['stable','nightly']){const m=manifest(channel);assert.equal(validateRelease(m,m.installerVersion),m);}});
test('pending/missing sets cannot ship',()=>{const m=manifest();m.packages={};assert.throws(()=>validateRelease(m,m.installerVersion));});
test('ranges, tags and mixed channels refused',()=>{for(const version of ['^9.9.9','latest','9.9.9-nightly.1']){const m=manifest();m.packages[PACKAGE_NAMES[0]].version=version;assert.throws(()=>validateRelease(m,m.installerVersion));}});
test('wrong installer version or digest refused',()=>{const m=manifest();assert.throws(()=>validateRelease(m,'9.9.8'));m.packages[PACKAGE_NAMES[0]].integrity='sha512-bad';assert.throws(()=>validateRelease(m,m.installerVersion));});
test('nightly rejects stable package and unknown packages',()=>{const m=manifest('nightly');m.packages[PACKAGE_NAMES[0]].version='9.9.9';assert.throws(()=>validateRelease(m,m.installerVersion));const n=manifest();n.packages['@ours.network/unknown']=n.packages[PACKAGE_NAMES[0]];assert.throws(()=>validateRelease(n,n.installerVersion));});
