// Unit tests for the installer's pure decision logic (no I/O, no subprocess) — fast + hermetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonHarnesses, suggestPort, parsePort, validateBroker, mergeConfig, parseVersion, parseStatus,
  detectPlatform, classifyHarnessProbe, buildHandoffPrompt,
  effectiveVoiceConfig, voiceSetupStatus, validateVoiceSecret, redactSensitive,
  DEFAULT_PORT, DEFAULT_BROKER, RESERVED_PORTS,
  resolveChannel, pkgTag, pkgSpec, DEFAULT_CHANNEL,
  isNightlyVersion, daemonEndpoint, resolveSharedBroker, tgConfigPath, planTgDaemonConfig,
  coworkConfigPath, planCoworkConfig, COWORK_DEFAULT_PORT, coworkDaemonMode, coworkDaemonBlock,
  coworkSupportsExternalDaemon, compareVersions, COWORK_EXTERNAL_MIN_VERSION,
} from '../lib/logic.mjs';

test('resolveChannel: nightly synonyms → nightly; everything else → latest', () => {
  assert.equal(DEFAULT_CHANNEL, 'latest');
  assert.equal(resolveChannel('nightly'), 'nightly');
  assert.equal(resolveChannel('NIGHTLY'), 'nightly');
  assert.equal(resolveChannel('prerelease'), 'nightly');
  assert.equal(resolveChannel('next'), 'nightly');
  assert.equal(resolveChannel('latest'), 'latest');
  assert.equal(resolveChannel(''), 'latest');
  assert.equal(resolveChannel(undefined), 'latest');
  assert.equal(resolveChannel('garbage'), 'latest', 'unknown never guesses a tag');
});

test('resolveChannel: with no explicit selection the installer follows its OWN version', () => {
  // A nightly build of @ours.network/install must build a nightly stack. Before this, a
  // nightly installer installed @latest for everything it installs — and since
  // tg-connector 0.3.3-nightly.1 that crosses an architecture boundary, not just a version.
  assert.equal(resolveChannel('', '0.17.0-nightly.1'), 'nightly');
  assert.equal(resolveChannel(undefined, '0.17.0-nightly.12'), 'nightly');
  assert.equal(resolveChannel('', '0.17.0'), 'latest', 'a stable build never consumes a nightly');
  assert.equal(resolveChannel('', ''), 'latest', 'an unreadable version falls back to stable');
  assert.equal(resolveChannel('', '?'), 'latest');
  // The environment still wins in BOTH directions.
  assert.equal(resolveChannel('latest', '0.17.0-nightly.1'), 'latest');
  assert.equal(resolveChannel('stable', '0.17.0-nightly.1'), 'latest');
  assert.equal(resolveChannel('nightly', '0.17.0'), 'nightly');
  // An unrecognized explicit value is stable, and must NOT silently inherit the build channel.
  assert.equal(resolveChannel('garbage', '0.17.0-nightly.1'), 'latest');
});

test('isNightlyVersion: exactly the suffix the release bump stamps', () => {
  assert.equal(isNightlyVersion('0.17.0-nightly.1'), true);
  assert.equal(isNightlyVersion('1.2.3-nightly.42'), true);
  assert.equal(isNightlyVersion('0.17.0'), false);
  assert.equal(isNightlyVersion('0.17.0-rc.1'), false, 'only the nightly suffix counts');
  assert.equal(isNightlyVersion('0.17.0-nightly.03'), false, 'release indices are canonical integers');
  assert.equal(isNightlyVersion(''), false);
  assert.equal(isNightlyVersion(undefined), false);
});

test('daemonEndpoint: the loopback address the daemon actually binds', () => {
  assert.equal(daemonEndpoint(3050), 'http://127.0.0.1:3050');
  assert.equal(daemonEndpoint(3060), 'http://127.0.0.1:3060');
});

