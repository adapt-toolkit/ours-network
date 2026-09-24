import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, When, Then } from '@cucumber/cucumber';
import { attach, ensureRoot, nodes, root, serverSide, until } from './common.mjs';

function person(world, name) {
  const entry = world.people?.get(name);
  assert.ok(entry, `Identity ${name} has not been prepared in this scenario`);
  return entry;
}
Given('root identity {string} exists on server {word}', async function (name, server) {
  const side = serverSide(server);
  assert.ok(!this.people?.has(name), `Identity ${name} is already defined in this scenario`);
  const client = await ensureRoot(this, side, name);
  (this.people ??= new Map()).set(name, { client, side });
  assert.equal((await client.currentIdentity()).name, name);
});

When('{string} creates a one-time invitation for {string}', async function (inviter, invitee) {
  this.invite = await person(this, inviter).client.generateInvite({ name: invitee });
  this.invitation = { inviter, invitee };
  assert.equal(this.invite.mode, 'one_time');
});
When('{string} adds {string} using the invitation', async function (owner, contactName) {
  assert.deepEqual(this.invitation, { inviter: contactName, invitee: owner });
  const client = person(this, owner).client;
  this.contact = await client.addContact({ invite: this.invite.blob, name: contactName });
  this.contactOwner = owner;
  assert.ok(this.contact.cid);
  await until(`${contactName} in ${owner} contacts`, async () => {
    const view = await client.listContacts();
    return view.contacts.some(row => row.name === contactName) ? view : undefined;
  });
});
When('{string} sends {string} a message', async function (sender, receiver) {
  assert.equal(this.contactOwner, sender);
  const body = `nightly-e2e-${randomUUID()}`;
  const sent = await person(this, sender).client.sendMessage({ contact: this.contact.display, text: body });
  assert.equal(sent.sent, true);
  this.message = { sender, receiver, body, sent };
});
Then('{string} receives the message and sees it in history', async function (receiver) {
  assert.equal(receiver, this.message.receiver);
  const client = person(this, receiver).client;
  await until(`${receiver} message`, async () => {
    const inbox = await client.listIncomingMessages();
    return inbox.some(message => message.wire_id === this.message.sent.wire_id) ? inbox : undefined;
  });
  assert.ok((await client.getMessages()).messages.some(message => message.body === this.message.body));
  assert.equal((await client.getHistoryItem({ wire_id: this.message.sent.wire_id })).body, this.message.body);
  assert.equal((await client.listIncomingMessages()).length, 0);
});
When('{string} sends {string} a text file named {string}', async function (sender, receiver, filename) {
  assert.equal(this.contactOwner, sender);
  const bytes = Buffer.from(`file-${randomUUID()}\n`, 'utf8');
  const sent = await person(this, sender).client.sendFile({
    contact: this.contact.display, data_base64: bytes.toString('base64'),
    filename, mime: 'text/plain',
  });
  assert.equal(sent.sent, true);
  this.file = { sender, receiver, filename, bytes, sent };
});
Then('{string} receives the same bytes and cannot retrieve the file twice', async function (receiver) {
  assert.equal(receiver, this.file.receiver);
  const client = person(this, receiver).client;
  await until(`${receiver} file`, async () => {
    const files = await client.listIncomingFiles();
    return files.some(file => file.wire_id === this.file.sent.wire_id) ? files : undefined;
  });
  const pulled = await client.getFiles({ wire_ids: [this.file.sent.wire_id] });
  assert.equal(pulled.files[0].filename, this.file.filename);
  assert.deepEqual(Buffer.from(await client.fetchFile(this.file.sent.wire_id)), this.file.bytes);
  await assert.rejects(client.getFiles({ wire_ids: [this.file.sent.wire_id] }));
});
When('{string} replies to {string}', async function (sender, receiver) {
  const client = person(this, sender).client;
  const contact = (await client.listContacts()).contacts.find(row => row.name === receiver);
  assert.ok(contact, `${receiver} is not in ${sender}'s contacts`);
  const body = `reply-${randomUUID()}`;
  const sent = await client.sendMessage({ contact: contact.name, text: body });
  assert.equal(sent.sent, true);
  this.reply = { sender, receiver, body, sent };
});
Then('{string} receives the reply from {string}', async function (receiver, sender) {
  assert.equal(receiver, this.reply.receiver);
  assert.equal(sender, this.reply.sender);
  const client = person(this, receiver).client;
  await until(`${receiver} reply`, async () => {
    const inbox = await client.listIncomingMessages();
    return inbox.some(message => message.wire_id === this.reply.sent.wire_id) ? inbox : undefined;
  });
  assert.ok((await client.getMessages()).messages.some(message => message.body === this.reply.body));
  assert.deepEqual(await person(this, this.invitation.inviter).client.revokeInvite({ invite_id: this.invite.inviteId }),
    { revoked: false, wasPublic: false });
});

