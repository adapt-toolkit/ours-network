/**
 * After a real installation: a room created by the installed Fleet admits the
 * person's own Messenger identity, not the Human root, as its Owner. Uses the
 * running published Messenger, Cowork and daemon through the installed gateway;
 * no account App, tunnel or agent is involved. Prints identities and room
 * state only: never the invitation or the credential.
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const CID = /^[0-9A-Fa-f]{64}$/;
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function verifyOwnerAdmission({ env, prefix, root, expectedCid }) {
  const profile = JSON.parse(fs.readFileSync(join(homedir(), '.ours-client', 'profile.json'), 'utf8'));
  const token = fs.readFileSync(profile.credentialPath, 'utf8').trim();
  const origin = new URL(profile.serverUrl).origin;
  const messenger = async (path, body) => {
    const response = await fetch(`${profile.serverUrl.replace(/\/$/, '')}/messenger/api/${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'X-Ours-Api-Token': token, ...(body ? { 'Content-Type': 'application/json', Origin: origin, 'X-Ours-Messenger-CSRF': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.ok(response.ok, `Messenger ${path} answered HTTP ${response.status}`);
    return response.json();
  };

  // The identity Fleet would record as Owner, exactly as tunnel setup asks for it.
  const identity = await messenger('workspace/enrollment-identity');
  assert.match(String(identity.cid), CID); assert.match(String(identity.rootCid), CID);
  assert.ok(!same(identity.cid, identity.rootCid), 'Messenger runs as an identity other than the Human root');
  assert.ok(same(identity.cid, expectedCid), 'the identity offered for enrollment is the one the installation selected');
  const child = identity.cid.toLowerCase(), humanRoot = identity.rootCid.toLowerCase();
  const invitation = (await messenger('invites', { mode: 'public' })).blob;
  assert.ok(typeof invitation === 'string' && invitation.length > 0, 'Messenger issues a public invitation for its identity');

  /** The configuration tunnel setup generates, with the Owner written as `owner`. */
  const fleetHome = (name, owner) => {
    const home = join(root, name), workspace = join(home, '.ours-fleet', 'workspace'), invite = join(workspace, 'owner.invite');
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 }); fs.mkdirSync(join(home, 'fleet', 'agents'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(invite, invitation + '\n', { mode: 0o600 });
    fs.writeFileSync(join(home, 'fleet.yaml'), `api_version: ours.network/fleet/v2\n\nrooms:\n  owner:\n    provider: messenger-server\n    expected_cid: ${owner}\n    public_invite_file: ${invite}\n    role: Owner\n  defaults:\n    attach_owner: true\n    close_when_task_done: true\n`, { mode: 0o600 });
    return home;
  };
  const fleet = (home, args) => {
    const result = spawnSync(join(prefix, 'bin', 'ours-fleet'), args, { env: { ...env, OURS_FLEET_HOME: home }, encoding: 'utf8', timeout: 180000 });
    let json; try { json = JSON.parse(result.stdout); } catch { /* reported by the caller */ }
    return { status: result.status, json, text: (result.stdout + result.stderr).split(invitation).join('<invitation>') };
  };
  const members = (home, id) => { const listed = fleet(home, ['room', 'members', id, '--json']); assert.equal(listed.status, 0, `room members failed: ${listed.text}`); return listed.json; };
  const seatOf = (member, cid) => [member.identity_cid, member.cid, member.seat_cid, member.identity].some(value => same(value, cid));
  const active = member => [member.seat_state, member.state, member.status].includes('active');

  // Written in mixed case, as a person editing the file might: the same identity must still be admitted.
  const mixed = [...child].map((char, index) => index % 2 ? char : char.toUpperCase()).join('');
  assert.ok(mixed !== child && mixed !== child.toUpperCase(), 'the expected identity is written in mixed case');
  const home = fleetHome('fleet-owner', mixed), name = `owner-gate-${randomBytes(4).toString('hex')}`;
  const created = fleet(home, ['room', 'create', '--name', name, '--goal', 'Owner admission check', '--json']);
  console.log('Room created with the Messenger identity as expected Owner:', created.text);
  assert.equal(created.status, 0, 'the installed Fleet creates a room');
  const room = created.json.room, roomId = room.room_id ?? room.id;
  assert.ok(same(room.owner_seat_cid, child), 'the Owner seat is the Messenger identity');
  assert.ok(!same(room.owner_seat_cid, humanRoot), 'the Owner seat is not the Human root');
  assert.match(String(room.room_identity_cid), CID);
  let seats;
  for (let attempt = 0; attempt < 90; attempt++) {
    seats = members(home, roomId);
    if (seats.members.some(member => seatOf(member, child) && active(member))) break;
    await wait(1000);
  }
  console.log('Room members:', JSON.stringify(seats));
  const owners = seats.members.filter(member => member.role === 'Owner' && active(member));
  assert.equal(owners.length, 1, 'exactly one active Owner');
  assert.ok(seatOf(owners[0], child), 'the active Owner is the Messenger identity');
  assert.ok(!seats.members.some(member => seatOf(member, humanRoot)), 'the Human root holds no seat');
  assert.ok(same(seats.owner_seat_cid, child));
  const shown = fleet(home, ['room', 'list', '--state', 'all', '--json']);
  console.log('Rooms:', shown.text);
  assert.equal(shown.status, 0); assert.ok(JSON.stringify(shown.json).includes('"active"'), 'the room is active once its Owner is seated');

  // The person's Messenger now holds the room as a contact, under the room's own name.
  let contact;
  for (let attempt = 0; attempt < 60 && !contact; attempt++) {
    contact = (await messenger('contacts')).contacts.find(entry => same(entry.container_id, room.room_identity_cid));
    if (!contact) await wait(1000);
  }
  assert.ok(contact, 'the room appears among the Messenger contacts of the admitted identity');
  assert.equal(contact.name, `ours-cowork:${name}`);

  // The check is real: with the Human root written as Owner, the same invitation is not admitted.
  const other = fleetHome('fleet-root-owner', humanRoot);
  const refused = fleet(other, ['room', 'create', '--name', `owner-gate-root-${randomBytes(4).toString('hex')}`, '--goal', 'Owner admission check', '--json']);
  console.log('Room created with the Human root as expected Owner:', refused.text);
  const refusedRoom = refused.json?.room;
  assert.ok(refused.status !== 0 || refusedRoom?.state !== 'active', 'a room expecting the Human root does not become active through the Messenger invitation');
  assert.ok(!refusedRoom || !same(refusedRoom.owner_seat_cid, humanRoot) || refusedRoom.state !== 'active');
  return { child, humanRoot, room: roomId };
}