test('resolveSharedBroker: this run > the running daemon > the config file > the built-in', () => {
  assert.equal(
    resolveSharedBroker({ chosenBroker: 'wss://a', statusBroker: 'wss://b', configBroker: 'wss://c' }),
    'wss://a', 'what the user chose in this run wins');
  assert.equal(
    resolveSharedBroker({ statusBroker: 'wss://b', configBroker: 'wss://c' }),
    'wss://b', 'else what the running daemon actually resolved');
  assert.equal(resolveSharedBroker({ configBroker: 'wss://c' }), 'wss://c', 'else the config file');
  assert.equal(resolveSharedBroker({}), DEFAULT_BROKER, 'else the built-in, which the daemon shares');
  assert.equal(resolveSharedBroker(), DEFAULT_BROKER);
  // A malformed value is skipped rather than propagated to the connector.
  assert.equal(resolveSharedBroker({ chosenBroker: 'not-a-url', statusBroker: 'wss://b' }), 'wss://b');
  assert.equal(resolveSharedBroker({ chosenBroker: '   ' }), DEFAULT_BROKER);
});

test('tgConfigPath: OURS_TG_CONFIG else <home>/.ours-telegram/config.json', () => {
  assert.equal(tgConfigPath({}, '/h'), '/h/.ours-telegram/config.json');
  assert.equal(tgConfigPath({ OURS_TG_CONFIG: '/elsewhere/tg.json' }, '/h'), '/elsewhere/tg.json');
});

test('planTgDaemonConfig: writes both selections, preserves the rest, no-ops when unchanged', () => {
  const desired = {
    daemonUrl: 'http://127.0.0.1:3060',
    daemonStateDir: '/home/u/.ours',
    brokerUrl: 'wss://broker.example',
  };
  // Fresh file.
  const fresh = planTgDaemonConfig({}, desired);
  assert.equal(fresh.changed, true);
  const written = JSON.parse(fresh.text);
  // BOTH the endpoint and the state directory: the SDK refuses an endpoint selected while the
  // state directory stays defaulted, because the daemon's API token belongs to a state dir.
  assert.equal(written.daemonUrl, desired.daemonUrl);
  assert.equal(written.daemonStateDir, desired.daemonStateDir);
  // And the broker, for a pre-0.3.3 connector that meets the daemon at a broker instead.
  assert.equal(written.brokerUrl, desired.brokerUrl);
  assert.equal(fresh.previous.daemonUrl, '', 'nothing was there before');

  // Keys the installer does not own survive.
  const withUser = planTgDaemonConfig({ sttModel: 'mine', controlPort: 3051 }, desired);
  const merged = JSON.parse(withUser.text);
  assert.equal(merged.sttModel, 'mine');
  assert.equal(merged.controlPort, 3051);

  // Idempotent: the same selection is not rewritten.
  const again = planTgDaemonConfig(merged, desired);
  assert.equal(again.changed, false, 'an unchanged selection writes nothing');
  assert.equal(again.text, '');
  assert.equal(again.previous.daemonUrl, desired.daemonUrl);

  // A moved daemon IS a change, and the old value is reported so the caller can warn about a
  // service unit that froze it.
  const moved = planTgDaemonConfig(merged, { ...desired, daemonUrl: 'http://127.0.0.1:3070' });
  assert.equal(moved.changed, true);
  assert.equal(moved.previous.daemonUrl, 'http://127.0.0.1:3060');
  assert.equal(JSON.parse(moved.text).daemonUrl, 'http://127.0.0.1:3070');

  // Non-object input (absent/corrupt file) is treated as empty, never thrown on.
  assert.equal(planTgDaemonConfig(null, desired).changed, true);
  assert.equal(planTgDaemonConfig('nonsense', desired).changed, true);
});

test('pkgTag: the nightly channel takes each package\'s OWN prerelease tag', () => {
  // Everything published from this repo on the lockstep `nightly` tag.
  assert.equal(pkgTag('mcp', 'nightly'), 'nightly');
  assert.equal(pkgTag('tg-connector', 'nightly'), 'nightly');
  assert.equal(pkgTag('claude-code', 'nightly'), 'nightly');
  assert.equal(pkgTag('codex', 'nightly'), 'nightly');
  assert.equal(pkgTag('hermes', 'nightly'), 'nightly');
  // fleet publishes its own nightly dist-tag and MUST follow the channel: the nightly
  // stack needs the fleet build with the SDK integration, and a stable fleet against a
  // nightly daemon is the split-brain deployment the channel exists to prevent.
  assert.equal(pkgTag('fleet', 'nightly'), 'nightly', 'fleet follows the channel');
  // cowork publishes `nightly` too, aligned with every other service (public release contract —
  // it previously used `next`). The nightly channel must reach that line: the external-daemon
  // mode the Rooms step configures ships there, so taking `latest` would pair a daemon block
  // with a build predating it.
  assert.equal(pkgTag('cowork', 'nightly'), 'nightly', 'cowork aligns with the other services');
  // Latest channel → everything latest.
  assert.equal(pkgTag('mcp', 'latest'), 'latest');
  assert.equal(pkgTag('fleet', 'latest'), 'latest');
  assert.equal(pkgTag('cowork', 'latest'), 'latest');
  // An unknown package never gets a guessed tag — a 404 fails the WHOLE install.
  assert.equal(pkgTag('not-a-real-package', 'nightly'), 'latest');
  // Accepts the fully-qualified name too.
  assert.equal(pkgTag('@ours.network/mcp', 'nightly'), 'nightly');
  assert.equal(pkgTag('@ours.network/fleet', 'nightly'), 'nightly');
  assert.equal(pkgTag('@ours.network/cowork', 'nightly'), 'nightly');
});

