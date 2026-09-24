import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { recordEvidence, recordText, redact, sleep, until } from './common.mjs';

const cli = '/opt/ours/node_modules/.bin/ours-tg-connector';
const pidPath = '/tg-state/daemon.pid';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function launch(env) {
  const child = spawn(cli, ['serve'], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.errorText = '';
  child.stderr.on('data', chunk => { child.errorText += chunk.toString(); });
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
After(async function () {
  await stop(this.extraConnector);
  if (this.regressionDir) rmSync(this.regressionDir, { recursive: true, force: true });
  if (this.unitHome) rmSync(this.unitHome, { recursive: true, force: true });
});

Given('a separate directory contains a corrupt bot registry and a bot provision request', function () {
  this.regressionDir = mkdtempSync(join(tmpdir(), 'ours-tg-regression-'));
  this.corruptRegistry = '{"bots":[';
  writeFileSync(join(this.regressionDir, 'bots.json'), this.corruptRegistry, { mode: 0o600 });
  writeFileSync(join(this.regressionDir, 'provision.json'), JSON.stringify({
    bots: [{ name: 'regression-bot', botToken: '123456:TEST_E2E_REGRESSION' }],
    connections: [],
  }), { mode: 0o600 });
});
When('I start the connector with that directory', async function () {
  this.extraConnector = launch({
    OURS_TG_STATE_DIR: this.regressionDir,
    OURS_TG_CONTROL_PORT: String(await freePort()),
  });
  await until('bot registry processing', async () => {
    const content = readFileSync(join(this.regressionDir, 'bots.json'), 'utf8');
    return content !== this.corruptRegistry || this.extraConnector.exitCode !== null ? true : undefined;
  }, 15_000);
});
Then('the original corrupt registry remains available for recovery', function () {
  const actual = readFileSync(join(this.regressionDir, 'bots.json'), 'utf8');
  recordEvidence(this, 'Corrupt registry recovery', {
    registryPath: join(this.regressionDir, 'bots.json'), original: this.corruptRegistry,
    actual, connectorExitCode: this.extraConnector.exitCode,
    connectorStderr: this.extraConnector.errorText.slice(-8000),
  });
  assert.equal(actual, this.corruptRegistry,
    'The connector overwrote the corrupt registry and lost the existing tokens');
  assert.match(this.extraConnector.errorText, /bots\.json|registry|JSON|Unexpected token/i,
    'Startup must stop because of the registry error, not an unrelated failure');
});

Given('the primary Telegram connector is already running', function () {
  this.originalPid = Number(readFileSync(pidPath, 'utf8').trim());
  assert.ok(alive(this.originalPid), 'The primary connector is not running');
});
When('I start a second serve process with the same state and port', async function () {
  this.extraConnector = launch({});
  await until('second connector exit', () => this.extraConnector.exitCode !== null ? true : undefined, 15_000);
});
Then('CLI status still identifies the primary connector', function () {
  let registeredPid;
  try { registeredPid = Number(readFileSync(pidPath, 'utf8').trim()); } catch { registeredPid = null; }
  const status = execFileSync(cli, ['status'], { timeout: 10_000, encoding: 'utf8' });
  recordEvidence(this, 'Duplicate connector process', {
    pidPath, originalPid: this.originalPid, primaryAlive: alive(this.originalPid),
    registeredPid, secondExitCode: this.extraConnector.exitCode,
    secondSignal: this.extraConnector.signalCode,
    secondStderr: this.extraConnector.errorText.slice(-8000),
    publicStatus: status,
  });
  assert.match(status, /ours-tg-connector: running/);
  assert.match(status, /\(reachable\)/, 'The primary connector control API is unreachable');
  assert.match(status, new RegExp(`pid:\\s+${this.originalPid}\\b`),
    'CLI status lost the primary connector process identity after concurrent startup');
});

Given('the Telegram state path contains spaces', function () {
  this.unitHome = mkdtempSync(join(tmpdir(), 'ours-tg-unit-'));
  this.spacedState = join(this.unitHome, 'state with spaces');
  mkdirSync(this.spacedState);
  const bin = join(this.unitHome, 'bin');
  mkdirSync(bin);
  for (const name of ['systemctl', 'loginctl']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  this.unitEnv = {
    ...process.env,
    HOME: this.unitHome,
    PATH: `${bin}:${process.env.PATH}`,
    OURS_TG_STATE_DIR: this.spacedState,
  };
});
When('I install a test systemd unit through the CLI', function () {
  try {
    this.installOutput = execFileSync(cli, ['install-service'], {
      env: this.unitEnv, timeout: 10_000, stdio: 'pipe',
    }).toString();
  } catch (error) {
    recordEvidence(this, 'systemd installer command', {
      statePath: this.spacedState, exitStatus: error.status,
      stdout: error.stdout?.toString().slice(-8000), stderr: error.stderr?.toString().slice(-8000),
    });
    throw error;
  }
  this.unit = readFileSync(join(this.unitHome, '.config/systemd/user/ours-telegram.service'), 'utf8');
});
Then('systemd receives the complete state path as one value', function () {
  const line = this.unit.split('\n').find(row => row.startsWith('Environment=OURS_TG_STATE_DIR=') || row.startsWith('Environment="OURS_TG_STATE_DIR='));
  recordEvidence(this, 'systemd state path', {
    expectedPath: this.spacedState, actualEnvironmentLine: line ?? null,
    installerOutput: this.installOutput,
    acceptedForms: [
      `Environment="OURS_TG_STATE_DIR=${this.spacedState}"`,
      `Environment=OURS_TG_STATE_DIR="${this.spacedState}"`,
      `Environment=OURS_TG_STATE_DIR=${this.spacedState.replaceAll(' ', '\\x20')}`,
    ],
  });
  recordText(this, 'ours-telegram.service', this.unit.split('\n').map(row =>
    /^Environment="?[^=]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)[^=]*=/i.test(row)
      ? row.replace(/=.*/, '=[REDACTED]') : row).join('\n'));
  assert.ok(line, 'The unit file has no OURS_TG_STATE_DIR setting');
  // systemd splits unquoted whitespace into separate assignments.
  const value = line.slice('Environment='.length);
  assert.ok(value === `"OURS_TG_STATE_DIR=${this.spacedState}"` ||
    value === `OURS_TG_STATE_DIR="${this.spacedState}"` ||
    value === `OURS_TG_STATE_DIR=${this.spacedState.replaceAll(' ', '\\x20')}`,
    `The path with spaces is unquoted and will be split by systemd: ${line}`);
});

const mock = (path, body) => fetch(`http://telegram-mock:8080${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(response => response.json());

Given('Telegram accepts an outgoing POST but drops its response', async function () {
  await mock('/reset');
  await mock('/drop-next-send');
});
When('Telegram delivers an id command to the bot', async function () {
  const registered = await fetch('http://127.0.0.1:3051/bots', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'retry-regression', botToken: '123456:TEST_RETRY' }),
  });
  assert.equal(registered.status, 201, await registered.text());
  await until('first getUpdates after registration', async () => {
    const { requests } = await fetch('http://telegram-mock:8080/requests').then(response => response.json());
    return requests.some(row => row.path?.endsWith('/getUpdates')) ? true : undefined;
  }, 10_000);
  await mock('/enqueue', {
    update_id: 9001,
    message: { message_id: 51, date: Math.floor(Date.now() / 1000), chat: { id: 7001, type: 'private' }, from: { id: 42, first_name: 'E2E' }, text: '/id' },
  });
  await until('outgoing sendMessage and next polling cycle', async () => {
    const { requests } = await fetch('http://telegram-mock:8080/requests').then(response => response.json());
    const firstSend = requests.findIndex(row => row.path?.endsWith('/sendMessage'));
    return firstSend >= 0 && requests.slice(firstSend + 1).some(row => row.path?.endsWith('/getUpdates')) ? true : undefined;
  }, 15_000);
});
Then('the connector does not resend the same response', async function () {
  const { requests } = await fetch('http://telegram-mock:8080/requests').then(response => response.json());
  const sends = requests.filter(row => row.path?.endsWith('/sendMessage'));
  const sendCount = sends.length;
  recordEvidence(this, 'Telegram mock requests', {
    expectedSendCount: 1, actualSendCount: sendCount,
    requests: redact(requests.slice(-30)),
  });
  assert.ok(sends.every(row => {
    const body = JSON.parse(row.body);
    return Number(body.chat_id) === 7001 && body.text?.includes('chat id: 7001');
  }), 'The connector sent an unrelated response instead of answering the chat command');
  assert.equal(sendCount, 1,
    'The connector retried a non-idempotent POST after its response was lost');
});
