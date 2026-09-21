export const PACKAGE_NAMES = ['sdk','cli','tg-connector','cowork','messenger-server','fleet','mcp','codex','claude-code'].map(n=>`@ours.network/${n}`);
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Counter nightlies and Cowork date/commit nightlies are both exact releases.
const nightly = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.(0|[1-9]\d*)(?:\.[0-9a-f]{7,40})?$/;
export function validateRelease(manifest, installerVersion) {
 if (!manifest || manifest.schema !== 1 || !['stable','nightly'].includes(manifest.channel)) throw new Error('Invalid release schema/channel');
 const pattern=manifest.channel==='nightly'?nightly:stable;
 if (!pattern.test(installerVersion) || manifest.installerVersion !== installerVersion) throw new Error('Installer version/channel does not match release manifest');
 if (!manifest.packages || JSON.stringify(Object.keys(manifest.packages).sort())!==JSON.stringify([...PACKAGE_NAMES, ...(manifest.packages?.['@ours.network/daemon'] ? ['@ours.network/daemon'] : [])].sort())) throw new Error('Release must contain the required packages and optional daemon artifact');
 if (Object.hasOwn(manifest, 'hostCli') && (!manifest.hostCli || Object.keys(manifest.hostCli).sort().join(',') !== '@ours.network/cli,@ours.network/sdk')) throw new Error('Host CLI must select exactly CLI and SDK');
 for(const [name,p] of [...Object.entries(manifest.packages), ...Object.entries(manifest.hostCli ?? {})]) {
  if(!p || !pattern.test(p.version) || typeof p.version!=='string') throw new Error(`Invalid exact ${manifest.channel} version for ${name}`);
  if(typeof p.integrity!=='string'|| !/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity)) throw new Error(`Missing SHA512 integrity for ${name}`);
 }
 return manifest;
}