test('pkgSpec: builds the full npm spec honoring each package\'s channel mapping', () => {
  assert.equal(pkgSpec('mcp', 'nightly'), '@ours.network/mcp@nightly');
  assert.equal(pkgSpec('tg-connector', 'nightly'), '@ours.network/tg-connector@nightly');
  assert.equal(pkgSpec('codex', 'nightly'), '@ours.network/codex@nightly');
  assert.equal(pkgSpec('fleet', 'nightly'), '@ours.network/fleet@nightly', 'the fix: nightly fleet on the nightly channel');
  assert.equal(pkgSpec('cowork', 'nightly'), '@ours.network/cowork@nightly');
  assert.equal(pkgSpec('cowork', 'latest'), '@ours.network/cowork@latest');
  assert.equal(pkgSpec('mcp', 'latest'), '@ours.network/mcp@latest');
  assert.equal(pkgSpec('fleet', 'latest'), '@ours.network/fleet@latest', 'stable installs stable fleet');
  assert.equal(pkgSpec('fleet'), '@ours.network/fleet@latest', 'default channel = latest');
  // An explicit override still wins over the installer's own version, for every package.
  assert.equal(pkgSpec('fleet', 'stable'), '@ours.network/fleet@latest');
  assert.equal(pkgSpec('fleet', 'prerelease'), '@ours.network/fleet@nightly');
});

test('canonHarnesses: names/numbers/all, de-duped and order-preserving; OpenClaw is gone', () => {
  assert.deepEqual(canonHarnesses('codex hermes').names, ['codex', 'hermes']);
  assert.deepEqual(canonHarnesses('2,3').names, ['codex', 'hermes']);
  assert.deepEqual(canonHarnesses('cc codex codex').names, ['claude-code', 'codex']);
  assert.deepEqual(canonHarnesses('all').names, ['claude-code', 'codex', 'hermes']);
  assert.deepEqual(canonHarnesses('none').names, []);
  // OpenClaw support was removed — the token is unknown now, never a selection.
  const r = canonHarnesses('openclaw hermes');
  assert.deepEqual(r.names, ['hermes']);
  assert.deepEqual(r.unknown, ['openclaw']);
});

test('suggestPort: keeps a free port, avoids reserved 3051, and skips taken ports', () => {
  const free = () => false;
  assert.equal(suggestPort(3050, free), 3050, 'free desired kept');
  assert.equal(suggestPort(3051, free), 3060, 'reserved 3051 → first free alternate ≥3060');
  assert.notEqual(suggestPort(3051, free), 3051, 'never returns the reserved port');
  // 3050 taken → alternate from 3060 up; 3060 taken too → 3061.
  const taken = (p) => p === 3050 || p === 3060;
  assert.equal(suggestPort(3050, taken), 3061);
  assert.ok(!RESERVED_PORTS.includes(suggestPort(3051, () => true)) || suggestPort(3051, () => true) === 3051 /* exhausted */);
});

test('parsePort: validates range, falls back otherwise', () => {
  assert.deepEqual(parsePort('3060'), { ok: true, port: 3060 });
  assert.deepEqual(parsePort('  8080 '), { ok: true, port: 8080 });
  assert.deepEqual(parsePort('nope', 3050), { ok: false, port: 3050 });
  assert.deepEqual(parsePort('70000', 3050), { ok: false, port: 3050 });
  assert.deepEqual(parsePort('0', 3050), { ok: false, port: 3050 });
});

