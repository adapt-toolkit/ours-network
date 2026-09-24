import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { attach, attachDaemonRoot, nodes, recordEvidence, root, serverSide, until } from './common.mjs';

const execFile = promisify(execFileCallback);
const bin = name => `/opt/ours/node_modules/.bin/${name}`;
async function command(world, name, args, timeout = 120_000) {
  try {
    const { stdout, stderr } = await execFile(bin(name), args, {
      timeout, maxBuffer: 2 * 1024 * 1024,
    });
    const value = JSON.parse(stdout);
    if (name === 'ours-fleet' && args[0] === 'task' && args[1] === 'create') {
      recordEvidence(world, 'Fleet task creation response', {
        taskId: value.task?.task_id, roomId: value.task?.room_id, state: value.task?.state,
        provisioning: value.provisioning?.kind, members: value.provisioning?.members,
      });
    } else if (!args.some(arg => ['participants', 'history', 'show'].includes(arg))) {
      recordEvidence(world, `${name} ${args.filter(arg => arg !== '--json').slice(0, 3).join(' ')}`, {
        result: value, stderr: stderr.slice(-3000),
      });
    }
    if (name === 'ours-cowork') {
      assert.equal(value.ok, true, `Cowork rejected command`);
      return value.result;
    }
    return value;
  } catch (error) {
    recordEvidence(world, `${name} failed`, {
      args, exitCode: error.code, output: "Omitted: command output may contain invite material",
    });
    throw error;
  }
}
const cowork = (world, ...args) => command(world, 'ours-cowork', ['--json', ...args]);
const fleet = (world, ...args) => command(world, 'ours-fleet', [...args, '--json']);

Given('Cowork is connected to server {word}', async function (server) {
  const side = serverSide(server);
  this.hostSide = side;
  process.env.OURS_COWORK_CONFIG = `/cowork/${side}/config.json`;
  await attachDaemonRoot(this, side, `RoomHost-${side}`);
  const status = await cowork(this, 'status');
  assert.equal(status.running, true);
});

When('the operator creates Cowork room {string} for goal {string}', async function (name, goal) {
  this.room = await cowork(this, 'room', 'create', '--name', name, '--goal', goal,
    '--briefing', 'Share findings in the room');
  assert.ok(this.room.room_id);
  assert.ok(this.room.identity_cid);
});

When('identity {string} on server {word} joins the room as {string}', async function (name, server, role) {
  const client = await attachDaemonRoot(this, serverSide(server), `RoomGuestRoot-${server}`);
  const identity = await client.createIdentity(root(name));
  const invite = await cowork(this, 'room', 'invite', this.room.room_id, '--role', role);
  assert.ok(invite.blob, 'Cowork must issue a real invitation');
  const contact = await client.addContact({ invite: invite.blob });
  this.participant = { name, role, cid: identity.info.cid, client, contact };
  recordEvidence(this, 'Remote room admission', { name, role, identityCid: identity.info.cid, roomCid: this.room.identity_cid });
});

Then('the room has an active {string} seat for {string}', async function (role, name) {
  assert.equal(this.participant.name, name);
  await until(`${name} active in room`, async () => {
    const seats = await cowork(this, 'room', 'participants', this.room.room_id);
    const seat = seats.find(item => item.identity === this.participant.cid && item.role === role);
    return seat?.state === 'active' ? seat : undefined;
  }, 90_000);
});

When('{string} sends {string} to the room', async function (name, message) {
  assert.equal(this.participant.name, name);
  const sent = await this.participant.client.sendMessage({
    contact: this.participant.contact.display, text: message,
  });
  assert.equal(sent.sent, true);
});

Then('the Cowork archive contains {string}', async function (message) {
  await until(`Cowork archive contains ${message}`, async () => {
    const records = await cowork(this, 'room', 'history', this.room.room_id);
    return records.find(item => JSON.stringify(item).includes(message));
  }, 90_000);
});

When('the operator posts {string} to the room', async function (message) {
  await cowork(this, 'room', 'message', this.room.room_id, '--text', message);
});

Then('{string} receives {string} from the room', async function (name, message) {
  assert.equal(this.participant.name, name);
  await until(`${name} receives room message`, async () => {
    const history = await this.participant.client.listHistory({ limit: 200 });
    const incoming = history.items.filter(item => item.direction === 'in');
    this.lastInbox = incoming.map(item => ({ text: item.text, wire_id: item.wire_id }));
    return incoming.find(item => {
      try { return JSON.parse(item.text).text === message; } catch { return false; }
    }) ?? undefined;
  }, 35_000).catch(error => {
    recordEvidence(this, 'Last remote inbox', this.lastInbox);
    throw error;
  });
});

