// Capabilities the installer relies on, per selected component. Semver cannot say
// whether an archive contains a feature; a component's own build-info.json can.
// The release gate reads it from the exact registry archive whose integrity the
// manifest pins, so an installer can never ship selecting a component release
// that predates behaviour the installer invokes.
import { execFileSync } from 'node:child_process';

export const REQUIRED_CAPABILITIES = {
  '@ours.network/fleet': [
    'cowork.http-management-v1',          // gateway HTTP management (client acquisition gate)
    'workspace.enroll.preserve-profile-v1', // workspace setup
    'managed-cli.setup-v1',               // `ours-fleet managed-cli setup` invoked after Fleet configuration
  ],
};

/** Capability tokens declared by a packed npm archive; [] when it declares none. */
export function archiveCapabilities(archive) {
  let text;
  try {
    text = execFileSync('tar', ['-xzOf', archive, 'package/dist/build-info.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 });
  } catch { return []; }
  try {
    const capabilities = JSON.parse(text).capabilities;
    return Array.isArray(capabilities) ? capabilities.filter(item => typeof item === 'string') : [];
  } catch { return []; }
}

export function assertArchiveCapabilities(name, version, archive, required = REQUIRED_CAPABILITIES[name] ?? []) {
  if (!required.length) return;
  const declared = archiveCapabilities(archive);
  const missing = required.filter(token => !declared.includes(token));
  if (missing.length)
    throw new Error(`Release graph refused: ${name}@${version} does not declare ${missing.join(', ')}, which this installer invokes; `
      + `select a published ${name} release that contains it (node scripts/select-release-package.mjs ${name} <version>)`);
}
