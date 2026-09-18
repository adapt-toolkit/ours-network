import { checkCredential, checkRuntime, jsonConfig, recordBuild } from './runtime-common.mjs';

try {
  const state = '/var/lib/ours';
  checkRuntime(state, process.env.OURS_DAEMON_ID);
  checkCredential(`${state}/daemon-token`);
  const config = jsonConfig(`${state}/config.json`);
  if (config && ('apiToken' in config || (config.stateDir && config.stateDir !== state))) {
    throw new Error('Daemon config must use its declared state directory and current token file');
  }
  recordBuild(state);
} catch (error) {
  console.error(`OURS startup refused: ${error.message}`);
  process.exit(1);
}
