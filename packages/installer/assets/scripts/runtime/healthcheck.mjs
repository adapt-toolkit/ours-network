import { attachOursClient } from '@ours.network/sdk/client';

// Liveness: the anonymous selection route answers without authentication or
// state, so a failure here means the daemon is down or its event loop is stalled.
// Readiness: an authenticated external session can list identities.
// Only a fixed classification is printed; error text may carry private detail.
const report = (stage, reason) => {
  console.log(`OURS_PROBE ${stage}:${reason}`);
  console.error(`Daemon API is not ready (${stage}: ${reason})`);
  process.exitCode = 1;
};
const LIVENESS_TIMEOUT_MS = 3_000;
const READINESS_TIMEOUT_MS = 10_000;

let live = false;
try {
  const response = await fetch('http://127.0.0.1:3050/selection', { signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS), redirect: 'error' });
  await response.body?.cancel();
  if (response.ok) live = true;
  else report('liveness', 'http');
} catch (error) {
  report('liveness', error?.name === 'TimeoutError' ? 'timeout' : 'unreachable');
}

if (live) {
  let client, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(), { name: 'TimeoutError' })), READINESS_TIMEOUT_MS); });
  try {
    await Promise.race([deadline, (async () => {
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
    })()]);
  } catch (error) {
    const text = String(error?.message ?? '');
    report('readiness', error?.name === 'TimeoutError' ? 'timeout'
      : /instance selection metadata|expected daemon instance/i.test(text) ? 'instance'
        : /required capabilities/i.test(text) ? 'capability'
          : /\b401\b|unauthori[sz]ed|credential|token/i.test(text) ? 'auth' : 'error');
  } finally {
    clearTimeout(timer);
    await client?.close().catch(() => {});
  }
}
