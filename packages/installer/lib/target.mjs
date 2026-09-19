// ours-install v3 — argument handling and daemon detection.
//
// Pure argument handling and daemon-target selection. The orchestrator
// injects the probe, the file reads and the port check, so the whole decision
// table is testable without a socket, a daemon or a filesystem.
//
// THE ONE IDEA. A daemon is identified by its STATE DIRECTORY, not by its port.
// `--state-dir` is the key; `--port` is derived from whatever daemon already
// owns that directory, and is only searched when this run creates one. Every
// function below follows from that.

import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_STATE_DIR_NAME = '.ours';
export const INSTALL_DEFAULT_PORT = 3050;
export const FREE_PORT_FLOOR = 3050;
export const FREE_PORT_SPAN = 1000;

// Ports that are other components' DEFAULTS, not facts about the machine: 3051
// is the Telegram connector's, 3052 is cowork's loopback console. The free-port
// search skips them; an explicit --port is still honoured exactly as typed.
//
// Keep both component defaults out of automatic selection: 3051 belongs to the
// Telegram connector and 3052 to cowork. Explicit operator selections remain
// valid.
export const INSTALL_RESERVED_PORTS = [3051, 3052];

// The CLI-owned PID record that proves a daemon belongs to a state directory
// even when nothing is recorded in its config.
export const CLI_PID_RECORD = 'ours-cli-daemon.json';
// The SAME record, written by a different daemon. `ours daemon start` writes
// ours-cli-daemon.json; prerelease ours-mcp wrote daemon.pid (packages/core
// cli.ts PID_PATH). BOTH are read, and neither replaces the other: a machine
// installed yesterday has the first and a machine installed today has the
// second, and detection that goes blind on either one concludes "no daemon
// here" and creates a SECOND daemon on a state directory that already has one.
// Two writers on one state_data.bin is the corruption case this lookup exists
// to prevent, so the lookup has to know both spellings.
export const MCP_PID_RECORD = 'daemon.pid';
export const PID_RECORDS = [CLI_PID_RECORD, MCP_PID_RECORD];

/**
 * The port a PID record names, whichever daemon wrote it.
 *
 * ours-cli-daemon.json is JSON with a `port`. daemon.pid is a bare pid — no
 * port — so it proves a daemon EXISTS for this state directory without saying
 * where. That distinction is the whole reason this returns both fields.
 */
export function readPidRecords(target, readJson, readText) {
  const record = readJson(join(target, CLI_PID_RECORD));
  const port = record && typeof record.port === 'number' && Number.isFinite(record.port) ? record.port : null;
  const rawPid = typeof readText === 'function' ? readText(join(target, MCP_PID_RECORD)) : null;
  const pid = rawPid !== null && rawPid !== undefined && /^\s*\d+\s*$/.test(String(rawPid))
    ? Number.parseInt(String(rawPid).trim(), 10)
    : null;
  return { port, pid };
}
export const DAEMON_CONFIG = 'config.json';

export class InstallUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstallUsageError';
    this.exitCode = 2;
  }
}

