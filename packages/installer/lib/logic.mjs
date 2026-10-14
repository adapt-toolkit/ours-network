// Pure, dependency-free logic for the ours.network installer — everything here is a plain
// function with no I/O so it can be unit-tested directly (no subprocess, no tty). The install.mjs
// orchestrator wires these to real npm/ours-mcp/tty calls; the integration tests drive that via
// install.sh. Keeping the decisions here means the tricky bits (harness canon, port-conflict,
// config merge, version parsing) are covered by fast, hermetic tests.

// canonHarnesses: normalize a free-form selection (numbers, names, or "all") into canonical
// harness names, de-duped, order-preserving. Faithful port of install.sh's canon_harnesses.
// Returns { names: string[], unknown: string[] } — unknown tokens are reported, not fatal.
export function canonHarnesses(raw) {
  const names = [];
  const unknown = [];
  const push = (n) => { if (!names.includes(n)) names.push(n); };
  const toks = String(raw || '').toLowerCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  for (const tok of toks) {
    switch (tok) {
      case 'all': case 'a':
        return { names: ['claude-code', 'codex', 'hermes'], unknown };
      case '1': case 'claude-code': case 'claude': case 'cc': push('claude-code'); break;
      case '2': case 'codex': push('codex'); break;
      case '3': case 'hermes': push('hermes'); break;
      case 'none': case 'skip': case '0': break;
      default: unknown.push(tok);
    }
  }
  return { names, unknown };
}

// ── Release CHANNEL / npm dist-tag selection ───────────────────────────────────
// The installer normally installs everything at @latest (stable). Setting
// OURS_CHANNEL=nightly (or OURS_INSTALL_CHANNEL) makes it install each package's
// PRERELEASE dist-tag instead — for the packages that publish one.
//
// The prerelease tag is NOT the same string everywhere, which is why this is a
// per-package map rather than one global tag:
//   · mcp, tg-connector, claude-code, codex, hermes  → `nightly` (lockstep-published
//     from this repo by .github/workflows/scripts/bump-versions.sh)
//   · fleet                                          → `nightly` (its own repo,
//     adapt-toolkit/ours-fleet, publishes a nightly dist-tag of its own)
//   · cowork (rooms)                                 → `nightly` (cowork aligns
//     with every other service rather than keeping its
//     historical `next` tag)
//
// WHY FLEET FOLLOWS THE CHANNEL NOW. It used to be pinned to @latest with the note
// "ours-fleet publishes no nightly tag". It does publish one, and the nightly stack
// needs the fleet build carrying the SDK integration — the same architecture
// boundary that made a mixed tg-connector fatal applies here. A nightly installer
// that silently installs stable fleet is exactly the split-brain deployment the
// channel exists to prevent.
//
// WHY COWORK STILL NEEDS ITS OWN ENTRY. It historically published its prerelease
// line as `next`; the decision is that it aligns with every
// other service and publishes `nightly` instead. The entry stays because the map,
// not a hardcoded string, is what makes such a change one line — and because an
// UNMAPPED package deliberately falls back to `latest` rather than a guessed tag.
//
// The nightly channel MUST reach cowork's prerelease line: the external-daemon
// mode the Rooms step configures ships there (cowork PR #9), so a nightly
// installer taking `latest` would pair a config carrying a `daemon` block with a
// build that predates it — the same architecture-boundary mismatch this whole
// mechanism exists to prevent, pointed at Rooms instead of Telegram.
//
// SEQUENCING — load-bearing, and not yet satisfied. cowork
// publishes NO `nightly` dist-tag at all (its tags are latest=0.4.0 and
// next=0.3.7-nightly.20260815.80ea770). `npm i -g @ours.network/cowork@nightly`
// therefore 404s today, and a 404 fails the WHOLE install. So the nightly
// installer must not be published until cowork's release flow has actually
// published a `nightly` artifact carrying PR #9. Verify the tag exists AND that
// the tarball contains the implementation — never trust the tag alone. See
// coworkSupportsExternalDaemon for the guard that keeps a build without the mode
// from ever being handed a daemon block.
export const DEFAULT_CHANNEL = 'latest';