test('validateBroker: accepts ws/wss, flags junk, treats empty as keep-default', () => {
  assert.deepEqual(validateBroker('wss://broker1.ours.network'), { ok: true, value: 'wss://broker1.ours.network', empty: false });
  assert.equal(validateBroker('ws://localhost:9000').ok, true);
  assert.equal(validateBroker('http://nope').ok, false);
  assert.deepEqual(validateBroker('   '), { ok: true, value: '', empty: true });
});

test('mergeConfig: patches only given keys, preserves the rest, trailing newline', () => {
  const out = mergeConfig({ stateDir: '/x', port: 3050 }, { port: 3060, brokerUrl: 'wss://b' });
  const obj = JSON.parse(out);
  assert.equal(obj.stateDir, '/x', 'unrelated key preserved');
  assert.equal(obj.port, 3060, 'patched');
  assert.equal(obj.brokerUrl, 'wss://b', 'added');
  assert.ok(out.endsWith('\n'), 'trailing newline');
  // undefined patch values are ignored, not written.
  assert.equal(JSON.parse(mergeConfig({}, { port: undefined })).port, undefined);
});

test('voice readiness is capability-based, env-overridable, and never returns a key', () => {
  assert.equal(voiceSetupStatus({}).ready, false);
  assert.deepEqual(voiceSetupStatus({ stt: { provider: 'deepgram' } }).missing, ['apiKey']);
  assert.equal(voiceSetupStatus({ stt: { provider: 'deepgram', apiKey: 'placeholder-key' } }).ready, true);
  assert.equal(voiceSetupStatus({
    stt: { provider: 'openai-compatible', apiKey: 'placeholder-key', model: 'whisper-x' },
  }).missing[0], 'baseUrl');
  assert.equal(voiceSetupStatus({
    stt: { provider: 'elevenlabs', apiKey: 'placeholder-key' },
  }).missing[0], 'model');
  assert.equal(voiceSetupStatus({
    stt: { provider: 'custom', apiKey: 'placeholder-key', custom: { url: 'https://stt.invalid/{model}' } },
  }).missing[0], 'model');

  const env = {
    OURS_STT_PROVIDER: 'deepgram',
    OURS_STT_API_KEY: 'environment-placeholder-key',
    OURS_STT_MODEL: 'nova-test',
  };
  const effective = effectiveVoiceConfig({ stt: { provider: 'nope', apiKey: 'file-placeholder' } }, env);
  assert.equal(effective.provider, 'deepgram');
  const status = voiceSetupStatus({ stt: {} }, env);
  assert.equal(status.ready, true);
  assert.equal(status.keySource, 'environment');
  assert.doesNotMatch(JSON.stringify(status), /environment-placeholder-key|file-placeholder/);
});

test('voice secret validation is provider-neutral but rejects missing/malformed input', () => {
  assert.equal(validateVoiceSecret('').ok, false);
  assert.equal(validateVoiceSecret('short').ok, false);
  assert.equal(validateVoiceSecret('has whitespace').ok, false);
  assert.equal(validateVoiceSecret('placeholder-key-123').ok, true);
});

test('secret redaction removes exact values and common keyed diagnostics', () => {
  const secret = 'placeholder-secret-123';
  const scrubbed = redactSensitive(
    `provider echoed ${secret}; {"apiKey":"${secret}"} token=${secret}`,
    [secret],
  );
  assert.doesNotMatch(scrubbed, new RegExp(secret));
  assert.match(scrubbed, /\[redacted\]/);
});

test('parseVersion / parseStatus: pull versions + resolved broker/port out of CLI output', () => {
  assert.equal(parseVersion('ours-mcp v0.9.9'), '0.9.9');
  assert.equal(parseVersion('nothing here'), '');
  const st = parseStatus([
    'ours-mcp: running',
    '  api:    http://localhost:3070 (reachable)',
    '  broker: wss://broker1.ours.network',
  ].join('\n'));
  assert.equal(st.broker, 'wss://broker1.ours.network');
  assert.equal(st.port, 3070);
  assert.deepEqual(parseStatus('ours-mcp: stopped'), { broker: null, port: null });
  // The historical `url:` line still parses: a current CLI can be asked to report
  // on an older running daemon, and reading that as "no port" would be wrong.
  assert.equal(parseStatus('  url:    http://localhost:3070/mcp (reachable)').port, 3070);
});