const PROFILE_KEYS = ['endpoint', 'expectedInstanceId', 'credentialPath'];
const LEGACY_PROFILE_KEYS = ['port', 'stateDir', 'apiToken', 'apiVisibility'];
const PROFILE_CONFLICT_ENV = ['OURS_API_TOKEN', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_DAEMON_ID'];
const PROFILE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const profileError = (message) => new InstallUsageError(`Invalid external host profile: ${message}`);

export function validateHostProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw profileError('expected a complete host profile object.');
  }
  const present = PROFILE_KEYS.filter((key) => Object.hasOwn(value, key));
  if (present.length !== 0 && present.length !== PROFILE_KEYS.length) {
    throw profileError('expected a complete host profile tuple: endpoint, expectedInstanceId, credentialPath.');
  }
  if (present.length === 0) return null;
  const mixed = LEGACY_PROFILE_KEYS.filter((key) => Object.hasOwn(value, key));
  if (mixed.length) throw profileError(`legacy selection keys cannot be mixed with a host profile (${mixed.join(', ')}).`);
  const { endpoint, expectedInstanceId, credentialPath } = value;
  if (typeof endpoint !== 'string' || endpoint.trim() !== endpoint || endpoint === '') throw profileError('endpoint must be a non-empty HTTP or HTTPS origin.');
  if (typeof expectedInstanceId !== 'string' || !PROFILE_UUID.test(expectedInstanceId)) throw profileError('expectedInstanceId must be a lowercase UUID.');
  if (typeof credentialPath !== 'string' || credentialPath === '' || !credentialPath.startsWith('/') || resolve(credentialPath) !== credentialPath) {
    throw profileError('credentialPath must be a normalized absolute path.');
  }
  let url;
  try { url = new URL(endpoint); } catch { throw profileError('endpoint must be an HTTP or HTTPS origin.'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw profileError('endpoint must be an HTTP or HTTPS origin without credentials, path, query, or fragment.');
  }
  return { endpoint: url.origin, expectedInstanceId, credentialPath };
}

export function resolveProfileSelection({ args, env = {}, home = homedir(), exists, readProfile }) {
  const explicit = (env.OURS_CONFIG ?? '').trim();
  const configPath = explicit ? resolve(explicit) : resolve(home, DEFAULT_STATE_DIR_NAME, DAEMON_CONFIG);
  if (!explicit && !exists(configPath)) return { mode: 'local' };
  if (explicit && !exists(configPath)) throw new InstallUsageError(`Cannot read host profile ${JSON.stringify(configPath)}.`);
  let value;
  try { value = readProfile(configPath); }
  catch (error) { throw new InstallUsageError(error instanceof Error ? error.message : String(error)); }
  const profile = value === null ? null : validateHostProfile(value);
  if (profile === null) return { mode: 'local' };
  if (args.stateDirExplicit || args.portExplicit) throw profileError('--state-dir or --port conflicts with host-profile mode.');
  const conflicting = PROFILE_CONFLICT_ENV.filter((key) => (env[key] ?? '').trim() !== '');
  if (conflicting.length) throw profileError(`${conflicting.join(', ')} conflicts with host-profile mode.`);
  return { mode: 'host-profile', configPath, profile };
}

export function profileEnv(selection) {
  if (selection?.mode !== 'host-profile' || typeof selection.configPath !== 'string') throw new Error('profileEnv requires a host-profile selection');
  return { OURS_CONFIG: selection.configPath };
}

// Lexical path comparison, matching how the SDK compares a reported state
// directory against a selected one. Resolving symlinks would mean touching the
// filesystem before validation, which is what this comparison exists to avoid.
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return resolve(a) === resolve(b);
}

// -----------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['--state-dir', '--port']);
const BOOLEAN_FLAGS = new Set(['--dry-run', '--help', '--version']);
const ALIASES = new Map([['-h', '--help'], ['-V', '--version']]);

/**
 * `ours-install [--state-dir PATH] [--port N] [--dry-run] [--help] [--version]`
 *
 * Returns the run's target with both values already resolved, so the opening
 * screen can echo exactly what the run will act on. An unknown flag, a missing
 * value or an out-of-range port is an InstallUsageError (exit 2) — the installer
 * never guesses what an operator meant.
 *
 * `port` is null when not given. That is meaningful: "not given" lets the port be
 * derived from an existing daemon, whereas an explicit value must be honoured or
 * refused, never quietly moved.
 */
