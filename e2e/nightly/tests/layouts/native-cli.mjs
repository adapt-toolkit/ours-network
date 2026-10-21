// Public CLI E2E: no injected layout engine, supervisor, spawn, or assignment implementation.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
export async function nativeCliScenario(ctx) {
  const { root, fleetRoot, profile, codex, modelUrl, command, waitFor, cowork, evidence, inputs, stringify, env } = ctx;
  const home = join(root, 'h'); mkdirSync(home, { mode: 0o700 });
  const config = join(home, 'fleet.yaml'), split = join(home, 'fleet'), layouts = join(split, 'room_layouts');
  for (const dir of ['agents','agent_templates','room_layouts']) mkdirSync(join(split, dir), { recursive: true, mode: 0o700 });
  const configHome = join(home, 'codex'); mkdirSync(configHome, { mode: 0o700 });
  writeFileSync(join(configHome, 'config.toml'), `model_provider = "fixture"\n[model_providers.fixture]\nname = "fixture"\nbase_url = ${JSON.stringify(modelUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  const override = { model: 'gpt-5.6-sol', model_provider: 'fixture', model_providers: { fixture: { name: 'fixture', base_url: modelUrl, wire_api: 'responses', requires_openai_auth: false } }, features: { shell_tool: false, js_repl: false } };
  const template = { role: { inline: { mission: 'Acknowledge the assigned task briefly. Do not call tools.' } },
    brain: { inline: { harness: 'codex', session: 'acp', model: 'gpt-5.6-sol', harness_options: { sandbox: 'workspace-write' } } },
    cwd: home, permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    env: { ...env, OURS_CONFIG: profile, CODEX_HOME: configHome, CODEX_PATH: codex, CODEX_CONFIG: JSON.stringify(override), MODEL_PROVIDER: 'fixture',
      OPENAI_API_KEY: 'fixture-unused', OPENAI_BASE_URL: modelUrl, DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'api-key', _meta: { 'api-key': { apiKey: 'fixture-unused' } } }) } };
  writeFileSync(config, stringify({ api_version: 'ours.network/fleet/v2', rooms: { owner: { expected_cid: '0'.repeat(64) }, defaults: { attach_owner: false } } }), { mode: 0o600 });
  writeFileSync(join(split, 'agent_templates', 'Worker.yaml'), stringify(template), { mode: 0o600 });
  const cliEnv = { ...env, OURS_CONFIG: profile, OURS_FLEET_HOME: home, OURS_FLEET_SUPERVISOR: 'none', CODEX_HOME: configHome, CODEX_PATH: codex };
  const cli = async (...args) => JSON.parse(await command([join(fleetRoot, 'dist/cli.js'), 'layout', ...args, '--configuration', config, '--json'], cliEnv, fleetRoot, 180000));
  const shared = process.env.OURS_LAYOUT_TEST_MODE === 'shared';
  const def = { version: 1, participants: { worker: { agent_template: 'Worker' }, peer: { agent_template: 'Worker' }, specialist: { agent_template: 'Worker' },
    ...(shared ? {} : { worker2: { agent_template: 'Worker' }, peer2: { agent_template: 'Worker' } }) }, rooms: {
    product: { goal: 'NATIVE_PRODUCT_CONTEXT', members: ['worker','peer'] },
    design: { goal: 'NATIVE_DESIGN_CONTEXT', members: shared ? ['worker','peer'] : ['worker2','peer2'] },
  } };
  const member = shared ? 'worker' : 'worker2', peer = shared ? 'peer' : 'peer2';
  for (const key of ['advice', 'secondAdvice']) def.rooms[key] = { goal: 'NATIVE_CONSULT_CONTEXT', members: [member, peer, 'specialist'], roles: { [member]: 'developer', [peer]: 'qa', specialist: 'product' } };
  const layoutFile = join(layouts, 'work.yaml'); writeFileSync(layoutFile, stringify(def), { mode: 0o600 });
  let state, borrowed, runId;
  {
    assert((await cli('validate', 'work')).valid);
    const bad = join(home, 'bad.yaml'); writeFileSync(bad, 'version: 1\nversion: 1\n', { mode: 0o600 });
    await assert.rejects(cli('validate', '--file', bad));
    if (shared) {
      writeFileSync(join(layouts, 'seed.yaml'), stringify({ version: 1, participants: { worker: { agent_template: 'Worker' } }, rooms: { seed: { goal: 'NATIVE_SEED_CONTEXT', members: ['worker'] } } }), { mode: 0o600 });
      await cli('create', 'seed', '--id', 'seed'); const seed = await cli('open', 'seed', 'seed'); borrowed = seed.state.participants.worker.instance;
      assert(!JSON.stringify(seed).includes('fixture-unused'), 'CLI must not expose template environment values');
      const instance = await cli('instance', borrowed.agent, '--temporary'); assert.deepEqual(instance.instance, borrowed);
    }
    if (borrowed) {
      const staleFile = join(home, 'stale.yaml');
      writeFileSync(staleFile, stringify({ worker: { ...borrowed, session: 'replacement-session' } }), { mode: 0o600 });
      const before = (await cowork.listRooms()).length;
      await assert.rejects(cli('create', 'work', '--id', 'stale', '--bindings', staleFile));
      assert.equal((await cowork.listRooms()).length, before);
    }
    const bindingsFile = join(home, 'bindings.yaml'); writeFileSync(bindingsFile, stringify(borrowed ? { worker: borrowed } : {}), { mode: 0o600 });
    const created = await cli('create', 'work', '--id', 'work', '--bindings', bindingsFile);
    runId = created.id;
    state = (await cli('status', runId)).state;
    assert.equal(Object.keys(state.rooms).length, 0);
    await Promise.all([cli('open', runId, 'product'), cli('open', runId, 'product')]);
    state = (await cli('status', runId)).state;
    assert.equal(state.order.length, 1);
    await waitFor(() => inputs.filter(s => s.includes('NATIVE_PRODUCT_CONTEXT')).length >= 2, 'native Product prompts reach provider');
    // A second instance may open the same room key on this Cowork server.
    const duplicateBindings = join(home, 'duplicate-bindings.yaml');
    writeFileSync(duplicateBindings, stringify({ worker: state.participants.worker.instance, peer: state.participants.peer.instance }), { mode: 0o600 });
    await cli('create', 'work', '--id', 'another', '--bindings', duplicateBindings);
    const another = (await cli('open', 'another', 'product')).state;
    assert.notEqual(another.rooms.product.native.identity_cid, state.rooms.product.native.identity_cid);
    await cli('close', 'another');
    // Every next command is a fresh CLI process; run snapshots survive edits.
    const changed = structuredClone(def); changed.rooms.design.goal = 'CONFIG_DRIFT_MUST_NOT_REACH_RUN';
    writeFileSync(layoutFile, stringify(changed), { mode: 0o600 });
    rmSync(join(split, 'agent_templates', 'Worker.yaml'));
    await cli('open', runId, 'design'); state = (await cli('status', runId)).state;
    await waitFor(() => inputs.filter(s => s.includes('NATIVE_DESIGN_CONTEXT')).length >= 2, 'native Design prompts reach provider');
    const successors = inputs.filter(s => s.includes('NATIVE_DESIGN_CONTEXT'));
    assert(successors.every(s => !s.includes('CONFIG_DRIFT_MUST_NOT_REACH_RUN')));
    // Only shared instances retain their own earlier conversation; fresh ones do not inherit it.
    assert(successors.every(s => s.includes('NATIVE_PRODUCT_CONTEXT') === shared));
    const instances = Object.values(state.participants).filter(p => p.instance).map(p => p.instance);
    assert.equal(new Set(instances.map(i => i.session)).size, shared ? 2 : 4);
    writeFileSync(layoutFile, 'invalid: [', { mode: 0o600 });
    await cli('open', runId, 'advice');
    await waitFor(() => inputs.filter(s => s.includes('NATIVE_CONSULT_CONTEXT')).length >= 3, '3-Amigos prompts');
    await cli('open', runId, 'secondAdvice');
    await waitFor(() => inputs.filter(s => s.includes('secondAdvice:')).length >= 3, 'overlapping room prompts');
    const admitted = (await cli('status', runId)).state;
    const amigos = [];
    for (const key of ['advice', 'secondAdvice']) {
      const room = await cowork.getRoom(admitted.rooms[key].native.room_id);
      const seats = room.seats.filter(s => s.seat_state === 'active');
      assert.equal(seats.length, 3);
      assert.equal(new Set(seats.map(s => s.identity_cid)).size, 3);
      assert.deepEqual(seats.map(s => s.role).sort(), ['developer', 'product', 'qa']);
      for (const role of ['developer', 'product', 'qa']) {
        const roleText = JSON.stringify('"room_role":"' + role + '"').slice(1, -1);
        assert(inputs.some(s => s.includes(`${key}:`) && s.includes(roleText)), 'room role reaches native provider');
      }
      amigos.push({ room: key, activeParticipants: seats.length, roles: seats.map(s => s.role).sort() });
    }
    await cowork.closeRoom(admitted.rooms.advice.native.room_id);
    await assert.rejects(cli('open', runId, 'advice'), /native room missing, changed or inactive/);
    await cli('close-room', runId, 'advice');
    const overlapping = (await cli('status', runId)).state;
    await cli('instance', overlapping.participants.specialist.instance.agent, '--temporary');
    assert.equal(overlapping.rooms.secondAdvice.state, 'active');
    await cli('close-room', runId, 'secondAdvice');
    await cli('instance', overlapping.participants.specialist.instance.agent, '--temporary');
    state = (await cli('status', runId)).state; assert.equal(state.rooms.design.state, 'active');
    await cli('instance', state.participants[member].instance.agent, '--temporary');
    const { stopTempSupervisor, tempSupervisorLiveness } = await ctx.loadFleet('temp-lifecycle.js');
    const stoppedName = state.participants.specialist.instance.agent;
    const stoppedDir = join(home, '.ours-fleet/tmp', stoppedName);
    await stopTempSupervisor(stoppedName);
    await waitFor(async () => !existsSync(stoppedDir) || await tempSupervisorLiveness(stoppedDir) === 'stopped', 'specialist stopped before layout cleanup');
    await cli('close', runId); state = (await cli('status', runId)).state;
    assert(Object.values(state.participants).filter(p => p.owned && p.instance).every(p => p.retired));
    assert(state.closed);
    for (const room of Object.values(state.rooms)) assert.equal((await cowork.getRoom(room.native.room_id)).state, 'closed');
    if (borrowed) { assert.deepEqual((await cli('instance', borrowed.agent, '--temporary')).instance, borrowed); await cli('close', 'seed'); }
    evidence.native = { mode: shared ? 'shared' : 'fresh', cli: true, yaml: true, overlappingConsultations: true, amigos, distinctSessions: instances.length,
      contextRetained: shared, configSnapshotPreserved: true, archivesRetained: true, nativeDriftRejected: true, stoppedParticipantCleanup: true,
      borrowedSurvived: Boolean(borrowed), closed: state.closed, state };
  }
}
