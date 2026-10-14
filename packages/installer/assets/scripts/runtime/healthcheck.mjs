import { attachOursClient } from '@ours.network/sdk/client';
let client;
try {
  client = await attachOursClient({
    endpoint: 'http://127.0.0.1:3050',
    expectedInstanceId: process.env.OURS_DAEMON_ID,
    credentialPath: '/var/lib/ours/daemon-token',
    requiredCapabilities: ['external-sessions-v1'],
    sessionMode: 'external',
    leaseToken: 'container-readiness',
    env: {},
  });
  await client.listIdentities();
} catch {
  console.error('Daemon API is not ready');
  process.exitCode = 1;
} finally { await client?.close(); }