export function parseInstallArgs(argv = [], env = {}, { home = homedir() } = {}) {
  const out = {
    stateDir: null,
    port: null,
    // `stateDir` is always populated (it defaults to ~/.ours), so "was it given?"
    // needs its own flag — the selection screen has to tell an explicit target from
    // a defaulted one, and a defaulted value looks identical to a chosen one.
    stateDirExplicit: false,
    portExplicit: false,
    dryRun: env.OURS_INSTALL_DRY_RUN === '1',
    assumeYes: env.OURS_ASSUME_YES === '1',
    help: false,
    version: false,
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i]);
    const equal = raw.indexOf('=');
    const name = ALIASES.get(equal < 0 ? raw : raw.slice(0, equal)) ?? (equal < 0 ? raw : raw.slice(0, equal));
    if (BOOLEAN_FLAGS.has(name)) {
      if (equal >= 0) throw new InstallUsageError(`${name} does not take a value`);
      if (seen.has(name)) throw new InstallUsageError(`${name} may be given only once`);
      seen.add(name);
      if (name === '--dry-run') out.dryRun = true;
      if (name === '--help') out.help = true;
      if (name === '--version') out.version = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new InstallUsageError(`unknown option: ${name}`);
    if (seen.has(name)) throw new InstallUsageError(`${name} may be given only once`);
    seen.add(name);
    const value = equal >= 0 ? raw.slice(equal + 1) : argv[++i];
    if (value === undefined || value === '') throw new InstallUsageError(`${name} requires a value`);
    if (name === '--state-dir') { out.stateDir = resolve(String(value)); out.stateDirExplicit = true; }
    if (name === '--port') {
      if (!/^[0-9]+$/.test(String(value).trim())) throw new InstallUsageError('--port must be an integer');
      const n = Number.parseInt(String(value).trim(), 10);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new InstallUsageError('--port must be between 1 and 65535');
      out.port = n;
      out.portExplicit = true;
    }
  }
  if (out.stateDir === null) out.stateDir = resolve(join(home, DEFAULT_STATE_DIR_NAME));
  return out;
}

// -----------------------------------------------------------------------------
// Is there a daemon at this state directory?
// -----------------------------------------------------------------------------

/**
 * The port to probe first: the one recorded in <state-dir>/config.json, else the
 * built-in default. An explicit --port does NOT change where we look — the
 * question is which daemon owns this directory, and that is answered by the
 * directory's own record, not by what the operator typed.
 */
export function candidatePort(config) {
  const recorded = config && typeof config.port === 'number' && Number.isFinite(config.port) ? config.port : null;
  return recorded ?? INSTALL_DEFAULT_PORT;
}

/**
 * Classify one probe result against the target state directory.
 *
 *   present — an ours daemon answered and reports THIS state directory
 *   foreign — something answered, but it is not an ours daemon, or it is one
 *             owning a different state directory
 *   absent  — nothing answered
 *
 * `probe` is `{ ok: true, stateDir }` for a daemon that answered `/state-dir`,
 * or `{ ok: false, reason }` for no answer / non-JSON / HTTP error.
 */
export function classifyProbe(probe, targetStateDir) {
  if (!probe || probe.ok !== true) return { kind: 'absent', reason: probe?.reason ?? 'no answer' };
  if (typeof probe.stateDir !== 'string' || !probe.stateDir) {
    return { kind: 'foreign', reason: 'answered but did not report a state directory' };
  }
  if (!samePath(probe.stateDir, targetStateDir)) {
    return { kind: 'foreign', reason: 'daemon owns a different state directory', stateDir: resolve(probe.stateDir) };
  }
  return {
    kind: 'present',
    stateDir: resolve(probe.stateDir),
    daemonVersion: typeof probe.version === 'string' ? probe.version : null,
  };
}