// Per-package dist-tag by channel. A package absent from this map, or missing a
// key for the selected channel, installs @latest — this never guesses a tag that
// might not exist, because a 404 fails the WHOLE install.
const PKG_CHANNEL_TAGS = {
  mcp: { nightly: 'nightly' },
  'tg-connector': { nightly: 'nightly' },
  'claude-code': { nightly: 'nightly' },
  codex: { nightly: 'nightly' },
  hermes: { nightly: 'nightly' },
  fleet: { nightly: 'nightly' },
  cowork: { nightly: 'nightly' }, // aligned with every other service
};

// Normalize a raw channel selection to 'latest' | 'nightly'. Anything unrecognized
// (incl. undefined/'') falls back to the installer's OWN channel — never guesses a tag.
//
// WHY THE INSTALLER'S OWN VERSION IS A CHANNEL SIGNAL. `@ours.network/install` is
// published on both dist-tags from the same lockstep bump (.github/workflows/scripts/
// bump-versions.sh), so a nightly build carries a `-nightly.N` version and a stable
// build does not. Without this, `npm i -g @ours.network/install@nightly && ours-install`
// installed the nightly INSTALLER but @latest for everything it installs — which since
// tg-connector 0.3.3-nightly.1 is not merely older but a DIFFERENT ARCHITECTURE (0.3.2
// hosts its own ADAPT wrapper; the nightly attaches to the shared daemon over /api/v1,
// which only the SDK-based daemon serves). Mixing the two tags across that boundary is
// exactly the split-brain deployment this must not produce. A stable installer stays on
// @latest and can never consume a nightly; an explicit OURS_CHANNEL always wins over both.
export function resolveChannel(raw, selfVersion = '') {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'nightly' || v === 'prerelease' || v === 'next') return 'nightly';
  if (v === 'latest' || v === 'stable') return DEFAULT_CHANNEL;
  if (v) return DEFAULT_CHANNEL; // unrecognized: never guess, never inherit
  return isNightlyVersion(selfVersion) ? 'nightly' : DEFAULT_CHANNEL;
}

// A published nightly carries the `-nightly.N` prerelease suffix the bump script writes.
export function isNightlyVersion(version) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.(?:0|[1-9]\d*)$/.test(String(version || ''));
}

