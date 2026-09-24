import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { attachOursClient } from '@ours.network/sdk/client';
import { nodes, serverSide } from './topology.mjs';

const side = serverSide(process.argv[2]);
const name = process.argv[3] ?? `SeedRoot-${side}`;
const node = nodes[side];
const client = await attachOursClient({
  endpoint: node.endpoint, expectedInstanceId: node.instanceId,
  credentialPath: node.credentialPath, sessionMode: 'external', leaseToken: randomUUID(),
});
try {
  const existing = (await client.listIdentities()).find(identity => identity.kind === 'root');
  if (existing) throw new Error(`Server ${side} already has root ${existing.name}`);
  const created = await client.createRootIdentity({
    name, bio: `E2E ${name}`, exposeLocal: false, localAutoAccept: true, skipIfRootExists: false,
  });
  assert.equal(created.hierarchy, 'root');
  console.log(`Seeded root on server ${side}`);
} finally {
  await client.releaseLease().catch(() => {});
  await client.close();
}
