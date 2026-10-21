import { attachOursClient } from '@ours.network/sdk/client';
let client;
try {
  const service = process.argv[2];
  if (!['telegram', 'cowork', 'messenger'].includes(service)) throw new Error('Unknown dependency');
  client = await attachOursClient({ endpoint: 'http://daemon:3050',
    expectedInstanceId: process.env[service === 'telegram' ? 'OURS_TG_DAEMON_ID' : 'OURS_DAEMON_ID'],
    credentialPath: `/credentials/${service}/daemon-token`,
    requiredCapabilities: ['external-sessions-v1'], sessionMode: 'external',
    leaseToken: `container-dependency-${service}`, env: {} });
  await client.listIdentities();
} catch { process.exitCode = 1; }
finally { await client?.close(); }