Given('Fleet uses a deterministic ACP agent and Cowork on server {word} with room template {string}:', async function (server, template, table) {
  const side = serverSide(server);
  this.hostSide = side;
  const members = table.hashes().map(({ slot, role }) => ({ slot, role }));
  assert.match(template, /^[a-z][a-z0-9_-]*$/);
  assert.ok(members.length > 0, 'A room template requires at least one member');
  for (const { slot, role } of members) {
    assert.match(slot, /^[a-z][a-z0-9_-]*$/);
    assert.match(role, /^[A-Za-z][A-Za-z0-9_-]*$/);
  }
  assert.equal(new Set(members.map(member => member.slot)).size, members.length, 'Room member slots must be unique');
  assert.equal(new Set(members.map(member => member.role)).size, members.length, 'Room member roles must be unique');
  this.expectedRoles = members.map(member => member.role);
  this.roomTemplate = template;
  const host = await attachDaemonRoot(this, side, `RoomHost-${side}`);
  const owner = await host.currentIdentity();
  assert.equal(owner.isRoot, true, 'Fleet owner must be the daemon root identity');
  const home = `/agent-state/${side}-${randomUUID().slice(0, 6)}`;
  this.fleetHome = home;
  const coworkConfig = `/cowork/${side}/config.json`;
  process.env.OURS_COWORK_CONFIG = coworkConfig;
  process.env.OURS_CONFIG = `${home}/profile.json`;
  process.env.OURS_FLEET_HOME = home;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(`${home}/fleet/agent_templates`, { recursive: true, mode: 0o700 });
  mkdirSync(`${home}/fleet/agents`, { recursive: true, mode: 0o700 });
  mkdirSync(`${home}/workspace`, { recursive: true, mode: 0o700 });
  const privateFile = (path, value) => {
    writeFileSync(path, value, { mode: 0o600 });
    chmodSync(path, 0o600);
  };
  privateFile(`${home}/profile.json`, JSON.stringify({
    endpoint: nodes[side].endpoint,
    expectedInstanceId: nodes[side].instanceId,
    credentialPath: nodes[side].credentialPath,
  }));
  privateFile(`${home}/fleet.yaml`, [
    'api_version: ours.network/fleet/v2',
    'rooms:',
    '  cowork:',
    `    config: ${coworkConfig}`,
    '  owner:',
    `    expected_cid: ${owner.cid}`,
    '  defaults:',
    '    attach_owner: false',
    'room_templates:',
    `  ${template}:`,
    '    version: 1',
    '    description: Deterministic E2E agents',
    '    members:',
    ...members.map(({ slot, role }) => `      - { slot: ${slot}, role: ${role}, count: 1, agent_template: ${role} }`),
    '',
  ].join('\n'));
  for (const role of new Set(members.map(member => member.role))) {
    privateFile(`${home}/fleet/agent_templates/${role}.yaml`, [
      `role: { inline: { mission: "Act as ${role} in the assigned room" } }`,
      'brain:',
      '  inline:',
      '    harness: codex',
      '    session: acp',
      '    session_options:',
      '      acp:',
      '        command: [node, /opt/ours/tests/mock-acp.mjs]',
      'permissions: { approval: allow, filesystem: unrestricted, unattended: wait }',
      `cwd: ${home}/workspace`,
      '',
    ].join('\n'));
  }
  const templates = await fleet(this, 'template', 'list');
  assert.ok(templates.templates.some(item => item.name === template));
});

When('Fleet starts a task using the {string} room template', async function (template) {
  assert.equal(template, this.roomTemplate, 'The task must use the configured room template');
  const task = await fleet(this, 'task', 'create', '--title', `E2E-${randomUUID().slice(0, 8)}`,
    '--template', template, '--brief', 'Inspect and report findings');
  this.taskId = task.task?.task_id;
  assert.ok(this.taskId, `Fleet did not create a task`);
  this.roomId = task.task?.room_id;
  recordEvidence(this, 'Fleet task created', { taskId: this.taskId, roomId: this.roomId });
});