/**
 * Find the daemon that owns this state directory, if any.
 *
 * Two lookups, in order, and the second is the one the spec did not have:
 *
 * 1. The port recorded in <state-dir>/config.json (else the default).
 * 2. **The port in <state-dir>/ours-cli-daemon.json.** DO NOT REMOVE THIS AS
 *    REDUNDANT. It exists because "the port RECORDED for a state directory" and
 *    "the port the daemon is ACTUALLY on" are two different things, and lookup 1
 *    only knows the first. Two ways they diverge, both real:
 *      - a daemon started by hand with OURS_PORT=3060 records nothing in
 *        config.json at all;
 *      - an operator edits config.json's port and does not restart, so the file
 *        says one thing and the running daemon another.
 *    In both cases lookup 1 misses and the caller would conclude "no daemon here"
 *    and create a SECOND daemon on the SAME state directory. There is no
 *    cross-process lock on a state directory, and two writers on one
 *    state_data.bin is a corruption case. So any daemon reporting this state
 *    directory on ANY port we can learn about counts as present — and a
 *    disagreeing --port is then refused against the port the daemon is really on,
 *    not against the stale one in the file.
 *
 * A PID record whose port does not answer is STALE, not present — reported as
 * such so the caller can say why it is creating a daemon.
 *
 * Injected IO: `probe(port)`, `readJson(path)`.
 */
/*
 * ASYNC, AND THAT IS AMENDING #56 TOO. The injected `probe` reaches a socket:
 * lib/effects.mjs implements it with fetch, so it returns a PROMISE. Called
 * synchronously, classifyProbe saw a Promise, found no `.ok` on it, and read
 * every daemon in the world as absent — so the real installer never detected an
 * existing daemon at all and took the create path every single time. The pure
 * tests could not see it, because a fake probe returns a plain object and a
 * plain object is exactly what synchronous code needs.
 *
 * Awaiting an injected function costs the purity of this module nothing: there
 * is still no I/O here, and `await` on a non-promise is the same value back, so
 * every existing fake keeps working unchanged.
 */
export async function findDaemon({ stateDir, probe, readJson, readText }) {
  const target = resolve(stateDir);
  const config = readJson(join(target, DAEMON_CONFIG));
  const recordedPort = config && typeof config.port === 'number' && Number.isFinite(config.port) ? config.port : null;
  const first = recordedPort ?? INSTALL_DEFAULT_PORT;
  // Did this directory TELL us that port, or did we guess it? The whole
  // treatment of a foreign answer turns on the difference.
  const guessed = recordedPort === null;
  const byConfig = classifyProbe(await probe(first), target);
  if (byConfig.kind === 'present') return { ...byConfig, port: first, via: 'config', config };
  if (byConfig.kind === 'foreign' && !guessed) return { ...byConfig, port: first, via: 'config', config };

  const records = readPidRecords(target, readJson, readText);
  const recorded = records.port;
  if (recorded !== null && recorded !== first) {
    const byRecord = classifyProbe(await probe(recorded), target);
    if (byRecord.kind === 'present') return { ...byRecord, port: recorded, via: 'pid-record', config };
    // A foreign daemon on the PID record's port says nothing about OUR daemon —
    // the record is simply stale. Do not refuse the run over it.
    return { kind: 'absent', reason: 'stale PID record', stalePidRecord: recorded, port: first, via: 'config', config };
  }
  // A FOREIGN DAEMON ON A PORT WE GUESSED IS NOT A REASON TO REFUSE.
  //
  // Regression guard. As first written, any foreign answer on the candidate port
  // refused the run. But a state directory with no recorded port has told us
  // nothing, so the candidate is the built-in default — which, on any machine
  // that already runs a daemon, is where the FIRST daemon answers. The result
  // was that a second daemon could never be created while the first was up:
  // coexistence was unreachable, and the refusal's own advice ("re-run with
  // --port for a free port") could not work either, because an explicit --port
  // deliberately does not change where we look.
  //
  // This is the same argument the stale-PID-record branch above already makes,
  // one layer over: an answer on a port we guessed says nothing about whether a
  // daemon owns THIS directory. A foreign answer on a port the directory
  // actually RECORDED still refuses, because there the operator's own file said
  // the daemon was there and something else is.
  // A bare pid record with no port still says a daemon OWNS this directory. It
  // cannot say where, so this is not "present" — but it is a reason to report a
  // stale record rather than silently create a second daemon beside it.
  if (records.pid !== null && byConfig.kind !== 'present') {
    return { kind: 'absent', reason: 'a daemon pid record exists but nothing answers', stalePidRecord: first, port: first, via: 'config', config };
  }
  if (byConfig.kind === 'foreign') {
    return {
      kind: 'absent',
      reason: 'another daemon holds the default port',
      port: first,
      via: 'config',
      config,
      defaultPortHeldBy: { port: first, stateDir: byConfig.stateDir ?? null },
    };
  }
  return { kind: 'absent', reason: byConfig.reason, port: first, via: 'config', config };
}

