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
    'managed-cli.codex-reasoning-effort-v1', // #235: reject affected Fleet archives even when setup-v1 exists
  ],
};

// Behaviour the installer asks for only when the installed component declares it,
// and skips otherwise (lib/orchestrate.mjs checks the same token at run time). A
// selected release without it is releasable but ships without that behaviour, so
// the gate says so on every run. `--require-all-capabilities` turns the notice
// into a refusal: use it for the release that is meant to deliver the behaviour.
export const DEGRADING_CAPABILITIES = {
  '@ours.network/fleet': [
    'managed-cli.setup-v1',               // `ours-fleet managed-cli setup` after Fleet configuration
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

export function assertArchiveCapabilities(name, version, archive, { strict = false, required = REQUIRED_CAPABILITIES[name] ?? [], degrading = DEGRADING_CAPABILITIES[name] ?? [], notice = console.warn } = {}) {
  if (!required.length && !degrading.length) return;
  const declared = archiveCapabilities(archive);
  const lacks = tokens => tokens.filter(token => !declared.includes(token));
  const missing = lacks(strict ? [...required, ...degrading] : required);
  const select = `select a published ${name} release that contains it (node scripts/select-release-package.mjs ${name} <version>)`;
  if (missing.length)
    throw new Error(`Release graph refused: ${name}@${version} does not declare ${missing.join(', ')}, which this installer invokes; ${select}`);
  const skipped = lacks(degrading);
  if (skipped.length)
    notice(`NOTICE: ${name}@${version} does not declare ${skipped.join(', ')}. An installer released with this selection skips that step; `
      + `to deliver it, ${select} and verify with --require-all-capabilities`);
}
