import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSecureNodeVersion, assertSecureNodeVersion, nodeVersionError, NODE_SECURITY_ADVISORY, NODE_DOWNLOAD_URL,
  assertSecureCloudflaredVersion, isSecureCloudflaredVersion, cloudflaredUnavailableError,
  CLOUDFLARED_SECURITY_ADVISORY, CLOUDFLARED_UPDATE_URL,
} from '../lib/security-versions.mjs';

// Below, exact and above each supported line's floor.
const accepted = ['22.23.4', 'v22.23.4', '22.23.5', '22.24.0', '24.22.1', '24.22.2', '24.23.0', '26.12.1', '26.12.2', '26.13.0'];
const refused = ['22.23.3', '22.22.9', '22.0.0', '24.22.0', '24.21.9', '26.12.0', '26.11.9',
  // end-of-life, odd and unreviewed lines
  '20.99.99', '21.7.3', '23.11.1', '25.9.0', '27.0.0', '28.0.0',
  // prerelease, nightly and malformed values
  '24.22.1-rc.1', '27.0.0-pre', '26.12.1-nightly20261027', '24.22', '24', 'NaN', '', ' 24.22.1', '24.22.1\n', '9999999999.0.0'];
for (const version of accepted) test(`accepts patched Node.js ${version}`, () => {
  assert.equal(isSecureNodeVersion(version), true);
  assert.doesNotThrow(() => assertSecureNodeVersion(version));
});
for (const version of refused) test(`refuses Node.js ${JSON.stringify(version)}`, () => {
  assert.equal(isSecureNodeVersion(version), false);
  assert.throws(() => assertSecureNodeVersion(version), error => {
    for (const part of ['22.23.4+', '24.22.1+', '26.12.1+', 'CVE-2026-111497', NODE_SECURITY_ADVISORY, NODE_DOWNLOAD_URL]) assert.ok(error.message.includes(part), part);
    return true;
  });
});
test('Node.js refusal reports the found version only when it is a plain version token', () => {
  assert.match(nodeVersionError('22.23.2'), /^Node\.js 22\.23\.2 is not permitted/);
  assert.match(nodeVersionError('bad\nvalue $(x)'), /^Node\.js unrecognized is not permitted/);
});

const output = version => `cloudflared version ${version} (built 2026-10-21-1200 UTC)\n`;
for (const value of [output('2026.10.2'), output('2026.10.10'), output('2026.11.0'), output('2027.1.0'), 'cloudflared version 2026.10.2\n', 'cloudflared version 2026.10.2'])
  test(`accepts patched cloudflared ${JSON.stringify(value)}`, () => {
    assert.equal(isSecureCloudflaredVersion(value), true);
    assert.doesNotThrow(() => assertSecureCloudflaredVersion(value));
  });
for (const [value, found] of [
  [output('2026.10.1'), 'version 2026.10.1'], [output('2026.7.2'), 'version 2026.7.2'], [output('2026.9.99'), 'version 2026.9.99'],
  [output('2025.12.99'), 'version 2025.12.99'],
  ['cloudflared version 2026.10.2-rc.1\n', 'with an unrecognized version'], ['cloudflared version 2026.13.0\n', 'with an unrecognized version'],
  ['cloudflared version 2026.0.5\n', 'with an unrecognized version'], ['cloudflared version 2026.10.2\nextra\n', 'with an unrecognized version'],
  ['garbage', 'with an unrecognized version'], ['', 'with an unrecognized version'], ['cloudflared version DEV\n', 'with an unrecognized version'],
]) test(`refuses cloudflared ${JSON.stringify(value)}`, () => {
  assert.equal(isSecureCloudflaredVersion(value), false);
  assert.throws(() => assertSecureCloudflaredVersion(value), error => {
    assert.ok(error.message.startsWith(`cloudflared ${found} is not permitted`), error.message);
    for (const part of ['2026.10.2 or later', CLOUDFLARED_SECURITY_ADVISORY, CLOUDFLARED_UPDATE_URL, 'cloudflared --version']) assert.ok(error.message.includes(part), part);
    return true;
  });
});
test('unavailable cloudflared names the fixed reason, minimum, incident and update guidance', () => {
  const message = cloudflaredUnavailableError('timed out');
  for (const part of ['(timed out)', '2026.10.2 or later', CLOUDFLARED_SECURITY_ADVISORY, CLOUDFLARED_UPDATE_URL]) assert.ok(message.includes(part), part);
});