// The npm dist-tag to install for one package key under a channel. Looks the key
// up in PKG_CHANNEL_TAGS; anything unmapped — including an unknown package —
// falls back to 'latest' rather than inventing a tag that would 404.
export function pkgTag(pkgKey, channel = DEFAULT_CHANNEL) {
  const key = String(pkgKey || '').replace(/^@ours\.network\//, '');
  const ch = resolveChannel(channel);
  if (ch === DEFAULT_CHANNEL) return 'latest';
  return PKG_CHANNEL_TAGS[key]?.[ch] ?? 'latest';
}

// Full `@ours.network/<key>@<tag>` spec for `npm i -g`, honoring the channel.
export function pkgSpec(pkgKey, channel = DEFAULT_CHANNEL) {
  const key = String(pkgKey || '').replace(/^@ours\.network\//, '');
  return `@ours.network/${key}@${pkgTag(key, channel)}`;
}

// Ports other components in the stack own, which the installer must never hand a
// daemon: 3051 is the Telegram connector's, 3052 is ours-cowork's loopback console
// (its config default; see COWORK_DEFAULT_PORT).
export const RESERVED_PORTS = [3051, 3052];
export const DEFAULT_PORT = 3050;
export const DEFAULT_BROKER = 'wss://broker1.ours.network';

// ── Handing the Telegram connector the ONE shared daemon ───────────────────────
// The connector has its OWN config file and never inherits the daemon's. Two
// generations of it are in the wild and the installer must satisfy BOTH, because
// which one gets installed is a channel decision (see pkgTag):
//
//   @nightly (>=0.3.3-nightly.1) — SDK-based. It ATTACHES to an already-running
//     ours daemon over /api/v1 and has NO broker at all. It selects the daemon
//     through @ours.network/sdk's resolveDaemonConfig, whose behaviour we verified
//     against the published SDK 0.1.2 (the version the nightly pins):
//       · with no overrides it reports configPath: null — the daemon's
//         ~/.ours/config.json is NEVER read implicitly, so a daemon on any port
//         other than the built-in 3050 is simply MISSED.
//       · pointing OURS_CONFIG at that file, or passing an endpoint alone, throws
//         INCOHERENT_SELECTION: "the endpoint was selected … but the state
//         directory is the built-in default" — a deliberate credential-disclosure
//         guard that refuses BEFORE any token is read.
//       · endpoint AND state dir together resolve cleanly.
//     So the ONLY correct contract is to give it BOTH daemonUrl and daemonStateDir.
//
//   @latest (<=0.3.2) — the older self-hosting ADAPT wrapper. It ignores
//     daemonUrl/daemonStateDir and meets the daemon at a BROKER instead, so its
//     brokerUrl must match the daemon's or the two can never see each other.
//
// Writing all three keys satisfies whichever generation is installed: each reads
// only the keys it understands and ignores the rest. This matters at INSTALL time
// specifically, because `ours-tg-connector install-service` BAKES its resolved
// values into the service unit as environment variables, and env outranks the
// config file forever after — a divergence created here can never be repaired by
// editing that file.

// The daemon's loopback endpoint. The daemon always binds 127.0.0.1 (never a
// hostname), so this is the address the connector must be given.
export function daemonEndpoint(port) {
  return `http://127.0.0.1:${port}`;
}

// The broker the whole deployment shares, for a <=0.3.2 connector.
// Precedence: what the user chose in THIS run > what the running daemon actually
// resolved (`ours daemon status`, which accounts for the selected config) > what
// the daemon's config file says > the built-in default (identical to the daemon's
// DEFAULT_CONFIG.brokerUrl, so "no answer anywhere" still agrees).
export function resolveSharedBroker({ chosenBroker, statusBroker, configBroker } = {}) {
  for (const candidate of [chosenBroker, statusBroker, configBroker]) {
    const v = validateBroker(candidate ?? '');
    if (!v.empty && v.ok) return v.value;
  }
  return DEFAULT_BROKER;
}

// The Telegram connector's own config file (mirrors its src/config.ts: OURS_TG_CONFIG,
// else <home>/.ours-telegram/config.json — a FIXED location, independent of its stateDir).
export function tgConfigPath(env = {}, home = '') {
  return env.OURS_TG_CONFIG || `${home}/.ours-telegram/config.json`;
}

// Decide whether the connector's config needs a write, and what to write. Returns
// { changed, text, previous } — `changed` is false when the file already names this
// exact daemon and broker, so an idempotent re-run touches nothing. Unrelated keys
// the user or the connector added (bot tokens, STT settings) are preserved.
export function planTgDaemonConfig(existing, { daemonUrl, daemonStateDir, brokerUrl } = {}) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const str = (v) => (typeof v === 'string' ? v : '');
  const previous = {
    daemonUrl: str(base.daemonUrl),
    daemonStateDir: str(base.daemonStateDir),
    brokerUrl: str(base.brokerUrl),
  };
  const next = { daemonUrl, daemonStateDir, brokerUrl };
  const changed = Object.entries(next).some(([k, v]) => v !== undefined && previous[k] !== v);
  if (!changed) return { changed: false, text: '', previous };
  return { changed: true, text: mergeConfig(base, next), previous };
}

// ── Rooms / ours-cowork ────────────────────────────────────────────────────────
// cowork supports an external-daemon mode, so Rooms can use the same
// common-vs-dedicated selection as the Telegram connector. Its public config
// contract is:
//
//   ~/.ours-cowork/config.json carries an OPTIONAL `daemon` block.
//     absent  ⇒ EMBEDDED — cowork hosts its own daemon (what every install
//               before external mode existed, and still the safe answer for one already
//               running that way).
//     present ⇒ { mode: 'external', endpoint: 'http://127.0.0.1:<port>',
//                 stateDir: '<absolute ours-daemon state dir>' }
//   External REQUIRES both endpoint and stateDir. cowork never stores or asks for
//   a token — its SDK reads <stateDir>/daemon-token, which is why the state
//   directory is part of the selection rather than derivable from the endpoint.
//   Env equivalents: OURS_COWORK_DAEMON_MODE / _ENDPOINT / _STATE_DIR, and the
//   service unit carries only those — never a token.
//   Boot is FAIL-CLOSED: an unavailable endpoint, a non-ours daemon, or a
//   stateDir that does not match it aborts startup. There is no embedded
//   fallback, so writing this block is a real commitment and must never be done
//   to an install that did not ask for it.
//
// NOTE the two different `stateDir` keys. The TOP-LEVEL one is cowork's own
// private state. `daemon.stateDir` is the OURS daemon's state directory, where
// that daemon's API token lives. Confusing them fails closed at boot.
export const COWORK_DEFAULT_PORT = 3052;
export const COWORK_DAEMON_MODES = ['embedded', 'external'];

// Which cowork builds understand the `daemon` block. Its config is a STRICT
// document, so handing an unknown key to a build that predates external mode is not a
// harmless no-op — and cowork's boot is fail-closed, so the failure surfaces as a
// Rooms daemon that will not start rather than a warning.
//
// The first published cowork version whose package contains external-daemon
// config parsing, endpoint/state-directory pairing, and daemon-token loading.
export const COWORK_EXTERNAL_MIN_VERSION = '0.4.1-nightly.20260816.4aaf940';

// Does the cowork build actually on this machine support an external daemon?
//
// This is deliberately a VERSION check and not a channel check. A channel gate
// would answer "yes" for any nightly install, including one made before this
// version was published — and a `daemon` block handed to a build without the mode
// meets a strict config and a fail-closed boot, i.e. Rooms that will not start.
// The version is read after the install, so it describes what is really there.
// An unreadable version yields -1 below and therefore "no", which keeps Rooms
// embedded rather than guessing.
export function coworkSupportsExternalDaemon(installedVersion = '', minVersion = COWORK_EXTERNAL_MIN_VERSION) {
  if (!minVersion) return false;   // no published build supports it yet
  return compareVersions(String(installedVersion || ''), minVersion) >= 0;
}

// Semver precedence, enough for a published-release floor: x.y.z numerically,
// then prerelease rules — a release outranks a prerelease of the same core
// version, and two prereleases compare identifier by identifier (numeric parts
// numerically, so nightly.20260815 < nightly.20260816). Returns -1 / 0 / 1, and
// -1 for anything unparseable, so garbage NEVER claims to be new enough.
export function compareVersions(a, b) {
  const split = (v) => {
    const m = String(v ?? '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const x = split(a);
  const y = split(b);
  if (!x || !y) return -1;
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  }
  if (x.pre === null && y.pre === null) return 0;
  if (x.pre === null) return 1;   // 1.0.0 outranks 1.0.0-nightly.1
  if (y.pre === null) return -1;
  const xs = x.pre.split('.');
  const ys = y.pre.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const xi = xs[i];
    const yi = ys[i];
    if (xi === undefined) return -1;         // a shorter identifier set is lower
    if (yi === undefined) return 1;
    const xn = /^\d+$/.test(xi);
    const yn = /^\d+$/.test(yi);
    if (xn && yn) {
      if (Number(xi) !== Number(yi)) return Number(xi) > Number(yi) ? 1 : -1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;                    // numeric identifiers rank below alphanumeric
    } else if (xi !== yi) {
      return xi > yi ? 1 : -1;
    }
  }
  return 0;
}

// Which daemon an existing cowork config is set up for. No block ⇒ embedded.
export function coworkDaemonMode(existing) {
  const block = existing && typeof existing === 'object' ? existing.daemon : null;
  if (!block || typeof block !== 'object') return 'embedded';
  return block.mode === 'external' ? 'external' : 'embedded';
}

// Build the external `daemon` block. Returns { ok, block, reason } — external is
// refused without BOTH halves rather than written half-formed, because a partial
// block fails closed at cowork's boot and the user would only find out then.
export function coworkDaemonBlock({ endpoint, stateDir } = {}) {
  const e = String(endpoint || '').trim();
  const s = String(stateDir || '').trim();
  if (!e || !s) {
    return { ok: false, block: null, reason: 'an external daemon needs BOTH an endpoint and its state directory' };
  }
  return { ok: true, block: { mode: 'external', endpoint: e, stateDir: s }, reason: '' };
}

// The cowork config file (mirrors its docs/03-configuration.md: OURS_COWORK_CONFIG,
// else <home>/.ours-cowork/config.json).
export function coworkConfigPath(env = {}, home = '') {
  return env.OURS_COWORK_CONFIG || `${home}/.ours-cowork/config.json`;
}

// Decide whether cowork's config needs a write, and what to write. Same contract
// as planTgDaemonConfig: { changed, text, previous }, unchanged ⇒ nothing written,
// so a re-run is a no-op. Its `rest` block is merged rather than replaced, so an
// operator's explicit `rest.enabled: false` survives a port update.
// `daemon` is three-valued on purpose:
//   undefined — do not touch the daemon selection at all (an existing embedded
//               install this run was not asked to migrate)
//   null      — EMBEDDED: remove any block, cowork hosts its own daemon again
//   {endpoint, stateDir} — EXTERNAL: point it at that ours daemon
export function planCoworkConfig(existing, { brokerUrl, stateDir, restPort, daemon } = {}) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const baseRest = base.rest && typeof base.rest === 'object' ? base.rest : {};
  const previous = {
    brokerUrl: typeof base.brokerUrl === 'string' ? base.brokerUrl : '',
    stateDir: typeof base.stateDir === 'string' ? base.stateDir : '',
    restPort: Number.isInteger(baseRest.port) ? baseRest.port : null,
    daemonMode: coworkDaemonMode(base),
    daemonEndpoint: base.daemon?.endpoint ?? '',
    daemonStateDir: base.daemon?.stateDir ?? '',
  };

  let nextDaemon;                       // undefined ⇒ leave the block alone
  let daemonChanged = false;
  if (daemon === null) {
    nextDaemon = null;
    daemonChanged = previous.daemonMode !== 'embedded';
  } else if (daemon !== undefined) {
    const built = coworkDaemonBlock(daemon);
    if (!built.ok) return { changed: false, text: '', previous, error: built.reason };
    nextDaemon = built.block;
    daemonChanged = previous.daemonMode !== 'external'
      || previous.daemonEndpoint !== built.block.endpoint
      || previous.daemonStateDir !== built.block.stateDir;
  }

  const changed = daemonChanged
    || (brokerUrl !== undefined && previous.brokerUrl !== brokerUrl)
    || (stateDir !== undefined && previous.stateDir !== stateDir)
    || (restPort !== undefined && previous.restPort !== restPort);
  if (!changed) return { changed: false, text: '', previous };

  const patch = { version: 1 };
  if (brokerUrl !== undefined) patch.brokerUrl = brokerUrl;
  if (stateDir !== undefined) patch.stateDir = stateDir;
  if (restPort !== undefined) patch.rest = { ...baseRest, enabled: baseRest.enabled ?? true, port: restPort };
  if (nextDaemon !== undefined) patch.daemon = nextDaemon;
  const merged = mergeConfig(base, patch);
  // mergeConfig keeps every key it is handed; an EMBEDDED selection has to drop
  // the block outright, since `daemon: null` is not the same as no block.
  if (nextDaemon === null) {
    const obj = JSON.parse(merged);
    delete obj.daemon;
    return { changed: true, text: JSON.stringify(obj, null, 2) + '\n', previous };
  }
  return { changed: true, text: merged, previous };
}

