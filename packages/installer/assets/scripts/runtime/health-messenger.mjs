import { existsSync } from 'node:fs';

const healthy = async url => {
  try { return (await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' })).ok; } catch { return false; }
};
const notifications = process.env.OURS_NOTIFICATIONS_CONFIG && existsSync('/opt/ours/node_modules/@ours.network/notifications/package.json') && existsSync(process.env.OURS_NOTIFICATIONS_CONFIG);
process.exitCode = await healthy('http://127.0.0.1:8420/api/healthz') && (!notifications || await healthy('http://127.0.0.1:49677/healthz')) ? 0 : 1;
