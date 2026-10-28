// Reviewed stable branches only: do not admit vulnerable intermediate Node lines.
export const NODE_SECURITY_ADVISORY = 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases';
export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download';
export function isSecureNodeVersion(version) {
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(String(version));
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [];
  const floor = { 22: [23, 4], 24: [22, 1], 26: [12, 1] }[major];
  return Boolean(floor && (minor > floor[0] || (minor === floor[0] && patch >= floor[1])));
}
export function nodeVersionError(version) {
  const found = /^v?[0-9A-Za-z.+-]{1,64}$/.test(String(version)) ? version : 'unrecognized';
  return `Node.js ${found} is not permitted. Requires stable Node.js 22.23.4+, 24.22.1+ or 26.12.1+ within those supported lines (CVE-2026-111497): ${NODE_SECURITY_ADVISORY} Update Node.js from ${NODE_DOWNLOAD_URL}, then retry.`;
}
export function assertSecureNodeVersion(version = process.versions.node) {
  if (!isSecureNodeVersion(version)) throw Error(nodeVersionError(version));
}

export const CLOUDFLARED_SECURITY_ADVISORY = 'https://blog.cloudflare.com/emudhra-certificate-compromise/';
export const CLOUDFLARED_UPDATE_URL = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/update-cloudflared/';
export const CLOUDFLARED_VERSION_TIMEOUT_MS = 10_000;
function cloudflaredVersion(output) {
  const match = /^cloudflared version (\d{4})\.(\d{1,2})\.(\d{1,6})(?: \(built [^\r\n()]*\))?\r?\n?$/.exec(String(output));
  const version = match?.slice(1).map(Number);
  return version && version[1] >= 1 && version[1] <= 12 ? version : null;
}
export function isSecureCloudflaredVersion(output) {
  const v = cloudflaredVersion(output);
  return Boolean(v && (v[0] > 2026 || (v[0] === 2026 && (v[1] > 10 || (v[1] === 10 && v[2] >= 2)))));
}
const cloudflaredGuidance = `A tunnel requires cloudflared 2026.10.2 or later due to compromised certificate trust: ${CLOUDFLARED_SECURITY_ADVISORY} Update the cloudflared executable on PATH (${CLOUDFLARED_UPDATE_URL}), check with "cloudflared --version", then retry.`;
export function cloudflaredUnavailableError(reason) {
  return `cloudflared could not be verified (${reason}). ${cloudflaredGuidance}`;
}
export function assertSecureCloudflaredVersion(output) {
  if (isSecureCloudflaredVersion(output)) return;
  const version = cloudflaredVersion(output);
  throw Error(`cloudflared ${version ? `version ${version.join('.')}` : 'with an unrecognized version'} is not permitted. ${cloudflaredGuidance}`);
}