// -----------------------------------------------------------------------------
// Derived-port rule
// -----------------------------------------------------------------------------

/**
 * Decide what this run does about the daemon at `stateDir`. One of:
 *
 *   { action: 'update', port }   — a daemon already owns this directory
 *   { action: 'create', port }   — none does; this run creates one
 *   { action: 'refuse', exitCode: 2, reason, … } — write nothing
 *
 * Refusals, both following the SDK's precedent of refusing an incoherent
 * selection rather than silently correcting it:
 *
 *   - an explicit `--port` that disagrees with the port the existing daemon is
 *     actually on. Ignoring it would leave the operator believing they addressed
 *     the daemon on the port they typed while the run touched a different one.
 *   - something answering the candidate port that is not this directory's daemon.
 *
 * When creating: an explicit `--port` is used exactly as given and NEVER moved —
 * if it is occupied that is a refusal, not a reason to shift. Only a derived port
 * is searched, from 3050 upward, skipping the reserved defaults.
 */
export async function resolveTarget({ stateDir, port = null, portExplicit = false, probe, readJson, readText, isTaken }) {
  const target = resolve(stateDir);
  const found = await findDaemon({ stateDir: target, probe, readJson, readText });

  if (found.kind === 'foreign') {
    return {
      action: 'refuse',
      exitCode: 2,
      reason: 'foreign-daemon',
      port: found.port,
      stateDir: target,
      otherStateDir: found.stateDir ?? null,
      message: found.stateDir
        ? `port ${found.port} answers, but that daemon owns state directory ${found.stateDir}, not ${target}`
        : `port ${found.port} answers, but it is not an ours daemon`,
    };
  }

  if (found.kind === 'present') {
    if (portExplicit && port !== found.port) {
      return {
        action: 'refuse',
        exitCode: 2,
        reason: 'port-mismatch',
        port: found.port,
        stateDir: target,
        message: `--port ${port} disagrees with port ${found.port}, where the daemon for ${target} is actually running`,
      };
    }
    return {
      action: 'update',
      port: found.port,
      stateDir: target,
      config: found.config,
      daemonVersion: found.daemonVersion ?? null,
    };
  }

  // Creating. Only now is a port chosen.
  if (portExplicit) {
    if (isTaken(port)) {
      return {
        action: 'refuse',
        exitCode: 2,
        reason: 'port-occupied',
        port,
        stateDir: target,
        message: `port ${port} is already in use, and an explicit --port is never moved`,
      };
    }
    return {
      action: 'create',
      port,
      stateDir: target,
      stalePidRecord: found.stalePidRecord ?? null,
      defaultPortHeldBy: found.defaultPortHeldBy ?? null,
      // Purely informational: honoured as typed, but the operator should see it.
      reservedNotice: INSTALL_RESERVED_PORTS.includes(port) ? port : null,
    };
  }
  const free = searchFreePort(isTaken);
  if (free === null) {
    // Consistent with every other decision here: refuse an impossible selection
    // rather than widen the band, loop, or reuse a bound port.
    return {
      action: 'refuse',
      exitCode: 2,
      reason: 'no-free-port',
      port: null,
      stateDir: target,
      searched: { from: FREE_PORT_FLOOR, to: FREE_PORT_FLOOR + FREE_PORT_SPAN - 1 },
      message: `no free port between ${FREE_PORT_FLOOR} and ${FREE_PORT_FLOOR + FREE_PORT_SPAN - 1}; pass --port explicitly to name one`,
    };
  }
  return {
    action: 'create',
    port: free,
    stateDir: target,
    stalePidRecord: found.stalePidRecord ?? null,
    defaultPortHeldBy: found.defaultPortHeldBy ?? null,
    reservedNotice: null,
  };
}

