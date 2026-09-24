import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Given, When, Then } from '@cucumber/cucumber';
import { attach, nodes } from './common.mjs';

Given('I run checks from a client container', function () {
  const side = process.env.CLIENT_TARGET;
  assert.ok(side === 'a' || side === 'b', 'CLIENT_TARGET must be a or b');
  this.node = nodes[side];
  this.other = nodes[side === 'a' ? 'b' : 'a'];
});

When('I request selection metadata from both servers', async function () {
  this.selections = await Promise.all(Object.values(nodes).map(async node => {
    const response = await fetch(`${node.endpoint}/selection`);
    return { node, response, body: await response.json() };
  }));
});
Then('each server reports its expected instance ID', function () {
  for (const { node, response, body } of this.selections) {
    assert.equal(response.status, 200);
    assert.equal(body.instanceId, node.instanceId);
    assert.ok(body.capabilities.includes('external-sessions-v1'));
  }
});

When('I request private metadata without a credential and with an invalid credential', async function () {
  this.privateResponses = [];
  for (const node of Object.values(nodes)) {
    for (const headers of [{}, { 'x-ours-api-token': 'not-a-credential' }]) {
      this.privateResponses.push(await fetch(`${node.endpoint}/state-dir`, { headers }));
    }
  }
});
Then('every request is rejected with status 401', function () {
  for (const response of this.privateResponses) assert.equal(response.status, 401);
});

When('I attach to the assigned server with its issued credential', async function () {
  this.client = await attach(this, this.node);
});
Then('I can read the state directory, version, and identities', async function () {
  assert.equal((await this.client.stateDir()).stateDir, '/state');
  assert.ok((await this.client.version()).version);
  assert.ok(Array.isArray(await this.client.listIdentities()));
  assert.equal(typeof (await this.client.historyStorage()), 'object');
});

When("I provide the other server's instance ID", async function () {
  try {
    this.mismatchClient = await attach(this, { ...this.node, instanceId: this.other.instanceId });
  } catch (error) { this.mismatchError = error; }
});
Then('the SDK refuses to send a credentialed request', function () {
  assert.equal(this.mismatchClient, undefined);
  assert.match(String(this.mismatchError), /mismatch|metadata/i);
});

When('I use my credential against the other server', async function () {
  const token = readFileSync(this.node.credentialPath, 'utf8').trim();
  this.otherResponse = await fetch(`${this.other.endpoint}/state-dir`, { headers: { 'x-ours-api-token': token } });
});
Then('the server rejects the request with status 401', function () {
  assert.equal(this.otherResponse.status, 401);
});