test('defaults mirror the daemon core config', () => {
  assert.equal(DEFAULT_PORT, 3050);
  assert.equal(DEFAULT_BROKER, 'wss://broker1.ours.network');
});

// --- v2 unified-installer logic ----------------------------------------------------------------

test('detectPlatform: macOS/Linux/WSL supported, native Windows not, unknown not', () => {
  assert.deepEqual(detectPlatform({ platform: 'darwin' }), { os: 'macos', label: 'macOS', supported: true });
  assert.deepEqual(detectPlatform({ platform: 'linux', release: '6.5.0-generic' }), { os: 'linux', label: 'Linux', supported: true });
  // WSL by kernel release string…
  assert.equal(detectPlatform({ platform: 'linux', release: '5.15.0-microsoft-standard-WSL2' }).os, 'wsl');
  // …or by the WSL env markers.
  assert.equal(detectPlatform({ platform: 'linux', release: '6.5.0', env: { WSL_DISTRO_NAME: 'Ubuntu' } }).os, 'wsl');
  assert.equal(detectPlatform({ platform: 'win32' }).supported, false);
  assert.equal(detectPlatform({ platform: 'win32' }).os, 'windows');
  assert.equal(detectPlatform({ platform: 'sunos' }).supported, false);
});

test('classifyHarnessProbe: real binary ok; hang/alias/function never dead-end; absent skipped', () => {
  assert.equal(classifyHarnessProbe({ onPath: true, versionOk: true }).status, 'ok');
  // A wrapper that never answered --version had to be killed → treat as unsafe alias, never call it.
  assert.equal(classifyHarnessProbe({ onPath: true, versionOk: false, timedOut: true }).status, 'alias');
  // Shadowed by a shell alias/function even when no real binary is on PATH.
  assert.equal(classifyHarnessProbe({ onPath: false, shellType: 'alias' }).status, 'alias');
  assert.equal(classifyHarnessProbe({ onPath: false, shellType: 'function' }).status, 'alias');
  // On PATH but the probe just didn't look right → don't auto-drive, still offer a manual path.
  assert.equal(classifyHarnessProbe({ onPath: true, versionOk: false, shellType: 'file' }).status, 'unsafe');
  // Genuinely not there.
  assert.equal(classifyHarnessProbe({ onPath: false, versionOk: false, shellType: '' }).status, 'absent');
});

test('buildHandoffPrompt: identity is a fallback step; fleet/telegram drop out; empty when nothing left', () => {
  // Identity fallback (in-install creation failed/skipped) → step 1 uses the "human identity"
  // wording: capital "Ours", no "root" jargon (the CLI seam stays create-root, copy never says root).
  const all = buildHandoffPrompt({ identity: true, fleet: true, telegram: true }).text;
  assert.match(all, /1\. Create my Ours human identity/);
  assert.match(all, /my agents act on\s+my behalf/);
  assert.doesNotMatch(all, /root/i, 'user-facing hand-off must not use the "root" jargon');
  // Fleet step: stand up a PERMANENT team, not a temp-agent demo.
  assert.match(all, /2\. Set up my ours-fleet/);
  assert.match(all, /PERMANENT use/);
  assert.doesNotMatch(all, /temporary agent/, 'fleet step must not demo a temporary agent');
  assert.match(all, /3\. Set up my Telegram bot/);

  // Identity already created in-install → its step drops; remaining steps renumber.
  const noId = buildHandoffPrompt({ fleet: true, telegram: true }).text;
  assert.doesNotMatch(noId, /human identity/i, 'identity created in-install drops out of the hand-off');
  assert.match(noId, /1\. Set up my ours-fleet/);
  assert.match(noId, /2\. Set up my Telegram bot/);

  const fleetOnly = buildHandoffPrompt({ fleet: true }).text;
  assert.match(fleetOnly, /1\. Set up my ours-fleet/);
  assert.doesNotMatch(fleetOnly, /Telegram/, 'a skipped Telegram must not appear in the hand-off');

  // Everything done in-install (identity created, no fleet/telegram) → nothing to hand off.
  const done = buildHandoffPrompt({});
  assert.equal(done.empty, true);
  assert.equal(done.text, '');
});

// ── daemon topology: one common daemon, optional dedicated ones ────────────────