Then('{string} cannot create a named public invitation for {string}', async function (owner, target) {
  await assert.rejects(person(this, owner).client.generateInvite({ name: target, mode: 'public' }));
});
Then('{string} rejects a malformed invitation', async function (owner) {
  await assert.rejects(person(this, owner).client.addContact({ invite: 'not-a-valid-invite' }));
});
When('{string} creates a public invitation', async function (owner) {
  this.publicInvite = await person(this, owner).client.generateInvite({ mode: 'public' });
  this.publicInviteOwner = owner;
  assert.equal(this.publicInvite.mode, 'public');
});
Then('{string} sees the invitation and can revoke it only once', async function (owner) {
  assert.equal(owner, this.publicInviteOwner);
  const client = person(this, owner).client;
  assert.ok((await client.listInvites()).some(row => row.invite_id === this.publicInvite.inviteId));
  assert.deepEqual(await client.revokeInvite({ invite_id: this.publicInvite.inviteId }), { revoked: true, wasPublic: true });
  assert.deepEqual(await client.revokeInvite({ invite_id: this.publicInvite.inviteId }), { revoked: false, wasPublic: false });
});

When('two external clients select {string} on server {word}', async function (name, server) {
  const side = serverSide(server);
  assert.equal(person(this, name).side, side);
  await person(this, name).client.releaseLease();
  this.first = await attach(this, nodes[side]);
  this.second = await attach(this, nodes[side]);
  this.busyIdentity = name;
  await this.first.chooseIdentity({ name, force: false });
});
Then('the second client can take {string} only with explicit force', async function (name) {
  assert.equal(name, this.busyIdentity);
  assert.equal((await this.second.listIdentities()).find(item => item.name === name).session, 'other-live');
  await assert.rejects(this.second.chooseIdentity({ name, force: false }));
  await this.second.chooseIdentity({ name, force: true });
  assert.equal((await this.second.currentIdentity()).name, name);
  assert.equal((await this.first.listIdentities()).find(item => item.name === name).session, 'other-live');
});

Then('{string} exists only on server {word} and {string} only on server {word}', async function (firstName, firstServer, secondName, secondServer) {
  assert.equal(person(this, firstName).side, serverSide(firstServer));
  assert.equal(person(this, secondName).side, serverSide(secondServer));
  const [first, second] = await Promise.all([
    person(this, firstName).client.listIdentities(), person(this, secondName).client.listIdentities(),
  ]);
  assert.ok(first.some(item => item.name === firstName && item.kind === 'root'));
  assert.ok(second.some(item => item.name === secondName && item.kind === 'root'));
  assert.equal(first.some(item => item.name === secondName), false);
  assert.equal(second.some(item => item.name === firstName), false);
});
Then('creating {string} again on server {word} is rejected', async function (name, server) {
  assert.equal(person(this, name).side, serverSide(server));
  await assert.rejects(person(this, name).client.createRootIdentity(root(name)));
});