// suggestPort: pick a usable HTTP port. If `desired` is free and not reserved, keep it. Otherwise
// scan upward from 3060 (the brief's suggested alternate band) for the first free, non-reserved
// port. `isTaken(port)` is injected so this stays pure and testable (real caller probes a bind).
export function suggestPort(desired, isTaken, { reserved = RESERVED_PORTS, floor = 3060 } = {}) {
  const taken = (p) => reserved.includes(p) || isTaken(p);
  if (!taken(desired)) return desired;
  for (let p = Math.max(floor, desired + 1); p < desired + 1000; p++) {
    if (!taken(p)) return p;
  }
  return desired; // exhausted — let the caller surface it; never silently loop forever
}

// A port string is valid if it's an integer in the ephemeral-safe user range.
export function parsePort(input, fallback = DEFAULT_PORT) {
  const n = Number.parseInt(String(input).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, port: fallback };
  return { ok: true, port: n };
}

// Basic sanity for a broker address: must look like a ws:// or wss:// URL. Empty → keep default
// (handled by caller). We don't hard-fail on odd input, just report so the caller can warn.
export function validateBroker(input) {
  const s = String(input).trim();
  if (!s) return { ok: true, value: '', empty: true };
  const ok = /^wss?:\/\/[^\s]+$/i.test(s);
  return { ok, value: s, empty: false };
}

