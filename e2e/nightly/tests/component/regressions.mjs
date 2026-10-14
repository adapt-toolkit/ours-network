import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { createOursMcpServer } from '@ours.network/mcp/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebSocketServer } from 'ws';
import { connectAppServer } from '@ours.network/codex/src/app-server-client.mjs';
import { recordEvidence } from '../steps/common.mjs';

After(async function () {
  await this.mcpClient?.close();
  await this.mcpServer?.close();
  if (this.fileRegressionDir) rmSync(this.fileRegressionDir, { recursive: true, force: true });
  for (const socket of this.wsServer?.clients ?? []) socket.terminate();
  if (this.wsServer) await new Promise(resolve => this.wsServer.close(resolve));
});
Given('the destination file contains {string}', function (content) {
  this.fileRegressionDir = mkdtempSync(join(tmpdir(), 'ours-mcp-regression-'));
  this.destination = join(this.fileRegressionDir, 'existing.txt');
  this.originalContent = content;
  writeFileSync(this.destination, content);
});
When('MCP save_file receives an interrupted byte stream', async function () {
  const sdk = {
    openFile: async () => new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial replacement'));
        queueMicrotask(() => controller.error(new Error('transfer interrupted')));
      },
    }),
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  this.mcpServer = createOursMcpServer(sdk, 'regression', { list: async () => [] });
  this.mcpClient = new Client({ name: 'regression', version: '1' });
  await this.mcpServer.connect(serverTransport);
  await this.mcpClient.connect(clientTransport);
  this.saveResult = await this.mcpClient.callTool({ name: 'save_file', arguments: { wire_id: 'ABC', dest_path: this.destination } });
});
Then('the call fails and the existing file remains unchanged', function () {
  const actual = readFileSync(this.destination, 'utf8');
  recordEvidence(this, 'Interrupted MCP save_file', {
    destination: this.destination, expectedContent: this.originalContent, actualContent: actual,
    toolIsError: this.saveResult.isError, toolContent: this.saveResult.content,
  });
  assert.equal(this.saveResult.isError, true, 'An interrupted stream must make save_file fail');
  assert.equal(actual, this.originalContent,
    'save_file destroyed the existing content after an interruption');
});

Given('a test WebSocket accepts connections but does not answer initialize', async function () {
  this.wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => this.wsServer.once('listening', resolve));
  this.wsUrl = `ws://127.0.0.1:${this.wsServer.address().port}`;
  this.wsAccepted = new Promise(resolve => this.wsServer.once('connection', socket => resolve(socket)));
});
When('the Codex client times out after {int} ms waiting for initialize', async function (timeoutMs) {
  await assert.rejects(() => connectAppServer(this.wsUrl, { timeoutMs, openTimeoutMs: 1000 }), /initialize timed out/);
  this.wsSocket = await this.wsAccepted;
});
Then('the WebSocket connection closes within {int} ms', async function (closeTimeoutMs) {
  recordEvidence(this, 'Codex initialize timeout', {
    webSocketUrl: this.wsUrl, expectedState: 'CLOSED', actualReadyState: this.wsSocket.readyState,
    connectionCount: this.wsServer.clients.size,
  });
  if (this.wsSocket.readyState === this.wsSocket.CLOSED) return;
  await Promise.race([
    new Promise(resolve => this.wsSocket.once('close', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('The WebSocket remained open after initialize timed out')), closeTimeoutMs)),
  ]);
});
