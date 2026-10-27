// Security version floors for the runtimes Ours executes. Keep this file
// identical in ours-network, ours-fleet and ours-app.
//
// Node.js policy: only reviewed stable release lines are admitted, each with
// its own patched floor. A new line (for example a future 27 or 28 release) is
// added by a reviewed change once its security releases have been checked;
// until then it is refused, as are prerelease builds, end-of-life lines and
// earlier patch levels of a listed line. A single global ">=" comparison would
// admit vulnerable intermediate lines, so every line keeps an explicit floor.
export const NODE_PATCHED_FLOORS = Object.freeze({ 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] });
export const NODE_SECURITY_ADVISORY = 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases';
export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download';
export const NODE_SECURITY_REQUIREMENT = Object.values(NODE_PATCHED_FLOORS).map(floor => `${floor.join('.')}+`).join(', ');

// cloudflared releases before 2026.10.2 trust compromised eMudhra intermediates.
export const CLOUDFLARED_MIN_VERSION = Object.freeze([2026, 10, 2]);
export const CLOUDFLARED_SECURITY_ADVISORY = 'https://blog.cloudflare.com/emudhra-certificate-compromise/';
export const CLOUDFLARED_UPDATE_URL = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/update-cloudflared/';
export const CLOUDFLARED_VERSION_TIMEOUT_MS = 10_000;

const atLeast = (version, floor) => {
  for (let i = 0; i < floor.length; i++) if (version[i] !== floor[i]) return version[i] > floor[i];
  return true;
};

/** Returns [major, minor, patch] for a stable Node.js version string, otherwise null. */
export function parseNodeVersion(version) {
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(String(version));
  return match ? match.slice(1).map(Number) : null;
}

export function isSecureNodeVersion(version) {
  const parsed = parseNodeVersion(version);
  const floor = parsed && NODE_PATCHED_FLOORS[parsed[0]];
  return Boolean(floor && atLeast(parsed, floor));
}

export function nodeVersionError(version) {
  const shown = /^v?[0-9A-Za-z.+-]{1,64}$/.test(String(version)) ? String(version).replace(/^v/, '') : 'unrecognized';
  return `Node.js ${shown} is not permitted. Ours requires a patched supported Node.js release: ${NODE_SECURITY_REQUIREMENT} `
    + 'within those release lines; prerelease, end-of-life and unreviewed release lines are refused. '
    + `Earlier patch levels are affected by CVE-2026-111497 (Brotli decompression out-of-bounds write) and the other October 2026 fixes: ${NODE_SECURITY_ADVISORY} `
    + `Update Node.js from ${NODE_DOWNLOAD_URL} or your package manager, then retry.`;
}

export function assertSecureNodeVersion(version = process.versions.node) {
  if (!isSecureNodeVersion(version)) throw new Error(nodeVersionError(version));
}

/** Returns [year, month, patch] for exact stable `cloudflared --version` output, otherwise null. */
export function parseCloudflaredVersion(output) {
  const match = /^cloudflared version (\d{4})\.(\d{1,2})\.(\d{1,6})(?: \(built [^\r\n()]*\))?\r?\n?$/.exec(String(output));
  const parsed = match?.slice(1).map(Number);
  return parsed && parsed[1] >= 1 && parsed[1] <= 12 ? parsed : null;
}

const cloudflaredGuidance = () => `cloudflared releases before ${CLOUDFLARED_MIN_VERSION.join('.')} trust compromised eMudhra intermediate certificates, which allows server impersonation: ${CLOUDFLARED_SECURITY_ADVISORY} `
  + `Update the cloudflared executable on this host's PATH (${CLOUDFLARED_UPDATE_URL}, or your package manager), check it with "cloudflared --version", then retry.`;

/** `reason` must be a fixed description such as "not found" or "timed out", never command output. */
export function cloudflaredUnavailableError(reason) {
  return `cloudflared could not be verified (${reason}). A tunnel requires cloudflared ${CLOUDFLARED_MIN_VERSION.join('.')} or later. ${cloudflaredGuidance()}`;
}

export function cloudflaredVersionError(output) {
  const parsed = parseCloudflaredVersion(output);
  const found = parsed ? `version ${parsed.join('.')}` : 'with an unrecognized version';
  return `cloudflared ${found} is not permitted; a tunnel requires cloudflared ${CLOUDFLARED_MIN_VERSION.join('.')} or later. ${cloudflaredGuidance()}`;
}

export function isSecureCloudflaredVersion(output) {
  const parsed = parseCloudflaredVersion(output);
  return Boolean(parsed && atLeast(parsed, CLOUDFLARED_MIN_VERSION));
}

export function assertSecureCloudflaredVersion(output) {
  if (!isSecureCloudflaredVersion(output)) throw new Error(cloudflaredVersionError(output));
}