// mergeConfig: take the existing parsed config.json object and a patch of only the keys the user
// changed, returning the pretty-printed strict-JSON text to write (stable key handling, trailing
// newline). Never drops unrelated keys the daemon or user added.
export function mergeConfig(existing, patch) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return JSON.stringify(out, null, 2) + '\n';
}

export const VOICE_PROVIDERS = ['openai-compatible', 'elevenlabs', 'deepgram', 'custom'];

// Resolve only the STT fields the daemon itself accepts. Environment values override
// config.json field-by-field, matching packages/core/src/config.ts. The returned object
// may contain a secret, so callers must never print or serialize it into diagnostics.
export function effectiveVoiceConfig(config = {}, env = {}) {
  const file = config?.stt && typeof config.stt === 'object' ? config.stt : {};
  const out = { ...file };
  const envFields = {
    provider: env.OURS_STT_PROVIDER,
    apiKey: env.OURS_STT_API_KEY,
    model: env.OURS_STT_MODEL,
    baseUrl: env.OURS_STT_BASE_URL,
    language: env.OURS_STT_LANGUAGE,
  };
  for (const [key, raw] of Object.entries(envFields)) {
    if (typeof raw === 'string' && raw.trim()) out[key] = raw.trim();
  }
  return out;
}

// Capability/readiness check, deliberately based on required fields rather than a package
// version. Reasons contain field names only — never secret values.
export function voiceSetupStatus(config = {}, env = {}) {
  const stt = effectiveVoiceConfig(config, env);
  const provider = String(stt.provider || '').trim().toLowerCase();
  if (!provider) return { ready: false, provider: '', reason: 'no voice provider configured', missing: ['provider'] };
  if (!VOICE_PROVIDERS.includes(provider)) {
    return { ready: false, provider, reason: `unsupported voice provider "${provider}"`, missing: ['provider'] };
  }
  if (!String(stt.apiKey || '').trim()) {
    return { ready: false, provider, reason: `voice provider "${provider}" is missing its API key`, missing: ['apiKey'] };
  }
  if (provider === 'openai-compatible') {
    const missing = [];
    if (!String(stt.baseUrl || '').trim()) missing.push('baseUrl');
    if (!String(stt.model || '').trim()) missing.push('model');
    if (missing.length) return { ready: false, provider, reason: `openai-compatible voice setup is missing ${missing.join(' and ')}`, missing };
  }
  if (provider === 'elevenlabs' && !String(stt.model || '').trim()) {
    return { ready: false, provider, reason: 'elevenlabs voice setup is missing model', missing: ['model'] };
  }
  if (provider === 'custom') {
    if (!String(stt.custom?.url || '').trim()) {
      return { ready: false, provider, reason: 'custom voice setup is missing custom.url', missing: ['custom.url'] };
    }
    const wantsModel = stt.custom.url.includes('{model}')
      || (stt.custom.modelField !== undefined && stt.custom.modelField !== '');
    if (wantsModel && !String(stt.model || '').trim()) {
      return { ready: false, provider, reason: 'custom voice setup references a model but model is missing', missing: ['model'] };
    }
  }
  return {
    ready: true,
    provider,
    reason: 'voice transcription is configured',
    missing: [],
    keySource: typeof env.OURS_STT_API_KEY === 'string' && env.OURS_STT_API_KEY.trim() ? 'environment' : 'config',
  };
}

