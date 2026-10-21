import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGatewayClientProfile } from '../lib/target.mjs';
import { gatewayCompose, gatewayNginx } from '../lib/gateway.mjs';
const identity = { expectedInstanceId: '11111111-2222-3333-4444-555555555555', credentialPath: '/private/credential' };
test('client profile derives prefixed routes; refuses legacy or cross-origin daemon', () => {
  const row = validateGatewayClientProfile({ ...identity, serverUrl: 'http://127.0.0.1:4050/base/' });
  assert.equal(row.endpoint, 'http://127.0.0.1:4050/base/daemon');
  assert.throws(() => validateGatewayClientProfile({ ...identity, endpoint: 'http://127.0.0.1:3050' }), /serverUrl/);
  assert.throws(() => validateGatewayClientProfile({ ...identity, serverUrl: 'https://server.example', endpoint: 'https://other.example/daemon' }), /endpoint/);
});
test('4050 publishes only gateway and preserves daemon/cowork and websocket routes', () => {
  const record = { port: 4050, project: 'fixture', gateway: { version: 1 }, instanceId: identity.expectedInstanceId };
  const compose = gatewayCompose(record), nginx = gatewayNginx(record);
  assert.match(compose, /published: "4050"/);
  assert.match(compose, /daemon:\n    ports: !reset \[\]/);
  assert.match(compose, /cowork:\n    ports: !reset \[\]/);
  assert.match(nginx, /location \/daemon\//);
  assert.match(nginx, /location \/cowork\//);
  assert.match(nginx, /proxy_set_header Upgrade/);
});
