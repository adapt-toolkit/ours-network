import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayCompose, gatewayNginx } from '../lib/gateway.mjs';
import { realEffects } from '../lib/effects.mjs';

const record = { schema: 2, mode: 'docker', instanceId: '12345678-1234-1234-1234-123456789abc', root: '/private/ours', workDir: '/private/ours/runtime', project: 'ours-fixture', gateway: { version: 1 }, services: ['daemon', 'cowork', 'gateway'] };
const labels = (service, project = record.project) => ({ 'com.docker.compose.project': project, 'com.docker.compose.service': service });
const gateway = { Config: { Labels: labels('gateway') }, HostConfig: { ReadonlyRootfs: true }, Mounts: [] };

function fixture(containers = {}) {
  const effects = realEffects({ env: {}, out: () => {} });
  const calls = [];
  effects.run = async (command, args) => {
    calls.push(args);
    if (args.includes('ps') && args.includes('-aq')) return { code: 0, stdout: Object.keys(containers).join('\n') };
    if (args.includes('ps')) return { code: 0, stdout: '' };
    if (args[0] === 'inspect') {
      const { state, detail } = containers[args.at(-1)];
      return { code: 0, stdout: JSON.stringify(args[2] === '{{json .State}}' ? state : { ...detail, State: state }) };
    }
    return { code: 0, stdout: '' };
  };
  return { effects, calls };
}
const exited = code => ({ Status: 'exited', ExitCode: code, OOMKilled: false, Dead: false });

test('stop sends the gateway nginx fast shutdown before the Compose stop', async () => {
  const { effects, calls } = fixture();
  await effects.serverLifecycle(record, 'stop');
  const sub = calls.map(args => args.slice(args.indexOf(record.project) + 1).join(' '));
  assert.deepEqual(sub.filter(args => /^(kill|stop)/.test(args)), ['kill -s SIGTERM gateway', 'stop gateway cowork', 'stop daemon']);
});

test('stop without a selected gateway sends no signal', async () => {
  const { effects, calls } = fixture();
  await effects.serverLifecycle(record, 'stop', ['daemon', 'cowork']);
  assert.equal(calls.some(args => args.includes('kill')), false);
});

test('newly generated gateways stop with SIGTERM', () => {
  assert.match(gatewayCompose({ ...record, port: 3050 }), /\n {4}stop_signal: SIGTERM\n/);
});

test('an earlier forced stop of the stateless gateway does not refuse state operations', async () => {
  const { effects } = fixture({ gw: { state: exited(137), detail: gateway }, daemon: { state: exited(0), detail: {} } });
  await effects.confirmDockerWritersStopped(record);
  const tmpfs = fixture({ gw: { state: exited(137), detail: { ...gateway, Mounts: [{ Type: 'tmpfs', Destination: '/tmp' }] } } });
  await tmpfs.effects.confirmDockerWritersStopped(record);
});

test('forced stops of anything holding state still refuse state operations', async () => {
  const refused = /did not stop cleanly; state operation refused/;
  for (const [name, state, detail] of [
    ['stateful service', exited(137), { ...gateway, Config: { Labels: labels('daemon') } }],
    ['gateway with a volume', exited(137), { ...gateway, Mounts: [{ Type: 'volume', Name: 'server-storage' }] }],
    ['gateway with a bind mount', exited(137), { ...gateway, Mounts: [{ Type: 'bind', Source: '/srv' }] }],
    ['writable gateway', exited(137), { ...gateway, HostConfig: { ReadonlyRootfs: false } }],
    ['foreign project gateway', exited(137), { ...gateway, Config: { Labels: labels('gateway', 'ours-other') } }],
    ['gateway without reported mounts', exited(137), { Config: gateway.Config, HostConfig: gateway.HostConfig }],
    ['gateway with null mounts', exited(137), { ...gateway, Mounts: null }],
    ['unlabelled container', exited(137), { HostConfig: { ReadonlyRootfs: true }, Mounts: [] }],
    ['running gateway', { Status: 'running', ExitCode: 0, OOMKilled: false, Dead: false }, gateway],
  ]) {
    const { effects } = fixture({ one: { state, detail } });
    await assert.rejects(effects.confirmDockerWritersStopped(record), refused, name);
  }
});