test('RESERVED_PORTS covers every port another component in the stack owns', () => {
  // 3051 is the Telegram connector's, 3052 is the ours-cowork console's default.
  // A daemon handed either would collide with a component this same installer sets up.
  assert.ok(RESERVED_PORTS.includes(3051), 'telegram connector port reserved');
  assert.ok(RESERVED_PORTS.includes(COWORK_DEFAULT_PORT), 'rooms console port reserved');
  assert.equal(COWORK_DEFAULT_PORT, 3052);
  assert.ok(!RESERVED_PORTS.includes(DEFAULT_PORT), 'the daemon\'s own default is not reserved against it');
});

// ── Rooms / ours-cowork ───────────────────────────────────────────────────────

test('coworkConfigPath: OURS_COWORK_CONFIG, else <home>/.ours-cowork/config.json', () => {
  assert.equal(coworkConfigPath({}, '/home/u'), '/home/u/.ours-cowork/config.json');
  assert.equal(coworkConfigPath({ OURS_COWORK_CONFIG: '/tmp/cw.json' }, '/home/u'), '/tmp/cw.json');
});

test('planCoworkConfig: writes broker + state + console port, and a rerun writes nothing', () => {
  const desired = { brokerUrl: 'wss://broker1.ours.network', stateDir: '/home/u/.ours-cowork', restPort: 3052 };
  const fresh = planCoworkConfig({}, desired);
  assert.equal(fresh.changed, true);
  const written = JSON.parse(fresh.text);
  assert.equal(written.version, 1, 'cowork\'s config is a versioned strict document');
  assert.equal(written.brokerUrl, 'wss://broker1.ours.network', 'rooms shares the deployment broker');
  assert.equal(written.stateDir, '/home/u/.ours-cowork');
  assert.deepEqual(written.rest, { enabled: true, port: 3052 });

  // Idempotent re-run: the same selection is a no-op, so nothing is rewritten.
  assert.equal(planCoworkConfig(written, desired).changed, false);

  // A changed console port IS a write, and reports what it replaced.
  const moved = planCoworkConfig(written, { ...desired, restPort: 3062 });
  assert.equal(moved.changed, true);
  assert.equal(moved.previous.restPort, 3052);
  assert.equal(JSON.parse(moved.text).rest.port, 3062);

  // An operator's explicit rest.enabled:false survives a port update — the rest block
  // is merged, not replaced.
  const disabled = { ...written, rest: { enabled: false, port: 3052 } };
  const afterMove = JSON.parse(planCoworkConfig(disabled, { ...desired, restPort: 3062 }).text);
  assert.equal(afterMove.rest.enabled, false, 'never re-enables a console the operator turned off');
  assert.equal(afterMove.rest.port, 3062);

  // Unrelated keys the user or cowork itself added are preserved.
  const extra = planCoworkConfig({ ...written, somethingElse: 'keep me' }, { ...desired, restPort: 3062 });
  assert.equal(JSON.parse(extra.text).somethingElse, 'keep me');

  // Non-object input (absent/corrupt file) is treated as empty, never thrown on.
  assert.equal(planCoworkConfig(null, desired).changed, true);
  assert.equal(planCoworkConfig('nonsense', desired).changed, true);
});

test('buildHandoffPrompt: Rooms gets its own step, and drops out when Rooms was skipped', () => {
  const withRooms = buildHandoffPrompt({ fleet: true, telegram: true, rooms: true }).text;
  assert.match(withRooms, /3\. Set up my first Rooms mission room/);
  assert.match(withRooms, /inviting the people and\s+agents/);
  const noRooms = buildHandoffPrompt({ fleet: true, telegram: true }).text;
  assert.doesNotMatch(noRooms, /Rooms/, 'a skipped Rooms must not appear in the hand-off');
  const roomsOnly = buildHandoffPrompt({ rooms: true }).text;
  assert.match(roomsOnly, /1\. Set up my first Rooms mission room/, 'steps renumber');
});

// ── Rooms external-daemon selection ──────────────────────────────────────────
// Optional `daemon` block; absent ⇒ embedded. External is
// { mode:'external', endpoint, stateDir } and REQUIRES both halves — cowork stores
// no token, its SDK reads <stateDir>/daemon-token. Boot is fail-closed with NO
// embedded fallback, so a half-written block or an unasked migration is a real outage.

