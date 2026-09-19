import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHostProfile } from '../lib/target.mjs';
const tuple = { endpoint: 'https://server.example:8443/', expectedInstanceId: '6d1e0b1a-cba2-4d33-9389-7d1787ea325f', credentialPath: '/private/credential' };
test('HTTPS profile keeps server identity and credential, normalizing only origin', () => {
  assert.deepEqual(validateHostProfile(tuple), { ...tuple, endpoint: 'https://server.example:8443' });
});
for (const endpoint of ['ftp://server.example', 'wss://server.example', 'https://user:pass@server.example', 'https://server.example/path', 'https://server.example?q=1', 'https://server.example#fragment']) {
  test(`invalid profile origin rejects ${endpoint}`, () => assert.throws(() => validateHostProfile({ ...tuple, endpoint })));
}