// Real engine: a gateway created without stop_signal (as installed before this
// fix) with an open proxied stream. Its plain Compose stop exceeds the grace
// period; the installer stop must still end with a clean exit.
test('installer stop cleanly exits an existing gateway holding a stream', { skip: process.env.OURS_TEST_DOCKER !== '1', timeout: 240000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'ours-gateway-stop-'));
  const project = `ours-gateway-stop-${process.pid}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  const retained = { schema: 2, mode: 'docker', containerEngine: 'docker', project, root, workDir: root, instanceId: record.instanceId, port: 0, coworkPort: 3052, gateway: { serverUrl: 'http://localhost' }, services: ['daemon', 'gateway'] };
  const compose = args => docker(['compose', '-p', project, '--project-directory', root, '-f', join(root, 'docker-compose.yaml'), '-f', join(root, 'docker-compose.gateway.yaml'), ...args]);
  const streams = [];
  t.after(() => { for (const s of streams) s.kill(); try { compose(['down', '--timeout', '3', '--remove-orphans']); } finally { try { docker(['image', 'rm', `${project}:gateway`]); } finally { rmSync(root, { recursive: true, force: true }); } } });
  writeFileSync(join(root, 'server.cjs'), `require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'text/event-stream'});s.write(':\\n\\n');}).listen(3050,'0.0.0.0');process.on('SIGTERM',()=>process.exit(0));`);
  writeFileSync(join(root, 'docker-compose.yaml'), `services:\n  daemon:\n    image: node:24\n    init: true\n    command: [node, /fixture/server.cjs]\n    volumes: ["${root}:/fixture:ro"]\n    networks:\n      ours:\n        aliases: [cowork, messenger, telegram]\n  cowork:\n    image: node:24\n  telegram:\n    image: node:24\n  messenger:\n    image: node:24\nnetworks:\n  ours: {}\n`);
  writeFileSync(join(root, 'docker-compose.gateway.yaml'), gatewayCompose(retained).replace('    stop_signal: SIGTERM\n', ''));
  writeFileSync(join(root, 'nginx.conf'), gatewayNginx(retained));
  cpSync(new URL('../assets/Dockerfile.gateway', import.meta.url), join(root, 'Dockerfile.gateway'));
  cpSync(new URL('../assets/gateway-entrypoint.sh', import.meta.url), join(root, 'gateway-entrypoint.sh'));
  const up = () => compose(['up', '-d', '--build', '--wait', 'daemon', 'gateway']);
  const gatewayExit = () => JSON.parse(docker(['inspect', '--format', '{{json .State}}', compose(['ps', '-aq', 'gateway']).trim()]));
  const holdStream = async () => {
    const port = compose(['port', 'gateway', '8080']).trim().split(':').at(-1);
    const stream = spawn('curl', ['-sN', '--max-time', '120', `http://127.0.0.1:${port}/daemon/events`], { stdio: 'ignore' });
    streams.push(stream);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(stream.exitCode, null, 'stream must still be open before stop');
  };
  const effects = realEffects({ out: () => {} });
  up();
  assert.equal(JSON.parse(docker(['inspect', '--format', '{{json .Config.StopSignal}}', compose(['ps', '-q', 'gateway']).trim()])), 'SIGQUIT');

  // Baseline: the plain Compose stop is forced and records 137 ...
  await holdStream();
  compose(['stop', 'gateway']);
  assert.equal(gatewayExit().ExitCode, 137);
  // ... which a retried state operation still accepts for this stateless gateway.
  compose(['stop', 'daemon']);
  await effects.confirmDockerWritersStopped(retained);

  // Installer stop: clean exit, well inside the grace period.
  up();
  await holdStream();
  const started = Date.now();
  await effects.serverLifecycle(retained, 'stop');
  assert.ok(Date.now() - started < 8000, `stop took ${Date.now() - started}ms`);
  assert.deepEqual([gatewayExit().ExitCode, gatewayExit().OOMKilled], [0, false]);
  await effects.confirmDockerWritersStopped(retained);
});
