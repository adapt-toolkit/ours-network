import { checkCredential, checkRuntime, jsonConfig, privatePath, recordBuild } from './runtime-common.mjs';

try {
  const service = process.argv[2];
  if (!['telegram', 'cowork', 'messenger'].includes(service)) throw new Error('Unknown client service');
  const state = `/var/lib/ours-${service}`;
  checkRuntime(state, process.env[service === 'telegram' ? 'OURS_TG_DAEMON_ID' : 'OURS_DAEMON_ID']);
  privatePath(`/credentials/${service}`, true);
  checkCredential(`/credentials/${service}/daemon-token`);
  const config = jsonConfig(`${state}/config.json`);
  if (service === 'cowork' && (!config || config.stateDir !== state || config.rest?.enabled !== true)) {
    throw new Error('Cowork config must enable REST and use its declared state directory');
  }
  if (service === 'messenger' && !process.env.OURS_MESSENGER_IDENTITY?.trim()) {
    throw new Error('Configure a messenger identity');
  }
  recordBuild(state);
} catch (error) {
  console.error(`OURS client startup refused: ${error.message}`);
  process.exit(1);
}