test('coworkDaemonMode: no block means embedded, which is what every pre-#9 install runs', () => {
  assert.equal(coworkDaemonMode({}), 'embedded');
  assert.equal(coworkDaemonMode({ rest: { port: 3052 } }), 'embedded');
  assert.equal(coworkDaemonMode(null), 'embedded');
  assert.equal(coworkDaemonMode('nonsense'), 'embedded');
  assert.equal(coworkDaemonMode({ daemon: null }), 'embedded');
  assert.equal(coworkDaemonMode({ daemon: { mode: 'embedded' } }), 'embedded');
  assert.equal(coworkDaemonMode({ daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: '/s' } }), 'external');
});

test('coworkDaemonBlock: external needs BOTH halves, and is never written half-formed', () => {
  const good = coworkDaemonBlock({ endpoint: 'http://127.0.0.1:3050', stateDir: '/home/u/.ours' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.block, { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: '/home/u/.ours' });
  // A partial selection fails closed at cowork's boot, so it is refused here instead.
  for (const bad of [{ endpoint: 'http://127.0.0.1:3050' }, { stateDir: '/home/u/.ours' }, {}, undefined]) {
    const v = coworkDaemonBlock(bad);
    assert.equal(v.ok, false, `refuses ${JSON.stringify(bad)}`);
    assert.equal(v.block, null);
    assert.match(v.reason, /BOTH an endpoint and its state directory/);
  }
  // No token, ever — cowork reads it from stateDir itself.
  assert.equal(good.block.token, undefined);
  assert.deepEqual(Object.keys(good.block).sort(), ['endpoint', 'mode', 'stateDir']);
});

test('planCoworkConfig: the daemon selection is three-valued (leave / embedded / external)', () => {
  const base = { brokerUrl: 'wss://b', stateDir: '/home/u/.ours-cowork', restPort: 3052 };
  const embeddedCfg = { version: 1, brokerUrl: 'wss://b', stateDir: '/home/u/.ours-cowork', rest: { enabled: true, port: 3052 } };

  // undefined ⇒ LEAVE IT ALONE. This is the answer for an embedded install nobody
  // asked to migrate; with everything else unchanged it must be a total no-op.
  const untouched = planCoworkConfig(embeddedCfg, base);
  assert.equal(untouched.changed, false, 'an embedded install is not migrated by omission');
  assert.equal(untouched.previous.daemonMode, 'embedded');

  // external ⇒ write the documented block.
  const ext = planCoworkConfig(embeddedCfg, { ...base, daemon: { endpoint: 'http://127.0.0.1:3050', stateDir: '/home/u/.ours' } });
  assert.equal(ext.changed, true);
  const written = JSON.parse(ext.text);
  assert.deepEqual(written.daemon, { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: '/home/u/.ours' });
  // cowork's OWN state dir is a different key and is not disturbed by the daemon choice.
  assert.equal(written.stateDir, '/home/u/.ours-cowork');
  assert.notEqual(written.stateDir, written.daemon.stateDir);

  // Same external selection again ⇒ no rewrite.
  assert.equal(planCoworkConfig(written, { ...base, daemon: { endpoint: 'http://127.0.0.1:3050', stateDir: '/home/u/.ours' } }).changed, false);
  // A moved daemon IS a change, and the old selection is reported.
  const moved = planCoworkConfig(written, { ...base, daemon: { endpoint: 'http://127.0.0.1:3085', stateDir: '/home/u/.ours-rooms' } });
  assert.equal(moved.changed, true);
  assert.equal(moved.previous.daemonEndpoint, 'http://127.0.0.1:3050');
  assert.equal(moved.previous.daemonStateDir, '/home/u/.ours');
  assert.equal(JSON.parse(moved.text).daemon.stateDir, '/home/u/.ours-rooms');

  // null ⇒ back to EMBEDDED, which means the block is REMOVED, not set to null:
  // `daemon: null` is not the same document as no `daemon` key.
  const back = planCoworkConfig(written, { ...base, daemon: null });
  assert.equal(back.changed, true);
  const backObj = JSON.parse(back.text);
  assert.ok(!('daemon' in backObj), 'the block is deleted outright');
  assert.equal(coworkDaemonMode(backObj), 'embedded');
  // And going embedded when already embedded is a no-op.
  assert.equal(planCoworkConfig(embeddedCfg, { ...base, daemon: null }).changed, false);

  // A half-formed selection is refused rather than written — it would fail closed at boot.
  const partial = planCoworkConfig(embeddedCfg, { ...base, daemon: { endpoint: 'http://127.0.0.1:3050' } });
  assert.equal(partial.changed, false);
  assert.equal(partial.text, '');
  assert.match(partial.error, /BOTH an endpoint and its state directory/);

  // Keys the installer does not own still survive a daemon change.
  const extra = planCoworkConfig({ ...embeddedCfg, operatorNote: 'keep me' },
    { ...base, daemon: { endpoint: 'http://127.0.0.1:3050', stateDir: '/home/u/.ours' } });
  assert.equal(JSON.parse(extra.text).operatorNote, 'keep me');
});

test('coworkSupportsExternalDaemon: the BUILD decides, not the channel', () => {
  // The floor is the first published cowork that implements the mode, verified against
  // the registry AND its tarball contents (see the constant's comment in logic.mjs).
  assert.equal(COWORK_EXTERNAL_MIN_VERSION, '0.4.1-nightly.20260816.4aaf940');

  // Exactly the supporting build, and anything after it.
  assert.equal(coworkSupportsExternalDaemon(COWORK_EXTERNAL_MIN_VERSION), true);
  assert.equal(coworkSupportsExternalDaemon('0.4.1-nightly.20260817.abc1234'), true, 'a later nightly');
  assert.equal(coworkSupportsExternalDaemon('0.4.1'), true, 'the eventual 0.4.1 release outranks its nightlies');
  assert.equal(coworkSupportsExternalDaemon('0.5.0'), true);

  // The build the stable channel installs today predates it.
  assert.equal(coworkSupportsExternalDaemon('0.4.0'), false, 'cowork@latest has no external mode');
  // And so does an EARLIER nightly of the same core version — the case a channel-only
  // gate got wrong, and the reason the floor is a full version rather than an x.y.z.
  assert.equal(coworkSupportsExternalDaemon('0.4.1-nightly.20260815.80ea770'), false, 'an earlier same-day-core nightly');
  assert.equal(coworkSupportsExternalDaemon('0.3.7-nightly.20260815.80ea770'), false);

  // Unknown never claims support: an unreadable version keeps Rooms embedded.
  assert.equal(coworkSupportsExternalDaemon(''), false);
  assert.equal(coworkSupportsExternalDaemon(undefined), false);
  assert.equal(coworkSupportsExternalDaemon('not-a-version'), false);
  // Nor does an empty floor, whatever is installed.
  assert.equal(coworkSupportsExternalDaemon('99.0.0', ''), false);
});

test('compareVersions: semver precedence, and unparseable input never claims to be newer', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareVersions('1.3.0', '1.2.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.2', '1.2.3'), -1);
  assert.equal(compareVersions('0.4.0', '0.5.0'), -1);

  // A release outranks a prerelease of the same core version.
  assert.equal(compareVersions('1.2.3', '1.2.3-nightly.1'), 1);
  assert.equal(compareVersions('1.2.3-nightly.1', '1.2.3'), -1);

  // Two prereleases compare identifier by identifier, numerics numerically — which is
  // what orders cowork's nightly.<date>.<sha> line correctly.
  assert.equal(compareVersions('0.4.1-nightly.20260816.4aaf940', '0.4.1-nightly.20260815.80ea770'), 1);
  assert.equal(compareVersions('0.4.1-nightly.20260815.80ea770', '0.4.1-nightly.20260816.4aaf940'), -1);
  assert.equal(compareVersions('0.4.1-nightly.20260816.4aaf940', '0.4.1-nightly.20260816.4aaf940'), 0);
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1, 'numeric, not lexicographic');
  assert.equal(compareVersions('1.0.0-alpha.beta', '1.0.0-alpha.2'), 1, 'alphanumeric outranks numeric');
  assert.equal(compareVersions('1.0.0-alpha.1.1', '1.0.0-alpha.1'), 1, 'a longer identifier set is higher');

  // Garbage is never "newer": that would silently enable an unsupported path.
  for (const bad of ['', 'x', '1.2', undefined, null, 'v1.2.3']) {
    assert.equal(compareVersions(bad, '1.0.0'), -1, `${JSON.stringify(bad)} is not newer`);
  }
});
