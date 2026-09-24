import assert from 'node:assert/strict';

export const nodes = {
  a: { endpoint: 'http://server-a:3050', instanceId: '00000000-0000-4000-8000-00000000000a', credentialPath: '/secrets/a/daemon-token' },
  b: { endpoint: 'http://server-b:3050', instanceId: '00000000-0000-4000-8000-00000000000b', credentialPath: '/secrets/b/daemon-token' },
};

export function serverSide(label) {
  const side = label.toLowerCase();
  assert.ok(Object.hasOwn(nodes, side), `Unknown server ${label}; expected ${Object.keys(nodes).join(' or ').toUpperCase()}`);
  return side;
}
