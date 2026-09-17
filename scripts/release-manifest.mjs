export const PACKAGE_NAMES = ['sdk','cli','tg-connector','cowork','messenger-server','fleet','mcp','codex','claude-code'].map(n=>`@ours.network/${n}`);
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const nightly = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.(0|[1-9]\d*)$/;
export function validateRelease(manifest, installerVersion) {
 if (!manifest || manifest.schema !== 1 || !['stable','nightly'].includes(manifest.channel)) throw new Error('Invalid release schema/channel');
 const pattern=manifest.channel==='nightly'?nightly:stable;
 if (!pattern.test(installerVersion) || manifest.installerVersion !== installerVersion) throw new Error('Installer version/channel does not match release manifest');
 if (!manifest.packages || JSON.stringify(Object.keys(manifest.packages).sort())!==JSON.stringify([...PACKAGE_NAMES].sort())) throw new Error('Release must contain exactly the nine required packages');
 for(const [name,p] of Object.entries(manifest.packages)) {
  if(!p || !pattern.test(p.version) || typeof p.version!=='string') throw new Error(`Invalid exact ${manifest.channel} version for ${name}`);
  if(typeof p.integrity!=='string'|| !/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity)) throw new Error(`Missing SHA512 integrity for ${name}`);
 }
 return manifest;
}