/**
 * First free port from 3050 upward, skipping other components' defaults. Returns
 * null when the band is exhausted rather than looping or reusing a bound port —
 * the caller reports it.
 */
export function searchFreePort(isTaken, { floor = FREE_PORT_FLOOR, reserved = INSTALL_RESERVED_PORTS, span = FREE_PORT_SPAN } = {}) {
  for (let p = floor; p < floor + span; p += 1) {
    if (reserved.includes(p)) continue;
    if (!isTaken(p)) return p;
  }
  return null;
}

/** Explicit network operations never fall through to legacy Human provisioning. */
export function parseNetworkArgs(argv) {
  if (!['server', 'client'].includes(argv[0])) return null;
  const [role, operation] = argv;
  const operations = role === 'client' ? ['install'] : ['install', 'status', 'start', 'stop', 'restart', 'access-issue', 'access-replace', 'backup', 'restore', 'reset', 'update', 'rebuild'];
  if (!operations.includes(operation)) throw new InstallUsageError(`Unsupported ${role} operation: ${operation ?? '(missing)'}`);
  const allowed = role === 'client' ? ['config'] : ['state-dir'];
  if (role === 'server' && operation === 'install') allowed.push('mode', 'sources', 'migrate');
  if (operation === 'access-issue') allowed.push('output');
  if (['access-replace', 'reset'].includes(operation)) allowed.push('confirm');
  if (['restore', 'update'].includes(operation)) allowed.push('compatible');
  if (operation === 'update') allowed.push('sources');
  const result = { role, operation };
  let optionsStart = 2;
  if (['backup', 'restore', 'reset'].includes(operation)) {
    result.domain = argv[optionsStart++];
    if (!['server', 'daemon', 'telegram', 'cowork', 'messenger'].includes(result.domain)) throw new InstallUsageError('Select server, daemon, telegram, cowork or messenger');
    if (result.domain === 'server' && operation === 'reset') throw new InstallUsageError('Full-server reset is not supported');
    if (operation !== 'reset') {
      result.label = argv[optionsStart++];
      if (typeof result.label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result.label)) throw new InstallUsageError('Backup label must be a plain basename');
    }
  }
  const seen = new Set();
  for (let i = optionsStart; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match || !allowed.includes(match[1]) || seen.has(match[1])) throw new InstallUsageError(`Unexpected or repeated option: ${argv[i]}`);
    const [, name, inline] = match;
    seen.add(name);
    const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (['confirm', 'migrate', 'compatible'].includes(name)) {
      if (inline !== undefined) throw new InstallUsageError(`--${name} does not take a value`);
      result[key] = true;
    } else {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith('--')) throw new InstallUsageError(`--${name} requires a value`);
      result[key] = name === 'mode' ? value : resolve(value);
    }
  }
  const required = role === 'client' ? [] : ['stateDir'];
  if (operation === 'access-issue') required.push('output');
  if (['access-replace', 'reset'].includes(operation)) required.push('confirm');
  for (const key of required) if (!result[key]) throw new InstallUsageError(`${operation} requires --${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`);
  if (result.mode && !['packages', 'docker'].includes(result.mode)) throw new InstallUsageError('--mode must be packages or docker');
  return result;
}
