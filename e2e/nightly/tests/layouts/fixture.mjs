// Native Fleet CLI + ACP/Codex, real local Cowork/daemon/broker.
// Scripted provider verifies context delivery, not model quality. No external model calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const fleetRoot = resolve(process.env.OURS_LAYOUT_FLEET_DIR ?? process.cwd());
const requireFleet = createRequire(join(fleetRoot, 'package.json'));
const loadPackage = name => import(pathToFileURL(requireFleet.resolve(name)));
const loadFleet = name => import(pathToFileURL(join(fleetRoot, 'dist', name)));
const { attachOursClient } = await loadPackage('@ours.network/sdk/client');
const { createCoworkAdapter } = await loadFleet('rooms-tasks/cowork-adapter.js');
const [coworkArg, rootArg, codexArg] = process.argv.slice(2);
assert(coworkArg && rootArg && codexArg, 'explicit isolated paths required');
const coworkRoot = resolve(coworkArg), root = resolve(rootArg), codex = resolve(codexArg);
mkdirSync(root, { recursive: true, mode: 0o700 });
const { startProcess, stopProcess, command: teardownCommand, createCommandScope, createCleanup, layoutSocketPaths, unusedPort, waitFor, waitForPort } = await import('./runtime.mjs');
const { coworkState, socketRoot } = layoutSocketPaths(root);
const commandScope = createCommandScope({ shutdownTimeout: 1000 });
const command = commandScope.command;
const env = { OURS_FLEET_SOCKET_ROOT: socketRoot, PATH: process.env.PATH, HOME: root, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' };
const daemonState = join(root, 'd'); mkdirSync(daemonState, { mode: 0o700 });
const daemonId = randomUUID(), daemonPort = await unusedPort(), brokerPort = await unusedPort(), coworkPort = await unusedPort();
const endpoint = `http://127.0.0.1:${daemonPort}`, credentialPath = join(daemonState, 'daemon-token');
const config = join(root, 'daemon.json'), profile = join(root, 'profile.json'), coworkConfig = join(root, 'cowork.json');
writeFileSync(config, JSON.stringify({ brokerUrl: `ws://127.0.0.1:${brokerPort}`, stateDir: daemonState, port: daemonPort, apiVisibility: 'owner', apiTokenDeliveryFiles: [] }), { mode: 0o600 });
writeFileSync(coworkConfig, JSON.stringify({ version: 1, stateDir: coworkState, rest: { enabled: true, host: '127.0.0.1', port: coworkPort } }), { mode: 0o600 });
const coworkEnv = { ...env, OURS_COWORK_CONFIG: coworkConfig, OURS_COWORK_HTTP_MANAGEMENT: '1', OURS_DAEMON_URL: endpoint, OURS_DAEMON_ID: daemonId, OURS_DAEMON_CREDENTIAL_PATH: credentialPath };
const coworkCLI = join(coworkRoot, 'dist/cli.js');
const cli = async args => { const r = JSON.parse(await command([coworkCLI, '--json', ...args], coworkEnv, coworkRoot)); assert(r.ok, JSON.stringify(r)); return r.result; };
let broker, daemon, coworkProcess, control, coworkStarted = false, gateway, provider;
const nativeInputs = [];
const evidence = { provider: 'scripted text-only provider; native Fleet CLI, ACP and Cowork; no autonomous conversation quality claim' };
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', r));
let sequence = 0;
// This dedicated process uses one isolated Fleet home for every lifecycle operation.
process.env.OURS_FLEET_HOME = join(root, 'h');
process.env.OURS_FLEET_SOCKET_ROOT = socketRoot;
let cleanupDeadline, timedOut = false;
const cleanupActions = createCleanup([
  ['commands', () => commandScope.cancel(), 2500],
  ['native supervisors', async () => {
    const tempRoot = join(root, 'h', '.ours-fleet', 'tmp');
    const { stopTempSupervisor, tempSupervisorLiveness } = await loadFleet('temp-lifecycle.js');
    const names = existsSync(tempRoot) ? readdirSync(tempRoot) : [];
    const results = await Promise.allSettled(names.map(async name => {
      const dir = join(tempRoot, name);
      if (!existsSync(join(dir, '.temp-supervisor.json'))) return;
      await stopTempSupervisor(name);
      await waitFor(async () => !existsSync(dir) || await tempSupervisorLiveness(dir) === 'stopped', `native supervisor ${name}`, 15000);
    }));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Native supervisor cleanup failed');
  }, 20000],
  ['Cowork stop', () => coworkStarted ? teardownCommand([coworkCLI, '--json', 'stop'], coworkEnv, coworkRoot, 5000) : undefined, 14000],
  ['Cowork process', () => stopProcess(coworkProcess, 'SIGTERM', 1000), 2500],
  ['control client', () => control?.close(), 3000],
  ['daemon', () => stopProcess(daemon, 'SIGTERM', 1000), 2500],
  ['broker', () => stopProcess(broker, 'SIGTERM', 1000), 2500],
  ...[() => gateway, () => provider].map((getServer, index) => [`HTTP server ${index}`, async () => {
    const server = getServer();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }, 1000]),
]);
const cleanup = () => {
  // The fixture's 300s watchdog leaves 60s before Cucumber's deadline.
  cleanupDeadline ??= setTimeout(() => { console.error('FAIL teardown deadline: resources may remain; inspect fixture log'); process.exit(124); }, 50000);
  return cleanupActions();
};
const watchdog = setTimeout(async () => {
  timedOut = true;
  console.error('FAIL fixture timeout');
  for (const error of await cleanup()) console.error(error);
  process.exit(124);
}, 300000);
let scenarioError;
try {
  broker = startProcess([join(coworkRoot, 'node_modules/.bin/adapt-broker'), '--host', '127.0.0.1', '--port', String(brokerPort), '--test_mode'], env, coworkRoot);
  await waitForPort(brokerPort);
  daemon = startProcess([resolve('node_modules/@ours.network/daemon/dist/cli.js'), 'daemon', 'serve', '--managed'], { ...env, OURS_CONFIG: config, OURS_STATE_DIR: daemonState, OURS_PORT: String(daemonPort), OURS_DAEMON_ID: daemonId }, process.cwd());
  await waitFor(async () => { assert.equal(daemon.child.exitCode, null, daemon.stderr); const r = await fetch(endpoint + '/selection'); return r.ok && (await r.json()).instanceId === daemonId && existsSync(credentialPath); }, 'daemon');
  control = await attachOursClient({ endpoint, expectedInstanceId: daemonId, credentialPath, sessionMode: 'local', requiredCapabilities: ['local-pid-v1'] });
  await control.createRootIdentity({ name: 'LayoutFixtureRoot', bio: 'isolated test', exposeLocal: true, localAutoAccept: true });
  coworkProcess = startProcess([join(coworkRoot, 'dist/daemon.js')], coworkEnv, coworkRoot);
  await waitFor(async () => { assert.equal(coworkProcess.child.exitCode, null, coworkProcess.stderr); return (await cli(['status'])).running; }, 'Cowork supervisor'); coworkStarted = true;
  gateway = createServer(async (req, res) => {
    try {
      const base = req.url.startsWith('/daemon/') ? endpoint : `http://127.0.0.1:${coworkPort}`;
      const path = req.url.startsWith('/daemon/') ? req.url.slice(7) : req.url.replace(/^\/cowork/, '');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const r = await fetch(base + path, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    } catch (error) { res.writeHead(502).end(String(error)); }
  });
  await listen(gateway);
  const serverUrl = `http://127.0.0.1:${gateway.address().port}`;
  writeFileSync(profile, JSON.stringify({ serverUrl, endpoint: serverUrl + '/daemon', expectedInstanceId: daemonId, credentialPath }), { mode: 0o600 });
  const cowork = createCoworkAdapter({ env: { ...env, OURS_CONFIG: profile } });
  assert(await cowork.available(), 'native Fleet Cowork gateway');
  provider = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      assert(req.url.endsWith('/responses'));
      const input = JSON.parse(body);
      nativeInputs.push(JSON.stringify(input.input));
      assert(!input.text?.format?.schema?.properties?.outcome, 'Unexpected action-review request: fixture never supplies review decisions');
      const id = `resp_${++sequence}`;
      const output = { type: 'message', id: `msg_${sequence}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Acknowledged' }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      emit({ type: 'response.created', response: { id, status: 'in_progress', output: [] } });
      emit({ type: 'response.output_item.added', output_index: 0, item: output });
      emit({ type: 'response.output_item.done', output_index: 0, item: output });
      emit({ type: 'response.completed', response: { id, status: 'completed', output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
    } catch (error) { res.writeHead(400).end(String(error)); }
  });
  await listen(provider);
  const modelUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  const { nativeCliScenario } = await import('./native-cli.mjs');
  const { stringify } = await loadPackage('yaml');
  await nativeCliScenario({ root, fleetRoot, profile, codex, modelUrl, command, waitFor, cowork, evidence, inputs: nativeInputs, stringify, env, loadFleet });
  writeFileSync(join(root, 'summary.json'), JSON.stringify(evidence, null, 2));
} catch (error) {
  scenarioError = error;
} finally {
  const errors = await cleanup();
  clearTimeout(watchdog); clearTimeout(cleanupDeadline);
  if (scenarioError) errors.unshift(scenarioError);
  if (timedOut) process.exit(124);
  if (errors.length) throw new AggregateError(errors, 'Fixture or cleanup failed');
}
console.log('PASS selected modes; production install and identities untouched');
