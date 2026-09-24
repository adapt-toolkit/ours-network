import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Given, When, Then } from '@cucumber/cucumber';
import { attach, recordEvidence, serverNode } from './common.mjs';

When('a remote SDK client attaches to server {word} over HTTP', async function (server) {
  this.httpNode = serverNode(server);
  this.httpClient = await attach(this, this.httpNode);
});
Then('the attached client reads protected metadata from the selected server', async function () {
  const state = await this.httpClient.stateDir();
  const version = await this.httpClient.version();
  const identities = await this.httpClient.listIdentities();
  assert.equal(state.stateDir, '/state');
  assert.ok(version.version);
  assert.ok(Array.isArray(identities));
  recordEvidence(this, 'Explicit HTTP endpoint contract', {
    endpoint: this.httpNode.endpoint, expectedInstanceId: this.httpNode.instanceId,
    attached: true, stateDir: state.stateDir, version: version.version,
    identityCount: identities.length,
  });
});

const request = async (node, padding = '') => fetch(`${node.endpoint}/api/v1/listIdentities`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-ours-api-token': readFileSync(node.credentialPath, 'utf8').trim(),
    'x-ours-session-mode': 'external',
    'x-ours-lease-token': randomUUID(),
    'x-ours-client-pid': String(process.pid),
  },
  body: JSON.stringify({ padding }),
  signal: AbortSignal.timeout(20_000),
});

Given('a small authenticated JSON request to server {word} succeeds', async function (server) {
  this.requestNode = serverNode(server);
  const response = await request(this.requestNode);
  recordEvidence(this, 'Control JSON request', {
    endpoint: `${this.requestNode.endpoint}/api/v1/listIdentities`, status: response.status,
    responseBody: response.status === 200 ? undefined : (await response.clone().text()).slice(0, 4000),
  });
  assert.equal(response.status, 200, `The control request returned ${response.status}: ${await response.text()}`);
});
When('I send an authenticated JSON request with {int} MiB of padding', async function (sizeMiB) {
  this.requestPaddingBytes = sizeMiB * 1024 * 1024;
  this.largeResponse = await request(this.requestNode, 'x'.repeat(this.requestPaddingBytes));
});
Then('the server responds with status {int}', function (expectedStatus) {
  recordEvidence(this, 'Oversized JSON request', {
    endpoint: `${this.requestNode.endpoint}/api/v1/listIdentities`, requestPaddingBytes: this.requestPaddingBytes,
    expectedStatus, actualStatus: this.largeResponse.status,
  });
  assert.equal(this.largeResponse.status, expectedStatus, 'The server accepted an oversized JSON request');
});
