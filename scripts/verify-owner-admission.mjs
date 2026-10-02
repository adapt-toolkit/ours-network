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
  /** Runs the installed Fleet. Its raw output can carry invitation data, so only `brief` is ever printed. */
  const fleet = (home, args) => {
    const result = spawnSync(join(prefix, 'bin', 'ours-fleet'), args, { env: { ...env, OURS_FLEET_HOME: home }, encoding: 'utf8', timeout: 180000 });
    let json; try { json = JSON.parse(result.stdout); } catch { /* reported by the caller */ }
    const said = (result.stdout + result.stderr).split(invitation).join('<invitation>').replace(/[A-Za-z0-9+/_=-]{24,}/g, '<long value>').replace(/\s+/g, ' ').trim().slice(0, 300);
    return { status: result.status, signal: result.signal, json, brief: `exit ${result.status}${result.signal ? ' ' + result.signal : ''}: ${said}` };
  };
  /** What the evidence shows of a room and of a seat: identifiers, roles and states only. */
  const roomFacts = room => ({ room_id: room?.room_id, state: room?.state, provisioning_detail: room?.provisioning_detail ?? room?.orchestration?.provisioning_detail, room_identity_cid: room?.room_identity_cid ?? room?.orchestration?.room_identity_cid, owner_seat_cid: room?.owner_seat_cid ?? room?.orchestration?.owner_seat_cid });
  const seatFacts = member => ({ identity_cid: member.identity_cid, role: member.role, seat_state: member.seat_state });
  const members = (home, id) => { const listed = fleet(home, ['room', 'members', id, '--json']); assert.equal(listed.status, 0, `room members failed (${listed.brief})`); return listed.json; };
  const listed = (home, name) => { const all = fleet(home, ['room', 'list', '--state', 'all', '--json']); assert.equal(all.status, 0, `room list failed (${all.brief})`); return all.json.rooms.filter(room => room.room_name === name); };

  // Written in mixed case, as a person editing the file might: the same identity must still be admitted.
  const mixed = [...child].map((char, index) => index % 2 ? char : char.toUpperCase()).join('');
  assert.ok(mixed !== child && mixed !== child.toUpperCase(), 'the expected identity is written in mixed case');
  const home = fleetHome('fleet-owner', mixed), name = `owner-gate-${randomBytes(4).toString('hex')}`;
  const created = fleet(home, ['room', 'create', '--name', name, '--goal', 'Owner admission check', '--json']);
  assert.equal(created.status, 0, `the installed Fleet creates a room (${created.brief})`);
  const room = created.json.room, roomId = room.room_id;
  console.log('Room created with the Messenger identity as expected Owner:', JSON.stringify(roomFacts(room)));
  assert.equal(typeof roomId, 'string');
  assert.ok(same(room.owner_seat_cid, child), 'the Owner seat is the Messenger identity');
  assert.ok(!same(room.owner_seat_cid, humanRoot), 'the Owner seat is not the Human root');
  assert.match(String(room.room_identity_cid), CID);
  const seated = member => same(member.identity_cid, child) && member.seat_state === 'active';
  let seats;
  for (let attempt = 0; attempt < 90; attempt++) {
    seats = members(home, roomId);
    if (seats.members.some(seated)) break;
    await wait(1000);
  }
  console.log('Room members:', JSON.stringify(seats.members.map(seatFacts)));
  const owners = seats.members.filter(member => member.role === 'Owner' && member.seat_state === 'active');
  assert.equal(owners.length, 1, 'exactly one active Owner');
  assert.ok(same(owners[0].identity_cid, child), 'the active Owner is the Messenger identity');
  assert.ok(!seats.members.some(member => same(member.identity_cid, humanRoot)), 'the Human root holds no seat');
  assert.ok(same(seats.owner_seat_cid, child));
  const [stored, ...duplicates] = listed(home, name);
  console.log('Room as listed:', JSON.stringify(roomFacts(stored)));
  assert.equal(duplicates.length, 0); assert.equal(stored?.room_id, roomId);
  assert.equal(stored.state, 'active', 'the room is active once its Owner is seated');

  // The person's Messenger now holds the room as a contact, under the room's own name.
  let contact;
  for (let attempt = 0; attempt < 60 && !contact; attempt++) {
    contact = (await messenger('contacts')).contacts.find(entry => same(entry.container_id, room.room_identity_cid));
    if (!contact) await wait(1000);
  }
  assert.ok(contact, 'the room appears among the Messenger contacts of the admitted identity');
  assert.equal(contact.name, `ours-cowork:${name}`);

  // The check is real: with the Human root written as Owner, the same invitation is refused for that reason,
  // and the room Fleet keeps for it has no Owner and never becomes active.
  const other = fleetHome('fleet-root-owner', humanRoot), otherName = `owner-gate-root-${randomBytes(4).toString('hex')}`;
  const refused = fleet(other, ['room', 'create', '--name', otherName, '--goal', 'Owner admission check', '--json']);
  assert.equal(refused.signal, null, `the refused creation ran to its end (${refused.brief})`);
  assert.notEqual(refused.status, 0, 'a room expecting the Human root is not created through the Messenger invitation');
  const [kept, ...others] = listed(other, otherName);
  console.log('Room kept after expecting the Human root as Owner:', JSON.stringify(roomFacts(kept)));
  assert.equal(others.length, 0); assert.ok(kept, 'Fleet keeps the room it could not give an Owner');
  assert.equal(roomFacts(kept).provisioning_detail, 'owner_cid_mismatch', 'the refusal is the Owner identity mismatch');
  assert.notEqual(kept.state, 'active');
  const refusedSeats = members(other, kept.room_id).members;
  console.log('Its members:', JSON.stringify(refusedSeats.map(seatFacts)));
  assert.ok(!refusedSeats.some(member => member.seat_state === 'active' && member.role === 'Owner'), 'that room has no active Owner');
  assert.ok(!refusedSeats.some(member => same(member.identity_cid, humanRoot)), 'the Human root is not seated there either');
  return { child, humanRoot, room: roomId };
}
