import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { attach, attachDaemonRoot, nodes, root, until, recordEvidence } from './common.mjs';

Given('two independent SDK sessions on server A with a Human identity', async function () {
  this.owner = await attachDaemonRoot(this, 'a', 'SecurityRoot');
  this.other = await attach(this, nodes.a);
});
When('the first session creates a temporary identity', async function () {
  this.tempName = `temp-${randomUUID()}`;
  await this.owner.createTemporaryIdentity(root(this.tempName));
  assert.equal((await this.owner.currentIdentity()).name, this.tempName);
});
Then('the second session cannot bind force-bind delete or close that identity', async function () {
  for (const force of [false, true]) await assert.rejects(this.other.chooseIdentity({ name: this.tempName, force }), { code: 'TEMP_OWNED_ELSEWHERE' });
  await assert.rejects(this.other.removeIdentity({ name: this.tempName }), { code: 'TEMP_OWNED_ELSEWHERE' });
  await assert.rejects(this.other.closeTemporaryIdentityOp({ name: this.tempName }), { code: 'TEMP_OWNED_ELSEWHERE' });
  assert.equal((await this.owner.currentIdentity()).name, this.tempName);
});
When('the first session retires its temporary identity', async function () {
  await this.owner.closeTemporaryIdentityOp({ name: this.tempName });
});
Then('the identity is absent and the second session remains usable', async function () {
  assert.ok(!(await this.other.listIdentities()).some(x => x.name === this.tempName));
  assert.ok((await this.other.version()).version);
});
Given('private message and file state exists between two servers', async function () {
  this.sender = await attachDaemonRoot(this, 'a', 'Sender');
  this.receiver = await attachDaemonRoot(this, 'b', 'Receiver');
  this.receiverName = (await this.receiver.currentIdentity()).name;
  const invitation = await this.receiver.generateInvite();
  this.peer = await this.sender.addContact({ invite: invitation.blob });
  await until('contact establishment', async () => (await this.sender.listContacts()).contacts.some(x => x.cid === this.peer.cid || x.name === this.peer.display) ? true : undefined);
  this.privateText = `private-${randomUUID()}`;
  this.message = await this.sender.sendMessage({ contact: this.peer.display, text: this.privateText });
  this.bytes = Buffer.from(`secret fixture ${randomUUID()}`);
  this.file = await this.sender.sendFile({ contact: this.peer.display, data_base64: this.bytes.toString('base64'), filename: 'private.txt', mime: 'text/plain' });
  assert.equal(this.file.sent, true);
  await until('private file arrives', async () => (await this.receiver.listIncomingFiles()).some(x => x.wire_id === this.file.wire_id) ? true : undefined);
  await until('private message arrives', async () => (await this.receiver.listIncomingMessages()).some(x => x.wire_id === this.message.wire_id) ? true : undefined);
});
When('another identity tries to retrieve that history and file', async function () {
  this.other = await attach(this, nodes.b);
  await this.other.createIdentity(root(`outsider-${randomUUID()}`));
  await assert.rejects(this.other.fetchFile(this.file.wire_id));
  const item = await this.other.getHistoryItem({ wire_id: this.message.wire_id }).catch(() => null);
  assert.ok(item == null, 'Cross-identity history was disclosed');
  assert.ok(!(await this.other.listHistory({ limit: 200 })).items.some(x => x.wire_id === this.message.wire_id));
});
Then('access is denied and the original recipient still reads the same bytes', async function () {
  assert.equal((await this.receiver.getHistoryItem({ wire_id: this.message.wire_id })).body, this.privateText);
  assert.deepEqual(Buffer.from(await this.receiver.fetchFile(this.file.wire_id)), this.bytes);
});
When('the recipient submits duplicate malformed and mixed unknown file selections', async function () {
  for (const ids of [[this.file.wire_id,this.file.wire_id], ['invalid'], [this.file.wire_id,'0'.repeat(64)]]) {
    await assert.rejects(this.receiver.getFiles({ wire_ids: ids }));
  }
});
Then('every selection is rejected and the valid file is still unread', async function () {
  assert.ok((await this.receiver.listIncomingFiles()).some(x => x.wire_id === this.file.wire_id));
  const pulled = await this.receiver.getFiles({ wire_ids: [this.file.wire_id] });
  assert.equal(pulled.files.length, 1);
  assert.deepEqual(Buffer.from(await this.receiver.fetchFile(this.file.wire_id)), this.bytes);
});
When('three uniquely identified messages are sent and drained one at a time', async function () {
  await this.receiver.getMessages();
  this.sentIds = [];
  for (let i=0;i<3;i++) {
    const sent = await this.sender.sendMessage({ contact: this.peer.display, text: `batch-${i}-${randomUUID()}` });
    assert.equal(sent.sent, true); this.sentIds.push(sent.wire_id);
  }
  await until('all batch messages arrive', async () => {
    const ids = new Set((await this.receiver.listIncomingMessages()).map(x => x.wire_id));
    return this.sentIds.every(id => ids.has(id)) ? true : undefined;
  });
  this.drained = [];
  for (let i=0;i<3;i++) {
    const batch = await this.receiver.getMessages({ limit: 1 });
    assert.equal(batch.messages.length, 1); this.drained.push(batch.messages[0].wire_id);
  }
});
Then('each message is observed once and history pagination preserves all three', async function () {
  assert.deepEqual([...this.drained].sort(), [...this.sentIds].sort());
  assert.equal((await this.receiver.getMessages()).messages.length, 0);
  const seen = []; let cursor;
  for(let page=0;page<10;page++) {
    const result = await this.receiver.listHistory({ limit: 1, direction: 'in', ...(cursor ? { before_seq: cursor } : {}) });
    seen.push(...result.items.map(x => x.wire_id));
    if (!result.next_cursor) break;
    assert.notEqual(result.next_cursor,cursor); cursor=result.next_cursor;
  }
  assert.equal(new Set(seen).size,seen.length);
  assert.ok(this.sentIds.every(id => seen.includes(id)));
});
When('the published MCP proxy starts with a private remote profile', async function () {
  this.mcpDir = mkdtempSync(join(tmpdir(), 'ours-e2e-mcp-'));
  const profile = join(this.mcpDir,'profile.json');
  writeFileSync(profile,JSON.stringify({ endpoint:nodes.a.endpoint,expectedInstanceId:nodes.a.instanceId,credentialPath:nodes.a.credentialPath }),{mode:0o600});
  this.transport = new StdioClientTransport({command:'/opt/ours/node_modules/.bin/ours-mcp',args:['proxy'],env:{...process.env,OURS_CONFIG:profile,OURS_MCP_CONFIG:join(this.mcpDir,'mcp.json'),CLAUDE_CODE_SESSION_ID:`e2e-${randomUUID()}`},stderr:'pipe'});
  this.mcp = new Client({name:'e2e',version:'1'});
  await this.mcp.connect(this.transport);
});
Then('MCP discovers tools creates and closes a temporary identity and rejects invalid input', async function () {
  const tools = await this.mcp.listTools();
  for(const name of ['create_temporary_identity','close_temporary_identity','current_identity']) assert.ok(tools.tools.some(t=>t.name===name));
  const name=`mcp-${randomUUID()}`;
  const created=await this.mcp.callTool({name:'create_temporary_identity',arguments:{name}});
  assert.notEqual(created.isError,true);
  assert.ok((await this.other.listIdentities()).some(x=>x.name===name));
  const invalid=await this.mcp.callTool({name:'add_contact',arguments:{invite:'invalid'}});
  assert.equal(invalid.isError,true);
  const closed=await this.mcp.callTool({name:'close_temporary_identity',arguments:{name}});
  assert.notEqual(closed.isError,true);
  assert.ok(!(await this.other.listIdentities()).some(x=>x.name===name));
  recordEvidence(this,'MCP process boundary',{discovered:tools.tools.length,temporaryRetired:true,invalidInputRejected:true});
});
After(async function () {
  if(this.mcp) await this.mcp.close();
  if(this.transport) await this.transport.close();
  if(this.mcpDir) rmSync(this.mcpDir,{recursive:true,force:true});
});