Then('every configured Fleet member has an active Cowork room seat', async function () {
  const expectedRoles = this.expectedRoles;
  this.roomDetail = await until('Fleet room and all configured seats active', async () => {
    const task = await fleet(this, 'task', 'show', this.taskId);
    this.lastTask = { state: task.task?.state, orchestration: task.orchestration?.provisioning_detail,
      memberSeats: task.orchestration?.member_seats?.map(s => ({ role: s.cowork_role, state: s.seat_state, launch: s.launch?.state })) };
    const id = task.task?.room_id ?? this.roomId;
    if (!id) return undefined;
    this.roomId = id;
    const room = await fleet(this, 'room', 'show', id);
    this.lastRoom = { state: room.room?.state, seats: room.room?.seats?.map(s => ({ role: s.role, state: s.seat_state })),
      memberSeats: room.orchestration?.member_seats?.map(s => ({ role: s.cowork_role, state: s.seat_state, launch: s.launch?.state, error: s.launch?.error })) };
    const failed = room.orchestration?.member_seats?.find(s => s.launch?.state === 'failed');
    if (failed) return { failed, room };
    const seats = room.room?.seats ?? [];
    const active = role => seats.find(item => item.role === role && item.seat_state === 'active');
    return room.room?.state === 'active' && expectedRoles.every(active) ? room : undefined;
  }, 35_000).catch(error => {
    recordEvidence(this, 'Last Fleet and Cowork state', { task: this.lastTask, room: this.lastRoom });
    throw error;
  });
  if (this.roomDetail.failed) {
    recordEvidence(this, 'Failed Fleet launch', this.lastRoom);
    throw new Error(`Fleet agent ${this.roomDetail.failed.cowork_role} failed: ${this.roomDetail.failed.launch.error}`);
  }
  recordEvidence(this, 'Fleet room with admitted agents', this.roomDetail);
});

Then('each room seat belongs to a live Fleet agent', async function () {
  const seats = this.roomDetail.room.seats.filter(item => this.expectedRoles.includes(item.role));
  const launches = this.roomDetail.orchestration?.member_seats ?? [];
  const tempRoot = `${this.fleetHome}/.ours-fleet/tmp`;
  const supervisors = readdirSync(tempRoot, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => {
    try { return [JSON.parse(readFileSync(`${tempRoot}/${e.name}/.temp-supervisor.json`, 'utf8'))]; } catch { return []; }
  });
  this.supervisorPids = supervisors.map(s => s.pid);
  this.memberCids = seats.map(s => s.identity_cid);
  assert.equal(supervisors.length, this.expectedRoles.length, 'Expected one real supervisor per configured member');
  for (const supervisor of supervisors) {
    assert.equal(supervisor.phase, 'active');
    assert.ok(Number.isInteger(supervisor.pid));
    process.kill(supervisor.pid, 0);
    const state = readFileSync(`/proc/${supervisor.pid}/stat`, 'utf8').split(') ')[1]?.split(' ')[0];
    assert.ok(state && !['Z', 'X'].includes(state), 'Supervisor process is not live');
  }
  assert.equal(seats.length, this.expectedRoles.length);
  for (const seat of seats) {
    const member = launches.find(item => item.identity_cid === seat.identity_cid);
    assert.ok(member, `No Fleet launch matches room seat ${seat.identity_cid}`);
    assert.equal(member.seat_state, 'active');
    assert.equal(member.launch?.state, 'launched');
  }
});

When('the operator reviews and finishes the Fleet task', async function () {
  await fleet(this, 'task', 'review', this.taskId);
  await fleet(this, 'task', 'finish', this.taskId, '--summary', 'E2E completed');
});
Then('the task is done its room is deleted and members are retired', async function () {
  const task = await fleet(this, 'task', 'show', this.taskId);
  assert.equal(task.task.state, 'done');
  const rooms = await cowork(this, 'room', 'list');
  assert.ok(!rooms.some(room => room.room_id === this.roomId), 'Finished room is still listed');
  const client = await attach(this, nodes[this.hostSide ?? 'a']);
  await until('finished member identities retired', async () => {
    const identities = await client.listIdentities();
    return this.memberCids.every(cid => !identities.some(i => i.cid === cid)) ? true : undefined;
  }, 15000);
  await until('finished supervisors terminated', () => this.supervisorPids.every(pid => {
    try { const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ')[0]; return ['Z','X'].includes(state); }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }) ? true : undefined, 15000);
  recordEvidence(this, 'Task finish lifecycle', { taskState: task.task.state, roomDeleted: true, memberIdentitiesRetired: true, supervisorsTerminated: true });
});

After(function () {
  if (!this.fleetHome) return;
  const records = [];
  function scan(path, depth = 0) {
    if (depth > 6) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = `${path}/${entry.name}`;
      if (entry.isDirectory()) scan(full, depth + 1);
      else if (['.temp-supervisor.json', 'termination.jsonl'].includes(entry.name)) {
        for (const line of entry.name.endsWith('.jsonl') ? readFileSync(full,'utf8').trim().split('\n') : [readFileSync(full,'utf8')]) {
          try {
            const value = JSON.parse(line);
            records.push(Object.fromEntries(['role','phase','pid','kind','reason','exitCode','signal','at'].filter(k => value[k] !== undefined).map(k => [k,value[k]])));
          } catch {}
        }
      }
    }
  }
  scan(this.fleetHome);
  recordEvidence(this, 'Fleet supervisor lifecycle metadata', records);
});