// Provider keys have different shapes, so validation is intentionally conservative: reject
// empty, tiny, whitespace-containing, or control-character input without assuming a vendor prefix.
export function validateVoiceSecret(input) {
  const value = String(input || '').trim();
  if (value.length < 8) return { ok: false, reason: 'API key must contain at least 8 characters' };
  if (/[\s\x00-\x1f\x7f]/.test(value)) return { ok: false, reason: 'API key must not contain whitespace or control characters' };
  return { ok: true, value };
}

// Last-resort diagnostic scrubber. Code should avoid putting secrets into errors in the first
// place; this protects unexpected provider/tool errors before they reach a terminal or log.
export function redactSensitive(text, secrets = []) {
  let out = String(text ?? '');
  for (const raw of secrets) {
    const secret = String(raw || '');
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/("(?:apiKey|apiToken|token)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
    .replace(/((?:api[_ -]?key|token)\s*[=:]\s*)\S+/gi, '$1[redacted]');
}

// parseVersion: pull the first x.y.z out of a version string (e.g. `ours-mcp v0.9.9`), matching
// install.sh's `grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1`. Returns '' when none is present.
export function parseVersion(text) {
  const m = String(text || '').match(/[0-9]+\.[0-9]+\.[0-9]+/);
  return m ? m[0] : '';
}

// parseStatus: read the daemon's RESOLVED broker + port out of `ours daemon status` output, so we
// prompt with what the daemon is actually using rather than a hardcoded guess. Returns
// { broker, port } with either field null when the line isn't present (daemon stopped / older
// build). Lines look like:  "  broker: wss://broker1.ours.network"  and
// "  url:    http://localhost:3050/mcp (reachable)".
export function parseStatus(text) {
  const s = String(text || '');
  const bm = s.match(/^\s*broker:\s*(\S+)/m);
  // `api:` is the current line and `url:` the historical one. Both are matched
  // because a newly installed CLI can be asked to report on an older running
  // daemon, and a parser that knows only today's wording reads that as "no port".
  const pm = s.match(/(?:api|url):\s*https?:\/\/[^:\s/]+:(\d+)/i);
  return {
    broker: bm ? bm[1] : null,
    port: pm ? Number.parseInt(pm[1], 10) : null,
  };
}

// ===============================================================================================
// v2 unified-installer logic (all pure — the orchestrator injects the real probe/uname/env).
// ===============================================================================================

// detectPlatform: classify the host from process.platform + the kernel release string + env.
// - darwin              → macOS  (supported)
// - linux + microsoft/WSL in release, or WSL_* env  → WSL  (supported)
// - linux               → Linux  (supported)
// - win32               → Windows (NOT supported in v1 — the caller prints a WSL pointer + exits)
// - anything else       → unknown (unsupported)
// Returns { os, label, supported }.
export function detectPlatform({ platform, release = '', env = {} } = {}) {
  const rel = String(release).toLowerCase();
  const isWsl = !!(env.WSL_DISTRO_NAME || env.WSL_INTEROP) || /microsoft|wsl/.test(rel);
  switch (platform) {
    case 'darwin': return { os: 'macos', label: 'macOS', supported: true };
    case 'linux':
      return isWsl
        ? { os: 'wsl', label: 'Windows (WSL)', supported: true }
        : { os: 'linux', label: 'Linux', supported: true };
    case 'win32': return { os: 'windows', label: 'Windows (native)', supported: false };
    default: return { os: 'unknown', label: platform || 'unknown', supported: false };
  }
}

// classifyHarnessProbe: turn what we observed about a harness command into a safety verdict,
// WITHOUT ever having called it unsafely. Inputs (all gathered by the orchestrator):
//   onPath      — `command -v <name>` found an executable on PATH
//   versionOk   — a non-interactive `<name> --version` returned 0 promptly with sane output
//   timedOut    — that probe had to be killed (an interactive/hanging wrapper — NEVER call it)
//   shellType   — `type -t <name>` in the user's shell: 'alias' | 'function' | 'file' | ''
// Verdict.status:
//   'ok'      — a real binary that answers --version → safe to drive
//   'alias'   — shadowed by a shell alias/function (or a wrapper that hangs) → do NOT call it,
//               tell the user plainly + how to fix, and ALWAYS still offer a manual path
//   'unsafe'  — on PATH but the probe failed/looked wrong → don't auto-drive; offer manual path
//   'absent'  — genuinely not installed → this harness is skipped (with a note)
// The golden rule: 'alias'/'unsafe'/'absent' NEVER dead-end — the caller always
// prints a manual-install path so the component still gets installed.
export function classifyHarnessProbe({ onPath, versionOk, timedOut, shellType = '' } = {}) {
  if (versionOk) return { status: 'ok', detail: 'real program' };
  if (timedOut) return { status: 'alias', detail: 'a wrapper that did not answer --version' };
  const t = String(shellType).toLowerCase();
  if (t === 'alias' || t === 'function') {
    return { status: 'alias', detail: `a shell ${t}, not the real command` };
  }
  if (onPath) return { status: 'unsafe', detail: 'found, but did not answer --version' };
  return { status: 'absent', detail: 'not installed' };
}

// harnessAvailable: a harness we can safely DRIVE headlessly right now.
export function harnessAvailable(status) { return status === 'ok'; }

// buildHandoffPrompt: the literal copy-paste hand-off text (delta #1861). Steps for components
// that were NOT installed drop out and the remaining steps renumber, so the user never sees an
// instruction for a piece they don't have. The human identity is normally created DURING install,
// so its step is included ONLY as a fallback (identity: true) when in-install creation was skipped
// or failed. Returns { text, empty } — empty is true when there is nothing left to finish.
export function buildHandoffPrompt({ identity = false, fleet = false, telegram = false, rooms = false } = {}) {
  const steps = [];
  if (identity) {
    steps.push(
      'Create my Ours human identity — this is me, the human; my agents act on\n' +
      '   my behalf. Ask me what name others should see, then create it.',
    );
  }
  if (fleet) {
    steps.push(
      'Set up my ours-fleet: ask me what agents I want in my fleet for\n' +
      '   PERMANENT use (a name + role/purpose for each), then create and\n' +
      '   configure those permanent fleet agents for me.',
    );
  }
  if (telegram) {
    steps.push(
      'Set up my Telegram bot: ask me for my bot\'s name and its token from\n' +
      '   @BotFather, register the bot, create a chat↔agent connection, and\n' +
      '   give me the invite link to send.',
    );
  }
  if (rooms) {
    steps.push(
      'Set up my first Rooms mission room: ask me what the room is for and what\n' +
      '   to call it, create it, then walk me through inviting the people and\n' +
      '   agents who should have a seat.',
    );
  }
  if (steps.length === 0) return { text: '', empty: true };
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const text =
    'I just installed the ours.network stack. Please help me finish setup, one\n' +
    'step at a time, explaining as you go:\n\n' +
    numbered + '\n\n' +
    'Do these in order, wait for my answers, and tell me if you need anything\n' +
    "from me. Don't assume — ask.";
  return { text, empty: false };
}

// summarizeComponent: normalize one component's outcome into a summary row the final screen and
// the report share. state ∈ 'installed'|'skipped'|'failed'|'current'. Pure formatting only.
export function summarizeComponent({ key, label, state, version = '', note = '' }) {
  const mark = state === 'failed' ? '✗' : state === 'skipped' ? '·' : '✓';
  return { key, label, state, version, note, mark };
}
