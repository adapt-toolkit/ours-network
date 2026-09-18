// ours-install v3 — the real side effects.
//
// Every mutation the installer can perform lives here and nowhere else, behind
// the same contract lib/orchestrate.mjs is tested against. Keeping them in one
// small file is the point: it is the only place to audit for "does this touch
// the machine", and it is what makes the fake used in the tests a faithful
// stand-in rather than an approximation.
//
// NOTE: nothing here runs systemctl. systemd is reached ONLY through
// `ours daemon install-service`, which owns the marker check, the baked
// state-directory guard and the enable/reload. The installer never touches a
// unit file or the service manager directly.

import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo, platform as osPlatform, release as osRelease, arch as osArch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { maintenanceServices, installationPaths, validateInstallation, consumerServiceState, unitNameForStateDir, launchdLabelForStateDir, messengerServicePlan, selectSourcePackages, resolveSourcePolicy, SERVER_SERVICES } from './plan.mjs';
import { validateHostProfile } from './target.mjs';
import { createServerOnboarding } from './server-onboarding.mjs';
import { atomicWriteConfig, snapshotConfig, restoreConfig } from './config.mjs';
import { askYesNo, askLine as askLineOnTty } from './prompt.mjs';
import { classifyHarnessProbe } from './logic.mjs';
import { classifyStateDir } from './detect.mjs';
import { BASE_RECORDS, CONTEXT, readBuildRecords, equalBuildRecords, initializeBuildMarker } from '../assets/scripts/maintenance/build-context.mjs';
import { releaseBinding, verifyReleaseGraph, verifyRuntimeRelease } from '../assets/scripts/maintenance/release-graph.mjs';

/** GET http://127.0.0.1:<port>/state-dir — the unauthenticated identity probe. */
async function probePort(port, { timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/state-dir`, { signal: controller.signal });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json();
    if (typeof body?.stateDir !== 'string') return { ok: false, reason: 'no stateDir in reply' };
    return {
      ok: true,
      stateDir: body.stateDir,
      version: typeof body.version === 'string' ? body.version : null,
      compat: Number.isInteger(body.compat) ? body.compat : null,
    };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timed out' : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is this port bound? Probed in a throwaway child so a bind attempt cannot leave
 * a listener behind in this process — the same technique the existing installer
 * uses (install.mjs portTakenSync).
 */
function portTakenSync(port) {
  const src = `const net=require('net');const s=net.createServer();s.once('error',e=>{process.exit(e.code==='EADDRINUSE'?3:0)});s.listen(${port},'127.0.0.1',()=>{s.close(()=>process.exit(0))});`;
  return spawnSync(process.execPath, ['-e', src], { stdio: 'ignore' }).status === 3;
}

function readJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function assertPrivateRegularFile(path, label) {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error(`Cannot read ${label} ${JSON.stringify(path)}.`); }
  if (!stat.isFile()) throw new Error(`Invalid external host profile: ${label} ${JSON.stringify(path)} must be a regular file.`);
  const currentUid = process.getuid?.();
  if (currentUid === undefined || stat.uid !== currentUid) throw new Error(`Invalid external host profile: ${label} ${JSON.stringify(path)} must be owned by the current user.`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Invalid external host profile: ${label} ${JSON.stringify(path)} must have private permissions.`);
}

function readHostProfileFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { throw new Error(`Cannot read host profile ${JSON.stringify(path)}.`); }
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid external host profile: config ${JSON.stringify(path)} is not valid JSON.`); }
  const profile = validateHostProfile(value);
  if (profile === null) return null;
  assertPrivateRegularFile(path, 'config');
  return profile;
}

async function verifyHostProfile(configPath, { timeoutMs = 5000 } = {}) {
  const profile = typeof configPath === 'string' ? readHostProfileFile(configPath) : validateHostProfile(configPath);
  if (profile === null) throw new Error(`Config ${JSON.stringify(configPath)} is not a host profile.`);
  const request = async (path, token = null) => {
    const response = await fetch(`${profile.endpoint}${path}`, {
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: token === null ? {} : { 'x-ours-api-token': token },
    });
    if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error(`${path} returned invalid JSON`); }
  };
  const selection = await request('/selection');
  const selectionKeys = selection && typeof selection === 'object' && !Array.isArray(selection) ? Object.keys(selection) : [];
  if (selectionKeys.length !== 3
    || selectionKeys.some((key) => !['schema', 'instanceId', 'capabilities'].includes(key))
    || selection.schema !== 1
    || selection.instanceId !== profile.expectedInstanceId
    || !Array.isArray(selection.capabilities)
    || selection.capabilities.some((capability) => typeof capability !== 'string')
    || !selection.capabilities.includes('external-sessions-v1')) {
    throw new Error('Daemon selection metadata is absent, incompatible or mismatched.');
  }
  assertPrivateRegularFile(profile.credentialPath, 'credential');
  const token = readFileSync(profile.credentialPath, 'utf8').trim();
  if (!token) throw new Error('Invalid external host profile: credential file is empty.');
  const version = await request('/version', token);
  return { profile, version };
}

function installedVersionOf(pkg, npmBin = 'npm') {
  try {
    const out = execFileSync(npmBin, ['ls', '-g', '--depth', '0', '--json', pkg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out)?.dependencies?.[pkg]?.version ?? null;
  } catch {
    // Unreadable is NOT "new enough": the cowork gate fails closed on null.
    return null;
  }
}

function packageDependenciesOf(pkgSpec, npmBin = 'npm') {
  const probe = capture(npmBin, ['view', pkgSpec, 'dependencies', '--json'], { timeout: 15_000 });
  if (!probe.ok) return null;
  try {
    const parsed = JSON.parse(probe.stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolvePackageVersion(pkg, channel, npmBin = 'npm') {
  const tag = channel === 'nightly' ? 'nightly' : 'latest';
  const probe = capture(npmBin, ['view', `${pkg}@${tag}`, 'version', '--json'], { timeout: 15_000 });
  if (!probe.ok) return '';
  try {
    const parsed = JSON.parse(probe.stdout);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return /^\S+$/.test(probe.stdout.trim()) ? probe.stdout.trim() : '';
  }
}

function codexMarketplace() {
  const probe = capture('codex', ['plugin', 'marketplace', 'list', '--json'], { timeout: 6_000 });
  if (!probe.ok) return null;
  try {
    return JSON.parse(probe.stdout)?.marketplaces?.find((m) => m?.name === 'ours-codex-marketplace') ?? null;
  } catch { return null; }
}

function hasClaudePlugin() {
  const probe = capture('claude', ['plugin', 'list', '--json'], { timeout: 6_000 });
  if (!probe.ok) return false;
  try { return JSON.parse(probe.stdout)?.some((p) => p?.id === 'ours@ours.network') ?? false; }
  catch { return false; }
}

/**
 * A read-only command probe that NEVER throws and NEVER inherits stdio.
 *
 * Separate from `run` on purpose. `run` is for mutations and throws on a
 * non-zero exit, because a failed mutation is news. Detection is the opposite:
 * a non-zero exit IS the answer, and a hung wrapper must be killed rather than
 * waited on. Mixing the two would mean either detection crashes a run or a
 * failed install passes silently.
 */
function capture(cmd, args, { timeout, env = process.env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], env });
  const timedOut = !!(r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'));
  return {
    ok: !r.error && r.status === 0,
    code: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut,
  };
}

// The two harnesses that are DRIVEN CLIs. The `name` is the one lib/extras.mjs
// plans against; the `command` is what actually lives on PATH.
export const DRIVEN_HARNESSES = [
  { name: 'claude-code', command: 'claude', label: 'Claude Code' },
  { name: 'codex', command: 'codex', label: 'Codex' },
];

/**
 * Alias-safety, unchanged from v2: three read-only observations, then the pure
 * classifier decides. The harness is NEVER called in a way that can hang —
 * `--version` is spawned directly (no shell, so a real PATH binary) under a hard
 * timeout, and the shell `type` lookup is timeout-guarded too.
 */
function detectDrivenHarness({ name, command, label }, env) {
  const onPath = capture('bash', ['-c', `command -v ${command}`], { env }).ok;
  const probe = capture(command, ['--version'], { timeout: 6000, env });
  const versionOk = probe.ok && /\d+\.\d+/.test(probe.stdout);
  const shell = env.SHELL || '/bin/bash';
  const typeProbe = capture(shell, ['-ic', `type -t ${command} 2>/dev/null`], { timeout: 4000, env });
  const verdict = classifyHarnessProbe({
    onPath, versionOk, timedOut: probe.timedOut, shellType: (typeProbe.stdout || '').trim(),
  });
  return { name, command, label, ...verdict };
}

/**
 * Hermes is detected DIFFERENTLY, and it is not an inconsistency. Its ours
 * plugin never calls a `hermes` binary — `ours-hermes-install` writes
 * ~/.hermes/config.yaml and the skills — so "can we drive it?" is the wrong
 * question. Per the plugin's own prerequisites, presence IS the config
 * directory. The CLI probe still runs, purely to enrich detection.
 */
function detectHermesHarness(env, home) {
  const dir = env.HERMES_DIR || join(home, '.hermes');
  const dirPresent = existsSync(dir);
  const cli = detectDrivenHarness({ name: 'hermes', command: 'hermes', label: 'Hermes' }, env);
  return {
    name: 'hermes',
    command: 'hermes',
    label: 'Hermes',
    status: dirPresent || cli.status === 'ok' ? 'ok' : 'absent',
    detail: dirPresent ? `config dir ${dir} present` : cli.detail,
  };
}

/**
 * Best-effort clipboard copy (pbcopy / wl-copy / xclip / clip.exe). The hard
 * timeout is load-bearing: xclip holds the selection and would otherwise keep
 * the installer alive after its own summary.
 */
function copyToClipboard(text) {
  const tools = [['pbcopy', []], ['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['clip.exe', []]];
  for (const [bin, args] of tools) {
    try {
      const r = spawnSync(bin, args, { input: text, timeout: 2000 });
      if (!r.error && (r.status === 0 || r.status == null)) return true;
    } catch { /* try the next one */ }
  }
  return false;
}

/**
 * Every DAEMON state directory on this machine.
 *
 * ONE DEFINITION OF WHAT A DAEMON IS, and this function is why that matters.
 *
 * It used to count any `~/.ours*` directory containing a config.json. Two of those
 * are not daemons on a perfectly normal machine: `~/.ours-telegram/config.json` is
 * the Telegram connector's and `~/.ours-cowork/config.json` is cowork's. So the
 * uninstaller reported "@ours.network/cli kept — still used by the daemon at
 * ~/.ours-telegram", and two things followed silently:
 *
 *   · planGlobalPackages kept cli, mcp and the plugin packages FOREVER on any
 *     machine with the connector installed, naming a connector's config directory
 *     as a daemon;
 *   · worse, planPluginRemoval's `lastDaemon` went false, so the whole harness
 *     plugin phase was skipped — with a reason that was not true. A plain
 *     interactive `ours-uninstall` on a machine with the connector removed no
 *     plugins at all.
 *
 * The selection screen had already closed exactly this: config.json is the one
 * piece of evidence that is AMBIGUOUS, so it cannot be the test. That predicate
 * lives in lib/detect.mjs and this now calls it rather than keeping a second,
 * naive copy that drifted. A daemon is identified by an artefact only a daemon
 * writes, or by a config whose SHAPE is a daemon's.
 *
 * Still deliberately conservative about WHERE it looks: only `~/.ours` and its
 * `~/.ours*` siblings. A state directory somewhere else is not found, and an
 * unreadable home means "there might be others", not "there are none" — because
 * the caller uses this to decide whether a GLOBAL package is still needed, and
 * being wrong the optimistic way uninstalls the CLI out from under a running
 * daemon.
 */
function knownStateDirsIn(home) {
  const found = [];
  const io = { exists: existsSync, readJson: readJsonFile };
  const consider = (dir) => { if (classifyStateDir(dir, io).isDaemon) found.push(dir); };
  consider(join(home, '.ours'));
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.ours') || entry.name === '.ours') continue;
      consider(join(home, entry.name));
    }
  } catch { /* an unreadable home is not evidence that there are no others */ }
  return found;
}

/**
 * Build the real effects. `write` and `ttyFd` come from the caller's UI layer so
 * the orchestrator never reaches for a terminal itself.
 */
export function realEffects({ write, ttyFd, env = process.env, home = homedir(), out, version = null } = {}) {
  const npmBin = env.OURS_NPM?.trim() || 'npm';
  let installationLockFd = null;
  const effects = {
    async withInstallationLock(root, operation) {
      const { tryLock } = await import('../assets/scripts/maintenance/state-native.mjs');
      if (installationLockFd !== null) throw new Error('Another installer operation is already active');
      ensurePrivateDirectory(root);
      const path = join(root, '.operation.lock');
      const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1) throw new Error('Unsafe installation lock');
        if (!tryLock(fd)) throw new Error('Another installer operation is already active');
        const current = lstatSync(path);
        if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('Installation lock changed during acquisition');
        installationLockFd = fd;
        return await operation();
      } finally {
        installationLockFd = null;
        // Keep the inode. Closing the last inherited descriptor releases flock.
        closeSync(fd);
      }
    },
    home,
    env,
    version,
    interactive: ttyFd != null,
    // Preflight reads the machine rather than asking the orchestrator to.
    platform: { platform: osPlatform(), release: osRelease(), arch: osArch() },
    nodeVersion: process.versions.node,
    exists: (path) => existsSync(path),
    knownStateDirs: () => knownStateDirsIn(home),
    // The only irreversible effect in this package, and the reason it takes no
    // pattern and no parent: the caller passes ONE resolved directory that the
    // pure planner already gated four ways, and this deletes exactly that.
    removeDir: (path) => { rmSync(resolve(path), { recursive: true, force: true }); },
    removeFile: (path) => { rmSync(resolve(path), { force: true }); },
    copyDir: (source, destination) => {
      mkdirSync(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
      cpSync(resolve(source), resolve(destination), {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    },
    // Rewrites a config file we do NOT own, so it keeps the file's own mode
    // rather than imposing 0600: tightening the permissions of somebody else's
    // ~/.codex/config.toml is a side effect nobody asked this to have.
    //
    // DO NOT "IMPROVE" THIS TO 0600. It looks like a security improvement, which
    // is exactly why someone will try — but this file is the operator's, not
    // ours, and the only thing we were invited to do to it is remove our own
    // block. Changing its mode on the way past is an uninvited change to a file
    // we happened to be holding, and a tool that does that once is a tool you
    // cannot let near your configs.
    writeText: (path, text) => {
      const mode = (() => { try { return statSync(path).mode & 0o777; } catch { return 0o644; } })();
      const temp = `${path}.tmp-${process.pid}`;
      writeFileSync(temp, text, { encoding: 'utf8', mode });
      renameSync(temp, path);
    },
    username: () => { try { return userInfo().username || 'me'; } catch { return 'me'; } },
    detectHarnesses: () => [
      ...DRIVEN_HARNESSES.map((h) => detectDrivenHarness(h, env)),
      detectHermesHarness(env, home),
    ],
    clipboard: (text) => copyToClipboard(text),
    brokerUrl: env.OURS_BROKER_URL ?? 'wss://broker1.ours.network',
    now: () => Date.now(),
    probe: (port) => probePort(port),
    isTaken: (port) => portTakenSync(port),
    readJson: readJsonFile,
    readProfile: readHostProfileFile,
    verifyHostProfile: (path) => verifyHostProfile(path),
    readText: readTextFile,
    writeJson: (path, text) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      atomicWriteConfig(path, text);
    },
    // The two halves of a config rollback (lib/journal.mjs). Deliberately the
    // SAME pair the nightly installer uses, from lib/config.mjs, rather than a
    // second implementation: `snapshot` records bytes and mode, and `restore`
    // either writes those bytes back at their original mode or DELETES a file
    // that did not exist before this run. Both are ordinary reads and writes of a
    // file this installer was already writing — no new class of side effect
    // enters the package here.
    snapshot: (path) => snapshotConfig(path),
    restore: (path, snapshot) => restoreConfig(path, snapshot),
    // `extraEnv` is the daemon pair (see daemonEnv). It is applied to THIS
    // invocation only and never to the installer's own process: a state
    // directory selected by one run must not leak into anything the operator
    // starts afterwards.
    run: async (cmd, args, { env: extraEnv = null, stream = false, cwd, sensitive = false, allowCodes = [] } = {}) => {
      // Always built from this layer's OWN env rather than left to spawnSync's
      // implicit inheritance, so what a child receives is a property of the
      // effects object a caller constructed and not of whatever ambient shell
      // the installer happened to start in.
      const childEnv = { ...env, ...(extraEnv ?? {}) };
      delete childEnv.OURS_INSTALLER_LOCK_FD;
      if (installationLockFd !== null) childEnv.OURS_INSTALLER_LOCK_FD = '3';
      const executable = cmd === 'npm' ? npmBin : cmd;
      const r = spawnSync(executable, args, {
        cwd,
        encoding: 'utf8',
        stdio: [...(stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe']), ...(installationLockFd === null ? [] : [installationLockFd])],
        env: childEnv,
      });
      if (r.error) {
        const error = new Error(`${executable} could not start (${r.error.code ?? 'launch error'})`, { cause: r.error });
        error.code = r.error.code;
        throw error;
      }
      if (r.status !== 0 && !allowCodes.includes(r.status)) {
        const detail = sensitive ? '' : (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('; ');
        throw new Error(`${executable} ${args.join(' ')} exited ${r.status}${detail ? `: ${detail}` : ''}`);
      }
      return { ok: true, code: r.status, stdout: r.stdout ?? '' };
    },
    // Commands with their own prompts, including Fleet's no-settings wizard,
    // must keep the user's terminal; piping their stdio would hang them waiting
    // on input nobody can type. Prepared Fleet settings use `run` above instead.
    // It is otherwise the same contract as `run` — including the environment,
    // so an interactive command reaches the same daemon a piped one would.
    runInteractive: async (cmd, args, { env: extraEnv = null } = {}) => {
      const childEnv = { ...env, ...(extraEnv ?? {}) };
      delete childEnv.OURS_INSTALLER_LOCK_FD;
      if (installationLockFd !== null) childEnv.OURS_INSTALLER_LOCK_FD = '3';
      const r = spawnSync(cmd, args, { stdio: ['inherit', 'inherit', 'inherit', ...(installationLockFd === null ? [] : [installationLockFd])], env: childEnv });
      return { ok: !r.error && r.status === 0, code: r.status ?? -1 };
    },
    installedVersion: (pkg) => installedVersionOf(pkg, npmBin),
    packageDependencies: (spec) => packageDependenciesOf(spec, npmBin),
    resolvePackageVersion: (pkg, channel) => resolvePackageVersion(pkg, channel, npmBin),
    codexMarketplace,
    hasClaudePlugin,
    out: out ?? ((line) => process.stdout.write(`${line}\n`)),
    // Never called when assumeYes: the orchestrator takes the default itself.
    ask: async (prompt, def = false) => (ttyFd == null ? def : askYesNo(write, ttyFd, `  ${prompt}  `, def)),
    askLine: async (prompt, def = '') => (ttyFd == null ? def : askLineOnTty(write, ttyFd, `  ${prompt}  `, def)),
  };
  return Object.assign(effects, networkEffects(effects));
}

export const __testables = { probePort, portTakenSync, readJsonFile, readTextFile, readHostProfileFile, verifyHostProfile, installedVersionOf, packageDependenciesOf, resolvePackageVersion, codexMarketplace, hasClaudePlugin, knownStateDirsIn };

// -----------------------------------------------------------------------------
// THE PAIR
// -----------------------------------------------------------------------------

/**
 * The environment that names ONE daemon, for a single child invocation.
 *
 * A state directory and its endpoint always travel
 * together; "endpoint selected, state directory defaulted" must be unreachable.
 * Every consumer downstream — ours-mcp's proxy, ours-fleet's per-role resolver,
 * ours-hermes-install — reads these three names and falls back to `~/.ours` for
 * whichever one is missing. So a HALF pair does not fail: it silently attaches
 * to the default daemon while the operator was told a different one was chosen.
 *
 * That is why this is a function and not three assignments at the call sites.
 * There is exactly one place a daemon environment can be built, it takes both
 * halves as arguments, and it refuses rather than emit a partial one.
 *
 * The three names, not two, are deliberate: OURS_CONFIG alone would leave the
 * port to whatever config.json happens to say, which is exactly the stale-file
 * divergence lib/target.mjs's second lookup exists to survive.
 */
export const DAEMON_ENV_KEYS = ['OURS_CONFIG', 'OURS_STATE_DIR', 'OURS_PORT'];

export function daemonEnv(stateDir, port) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (!dir) throw new Error('daemonEnv requires a state directory: refusing to build half of the daemon pair');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('daemonEnv requires a port between 1 and 65535: refusing to build half of the daemon pair');
  }
  const resolved = resolve(dir);
  return {
    OURS_CONFIG: join(resolved, 'config.json'),
    OURS_STATE_DIR: resolved,
    OURS_PORT: String(port),
  };
}

/** Is this environment a whole pair (or nothing at all)? Never one half. */
export function isWholeDaemonEnv(env) {
  if (env == null) return true;
  const present = DAEMON_ENV_KEYS.filter((k) => typeof env[k] === 'string' && env[k] !== '');
  if (present.length === 0) return true;
  if (present.length !== DAEMON_ENV_KEYS.length) return false;
  return env.OURS_CONFIG === join(resolve(env.OURS_STATE_DIR), 'config.json');
}

/** The state directory a default run targets, for callers that need it early. */
export const defaultStateDir = (home = homedir()) => join(home, '.ours');

export const INSTALLER_ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));
const PACKAGED_SOURCE_POLICY = join(INSTALLER_ASSETS, 'sources.json');

function privateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error(`Unsafe private installation directory: ${path}`);
}

function ensurePrivateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  privateDirectory(path);
}

function writePrivateNew(path, body) {
  writeFileSync(path, body, { mode: 0o600, flag: 'wx' });
  assertPrivateRegularFile(path, 'installation file');
}

/** Runtime IO remains in the installer effects seam. No host runtime on clients. */
export function networkEffects(effects) {
  const { env, home } = effects;
  const buildRuntime = record => {
    if (!record.buildTransition || existsSync(record.workDir)) return record;
    const workDir = join(record.buildTransition.candidate.root, 'previous-runtime');
    privateDirectory(workDir);
    return { ...record, workDir };
  };
  const baseEnv = (record) => ({
    OURS_DAEMON_ID: record.instanceId,
    OURS_IMAGE: `${record.project}:runtime`,
    OURS_MAINTENANCE_IMAGE: `${record.project}:maintenance`,
    OURS_UID: String(record.uid ?? 1000), OURS_GID: String(record.gid ?? 1000),
    OURS_HOST_PORT: String(record.port ?? 3050),
    OURS_COWORK_PORT: String(record.coworkPort ?? 3052),
    OURS_MESSENGER_PORT: String(record.messengerPort ?? 8420),
    OURS_MESSENGER_IDENTITY: record.messengerIdentity ?? '',
  });
  const composeArgs = (record, args) => [
    'compose', '--project-directory', record.workDir, '--file', join(record.workDir,
      record.schema === 1 && existsSync(join(record.workDir, 'docker-compose.legacy.yaml'))
        ? 'docker-compose.legacy.yaml' : 'docker-compose.yaml'),
    '--project-name', record.project, ...args,
  ];
  const compose = (record, args, options = {}) => effects.run('docker', composeArgs(record, args),
    { ...options, env: { ...baseEnv(record), ...options.env } });
  const dockerStartupError = async (record, service, cause) => {
    const args = ['logs', '--no-color', '--tail', '50', '--timestamps', service];
    const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
    const command = `OURS_DAEMON_ID=${quote(record.instanceId)} docker ${composeArgs(record, args).map(quote).join(' ')}`;
    let detail;
    try {
      const logs = await compose(record, args);
      // Limit terminal diagnostics; container output must not inject terminal controls.
      detail = (logs.stdout ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(-6000);
      detail = detail ? `Recent ${service} logs:\n${detail}` : 'The container produced no readable logs.';
    } catch {
      detail = 'Container logs could not be read.';
    }
    return new Error(`Docker service "${service}" failed to start or become healthy.\n${detail}\nStartup error: ${cause.message}\nInspect logs: ${command}`, { cause });
  };
  const bin = (record, name) => join(record.workDir, 'node_modules', '.bin', name);
  const localEnv = (record, service = 'daemon') => {
    const paths = installationPaths(record);
    const state = paths[service];
    const credentialPath = paths.credentials[service];
    const common = { OURS_DAEMON_ID: record.instanceId, OURS_DAEMON_URL: `http://127.0.0.1:${record.port}`, OURS_DAEMON_CREDENTIAL_PATH: credentialPath };
    if (service === 'daemon') return { OURS_CONFIG: record.configPath, OURS_STATE_DIR: state, OURS_PORT: String(record.port), OURS_DAEMON_ID: record.instanceId };
    if (service === 'telegram') return { OURS_TG_CONFIG: join(state, 'config.json'), OURS_TG_STATE_DIR: state, OURS_TG_CONTROL_PORT: '3051', OURS_TG_DAEMON_URL: common.OURS_DAEMON_URL, OURS_TG_DAEMON_ID: record.instanceId, OURS_TG_DAEMON_CREDENTIAL_PATH: credentialPath };
    if (service === 'cowork') return { ...common, OURS_COWORK_CONFIG: join(state, 'config.json'), OURS_COWORK_STATE_DIR: state, OURS_COWORK_REST_PORT: String(record.coworkPort) };
    return { ...common, OURS_MESSENGER_STATE_DIR: state, ...(record.messengerIdentity ? { OURS_MESSENGER_IDENTITY: record.messengerIdentity } : {}), OURS_MESSENGER_PORT: String(record.messengerPort), OURS_MESSENGER_HOST: '127.0.0.1', OURS_MESSENGER_PUBLIC_ORIGIN: `http://127.0.0.1:${record.messengerPort}` };
  };
  const ownerCommand = (record, service, op, options = {}) => {
    const name = { daemon: 'ours', telegram: 'ours-tg-connector', cowork: 'ours-cowork' }[service];
    const args = service === 'daemon' ? ['daemon', op, ...(['install-service', 'uninstall-service'].includes(op) ? ['--yes'] : []), '--config', record.configPath, '--state-dir', installationPaths(record).daemon, '--json'] : [op];
    return effects.run(bin(record, name), args, { ...options, env: localEnv(record, service) });
  };
  const requireCleanContainerExit = async (record, selected) => {
    const containers = await compose(record, ['ps', '-aq', ...selected]);
    for (const id of containers.stdout.split(/\s+/).filter(Boolean)) {
      const result = await effects.run('docker', ['inspect', '--format', '{{json .State}}', id]);
      const state = JSON.parse(result.stdout);
      if (state.Status !== 'exited' || state.ExitCode !== 0 || state.OOMKilled !== false || state.Dead !== false) {
        throw new Error('Selected source container did not stop cleanly; state operation refused');
      }
    }
  };
  return {
    ...createServerOnboarding(effects, { compose, localEnv, bin }),
    sourcePolicyHash(path) {
      return createHash('sha256').update(readFileSync(path)).digest('hex');
    },
    packagedSourcePolicy() {
      const policy = JSON.parse(readFileSync(PACKAGED_SOURCE_POLICY, 'utf8'));
      const release = releaseBinding(policy);
      if (release) {
        const embedded = JSON.parse(readFileSync(join(INSTALLER_ASSETS, 'release.json'), 'utf8'));
        if (JSON.stringify(release) !== JSON.stringify(embedded)) throw new Error('Packaged source policy differs from immutable release');
      } else if (Object.values(policy.packages ?? {}).some(p => p.type === 'npm')) {
        throw new Error('Packaged npm source policy is missing its release binding');
      }
      return policy;
    },
    async resolveSourcePolicy(policy, role, clients = []) {
      return resolveSourcePolicy(policy, role, clients, async (name, range) => {
        const result = await effects.run('npm', ['view', `${name}@${range}`, 'version', '--json']);
        let versions;
        try { versions = JSON.parse(result.stdout); }
        catch { throw new Error(`npm returned malformed version metadata for ${name}@${range}`); }
        const version = Array.isArray(versions) ? versions.at(-1) : versions;
        if (typeof version !== 'string') throw new Error(`npm did not resolve ${name}@${range}`);
        return version;
      });
    },
    newInstallation(root, mode) {
      if (existsSync(root)) {
        privateDirectory(root);
        if (readdirSync(root).some(name => name !== '.operation.lock')) throw new Error('Installation root is not empty and has no selection record');
      }
      const instanceId = env.OURS_DAEMON_ID || randomUUID();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(instanceId)) throw new Error('OURS_DAEMON_ID must be a lowercase UUID');
      const project = `ours-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
      return { schema: 2, root, mode, instanceId, project, workDir: join(root, 'runtime'), configPath: installationPaths({ schema: 2, root }).config, sourcesPath: join(root, 'sources.json'), services: [...SERVER_SERVICES], port: 3050, coworkPort: 3052, messengerPort: 8420, messengerIdentity: env.OURS_MESSENGER_IDENTITY || null, uid: 1000, gid: 1000 };
    },
    async serverPreflight(record, operation, { existing, sourcePath = record.sourcesPath, sourceManifest } = {}) {
      if (existing) {
        privateDirectory(record.root);
        assertPrivateRegularFile(join(record.root, 'installation.json'), 'selection');
        assertPrivateRegularFile(record.sourcesPath, 'sources');
        if (env.OURS_DAEMON_ID && env.OURS_DAEMON_ID !== record.instanceId) throw new Error('Conflicting instance ID');
      }
      if (record.mode === 'docker') {
        const nativeRoot = existing ? '/path/to/new-empty-directory' : record.root;
        const quotedRoot = `'${String(nativeRoot).replaceAll("'", "'\\''")}'`;
        const recovery = [
          'Please install Docker Desktop on macOS/Windows, or Docker Engine with the Compose plugin on Linux, and start Docker before retrying.',
          'Docker is recommended for macOS and Windows.',
          `Alternatively, use native installation: ours-install server install --mode packages --state-dir ${quotedRoot}`,
          'Native mode requires systemd user services on Linux/WSL or a launchd GUI session on macOS.',
          ...(existing ? ['Keep this existing Docker installation in Docker mode; use a separate empty directory for a new native installation.'] : []),
        ].join('\n');
        try {
          await effects.run('docker', ['info', '--format', '{{.ServerVersion}}']);
        } catch (cause) {
          const problem = cause.code === 'ENOENT'
            ? 'Docker command was not found in PATH.'
            : `Docker Engine is not reachable. Start Docker and check that your user can access it.\nDetails: ${cause.message}`;
          throw new Error(`${problem}\n${recovery}`, { cause });
        }
        let version;
        try {
          version = await effects.run('docker', ['compose', 'version', '--short']);
        } catch (cause) {
          throw new Error(`Docker Compose 2.35 or newer is required, but the Compose plugin could not run. Update Docker Desktop or install the Docker Compose plugin.\n${recovery}`, { cause });
        }
        const match = /^v?(\d+)\.(\d+)/.exec(version.stdout.trim());
        if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 35)) {
          throw new Error(`Docker Compose 2.35 or newer is required. Update Docker Desktop or the Docker Compose plugin.\n${recovery}`);
        }
        if (operation !== 'status') {
          // Compose clients can disappear while their Engine-owned command continues.
          const active = await effects.run('docker', ['ps', '--filter', `label=com.docker.compose.project=${record.project}`, '--filter', 'label=com.docker.compose.oneoff=True', '--format', '{{.ID}}']);
          if (active.stdout.trim()) throw new Error('Another server installation operation is still running in Docker');
        }
      } else {
        if (!['linux', 'darwin'].includes(effects.platform.platform)) throw new Error('Package mode requires systemd-user or launchd');
        await effects.run(effects.platform.platform === 'linux' ? 'systemctl' : 'launchctl', effects.platform.platform === 'linux' ? ['--user', 'show-environment'] : ['print', `gui/${process.getuid()}`]);
        if (operation === 'install') {
          for (const command of ['node', 'npm']) await effects.run(command, ['--version']);
          const packages = selectSourcePackages(sourceManifest ?? effects.readJson(existing ? record.sourcesPath : sourcePath), 'server');
          if (Object.values(packages).some(selection => selection.source)) {
            // Native dependencies in source builds still use their own toolchains.
            for (const command of ['python3', 'git', 'make', 'cc']) await effects.run(command, ['--version']);
          }
        }
      }
    },
    async initializeSelection(record, manifest) {
      if (typeof manifest === 'string') manifest = JSON.parse(readFileSync(manifest, 'utf8'));
      selectSourcePackages(manifest, 'server');
      const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      ensurePrivateDirectory(record.root);
      if (record.schema === 2) {
        for (const path of [join(record.root, 'storage'), installationPaths(record).state, installationPaths(record).daemon]) ensurePrivateDirectory(path);
      }
      writePrivateNew(record.sourcesPath, bytes);
      writePrivateNew(record.configPath, JSON.stringify({ stateDir: record.mode === 'docker' ? '/var/lib/ours' : installationPaths(record).daemon, port: record.port, apiVisibility: 'owner' }, null, 2) + '\n');
    },
    async prepareInstallation(record, { runtimeOnly = false } = {}) {
      let copied = false;
      if (!existsSync(record.workDir)) {
        cpSync(INSTALLER_ASSETS, record.workDir, { recursive: true, errorOnExist: true, force: false });
        chmodSync(record.workDir, 0o700);
        copied = true;
      }
      const retained = readFileSync(record.sourcesPath);
      const materialized = join(record.workDir, 'sources.json');
      if (copied) rmSync(materialized);
      if (!existsSync(materialized)) writePrivateNew(materialized, retained);
      else if (!readFileSync(materialized).equals(retained)) throw new Error('Materialized sources differ from retained selection');
      if (record.mode === 'docker') {
        // The installer owns these dependencies in both installation modes.
        const { dependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        writeFileSync(join(record.workDir, 'scripts/maintenance/package.json'), JSON.stringify({ private: true, type: 'module', dependencies }, null, 2) + '\n', { mode: 0o600 });
        const image = await effects.run('docker', ['image', 'inspect', `${record.project}:runtime`], { allowCodes: [1] });
        if (image.code !== 0) await compose(record, ['build', 'daemon'], { stream: true, env: { BUILDKIT_PROGRESS: 'plain' } });
        if (runtimeOnly) return;
        await compose(record, ['run', '--rm', '--no-deps', '-T', 'prepare', 'prepare']);
      } else {
        if (!existsSync(join(record.workDir, '.packages-ready'))) {
          const sourceRoot = join(record.root, `build-${randomUUID()}`);
          ensurePrivateDirectory(sourceRoot);
          try {
            await effects.run(process.execPath, [join(record.workDir, 'scripts/build/build.mjs')], { stream: true, cwd: record.workDir, env: { OURS_BUILD_ROOT: record.workDir, OURS_SOURCE_ROOT: sourceRoot } });
            await effects.run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { stream: true, cwd: record.workDir });
            await effects.run(process.execPath, [join(record.workDir, 'scripts/build/record-build.mjs')], { cwd: record.workDir, env: { OURS_BUILD_ROOT: record.workDir } });
            writePrivateNew(join(record.workDir, '.packages-ready'), 'ready\n');
          } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
        }
        await effects.recordRuntimeBuild(record);
        if (runtimeOnly) return;
        const paths = installationPaths(record);
        ensurePrivateDirectory(join(paths.state, 'credentials'));
        for (const dir of [paths.daemon, paths.telegram, paths.cowork, paths.messenger, paths.mcp,
          ...Object.values(paths.credentials).map(path => dirname(path))]) ensurePrivateDirectory(dir);
        const profilePath = join(installationPaths(record).mcp, 'profile.json');
        if (!existsSync(profilePath)) writePrivateNew(profilePath, JSON.stringify({ endpoint: `http://127.0.0.1:${record.port}`, expectedInstanceId: record.instanceId, credentialPath: join(installationPaths(record).daemon, 'daemon-token') }));
        const config = JSON.parse(readFileSync(record.configPath, 'utf8'));
        config.networkMcp ??= { profile: { endpoint: `http://127.0.0.1:${record.port}`, expectedInstanceId: record.instanceId, credentialPath: join(installationPaths(record).daemon, 'daemon-token') }, applicationConfigPath: join(installationPaths(record).mcp, 'config.json') };
        effects.writeJson(record.configPath, JSON.stringify(config, null, 2) + '\n');
        const cowork = join(installationPaths(record).cowork, 'config.json');
        if (!existsSync(cowork)) writePrivateNew(cowork, JSON.stringify({ version: 1, stateDir: installationPaths(record).cowork, rest: { enabled: true, host: '127.0.0.1', port: record.coworkPort } }));
      }
    },
    async prepareServerBuild(record, args) {
      validateInstallation(record, record.root);
      if (record.schema !== 2 || record.layoutConversion || !['update', 'rebuild'].includes(args.operation)) {
        throw new Error('Select a converted installation for update or rebuild');
      }
      const sources = args.operation === 'update'
        ? (args.resolvedSources
          ? Buffer.from(`${JSON.stringify(args.resolvedSources, null, 2)}\n`)
          : readFileSync(args.sources))
        : readFileSync(record.sourcesPath);
      selectSourcePackages(JSON.parse(sources), 'server');
      privateDirectory(record.root);
      const root = mkdtempSync(join(record.root, '.build-'));
      const candidate = { ...record, root, workDir: join(root, 'runtime'), sourcesPath: join(root, 'sources.json'),
        configPath: installationPaths({ schema: 2, root }).config,
        project: `ours-build${randomUUID().replaceAll('-', '')}`,
        sourcePolicyHash: args.sources ? effects.sourcePolicyHash(args.sources) : undefined };
      try {
        writePrivateNew(candidate.sourcesPath, sources);
        await effects.prepareInstallation(candidate, { runtimeOnly: true });
        if (candidate.mode === 'docker') {
          await compose(candidate, ['build', 'state-operation']);
          await effects.copyDockerBuildRecords(candidate, candidate.workDir);
        }
        // npm emits readable build records; maintenance consumes private copies.
        for (const file of [...BASE_RECORDS, ...(existsSync(join(candidate.workDir, CONTEXT)) ? [CONTEXT] : [])]) {
          const path = join(candidate.workDir, file), stat = lstatSync(path);
          if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o7002)) {
            throw new Error('Unsafe candidate build record');
          }
          JSON.parse(readFileSync(path, 'utf8'));
          chmodSync(path, 0o600);
        }
        readBuildRecords(candidate.workDir, { privateFiles: true });
        return candidate;
      } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
      }
    },
    async copyDockerBuildRecords(record, directory) {
      // Inspect immutable image metadata; never reinterpret a failed context copy as legacy.
      const label = (await effects.run('docker', ['image', 'inspect', '--format', '{{ index .Config.Labels "network.ours.build-context" }}', `${record.project}:runtime`])).stdout.trim();
      if (!['', '<no value>', '1'].includes(label)) throw new Error('Unsupported image build-context schema');
      const names = [...BASE_RECORDS, ...(label === '1' ? [CONTEXT] : [])];
      const stage = mkdtempSync(join(directory, '.records-'));
      const name = `${record.project}-records`;
      let created = false;
      try {
        await effects.run('docker', ['create', '--name', name, '--entrypoint', '/bin/true', `${record.project}:runtime`]);
        created = true;
        for (const file of names) {
          await effects.run('docker', ['cp', `${name}:/opt/ours/${file}`, join(stage, file)]);
          const st = lstatSync(join(stage, file));
          if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o7002)) throw new Error('Unsafe copied build record');
          chmodSync(join(stage, file), 0o600);
        }
        readBuildRecords(stage, { privateFiles: true });
        // Destination is unpublished candidate storage; any copy error aborts activation.
        for (const file of names) renameSync(join(stage, file), join(directory, file));
        if (label !== '1' && existsSync(join(directory, CONTEXT))) throw new Error('Legacy image conflicts with retained build context');
      } finally {
        try { if (created) await effects.run('docker', ['rm', name]); }
        finally { rmSync(stage, { recursive: true, force: true }); }
      }
    },
    async checkServerBuild(record, candidate, compatible, operation = 'update') {
      const sameSources = readFileSync(record.sourcesPath).equals(readFileSync(candidate.sourcesPath));
      if (operation === 'rebuild' && !sameSources) throw new Error('Rebuild must retain the selected sources');
      if (!sameSources && operation !== 'rebuild' && !compatible) throw new Error('Changed sources require reviewed storage compatibility (--compatible)');
      let current = record.workDir;
      if (record.mode === 'docker') {
        current = join(candidate.root, 'previous-build');
        ensurePrivateDirectory(current);
        await effects.copyDockerBuildRecords(record, current);
      }
      const currentRecords = readBuildRecords(current), candidateRecords = readBuildRecords(candidate.workDir);
      if (compatible && operation !== 'rebuild') return;
      if (!equalBuildRecords(currentRecords, candidateRecords)) {
        throw new Error('Different build or missing verified context requires reviewed storage compatibility; use server update with --compatible');
      }
    },
    async serverBuildTransition(record, args) {
      const { serverBuildTransition } = await import('./build-transition.mjs');
      return serverBuildTransition(record, args, effects);
    },
    async retireServerBuildRuntime(record) {
      const selected = buildRuntime(record);
      if (record.mode === 'docker') {
        await effects.serverLifecycle(selected, 'stop');
        await requireCleanContainerExit(selected, record.services);
        await compose(selected, ['rm', '-f', ...record.services]);
      } else await nativeLifecycle(selected, 'retire', record.services, { effects, localEnv, ownerCommand, bin });
    },
    async updateServerBuildState(record, candidate, compatible, operation = 'update') {
      const command = [operation, 'server', ...(compatible ? ['--compatible'] : [])];
      if (record.mode === 'docker') {
        await compose({ ...record, workDir: candidate.workDir }, ['run', '--rm', '--no-deps', '-T', 'state-operation', ...command], {
          env: { OURS_MAINTENANCE_IMAGE: `${candidate.project}:maintenance`, OURS_STATE_DOMAIN: 'server', OURS_LIVE_ROOT: '/storage/state' },
        });
      } else {
        const paths = installationPaths(record);
        await effects.run(process.execPath, [join(INSTALLER_ASSETS, 'scripts/maintenance/state-operation.mjs'), ...command], {
          env: { ...localEnv(record), OURS_STATE_DOMAIN: 'server', OURS_STATE_ROOT: join(record.root, 'storage'),
            OURS_LIVE_ROOT: paths.state, OURS_BUILD_ROOT: candidate.workDir,
            OURS_COWORK_CLI_PATH: bin(record, 'ours-cowork'), OURS_COWORK_CONFIG: join(paths.cowork, 'config.json'),
            OURS_COWORK_STATE_DIR: paths.cowork },
        });
      }
    },
    async publishServerBuild(record, candidate) {
      const previous = join(candidate.root, 'previous-runtime');
      if (record.mode === 'docker') {
        for (const target of ['runtime', 'maintenance']) {
          const retained = `${candidate.project}:previous-${target}`;
          const found = await effects.run('docker', ['image', 'inspect', retained], { allowCodes: [1] });
          if (found.code !== 0) {
            const current = await effects.run('docker', ['image', 'inspect', `${record.project}:${target}`], { allowCodes: [1] });
            if (current.code === 0) await effects.run('docker', ['tag', `${record.project}:${target}`, retained]);
          }
        }
      }
      if (!existsSync(previous)) {
        privateDirectory(record.workDir);
        privateDirectory(candidate.workDir);
        renameSync(record.workDir, previous);
      }
      privateDirectory(previous);
      if (existsSync(candidate.workDir)) {
        if (existsSync(record.workDir)) throw new Error('Both candidate and active runtimes exist after retaining the previous build');
        privateDirectory(candidate.workDir);
        renameSync(candidate.workDir, record.workDir);
      } else privateDirectory(record.workDir);
      if (record.mode === 'docker') {
        for (const target of ['runtime', 'maintenance']) {
          await effects.run('docker', ['tag', `${candidate.project}:${target}`, `${record.project}:${target}`]);
        }
      }
      atomicWriteConfig(record.sourcesPath, readFileSync(candidate.sourcesPath));
    },
    async validateServerBuildState(record) {
      if (record.mode === 'docker') {
        return effects.runDockerConversion(record, { target: `${record.project}_server-storage` }, 'validate');
      }
      const { validateConvertedPackageState } = await import('./layout-conversion.mjs');
      validateConvertedPackageState(record);
    },
    async discardServerBuild(candidate) {
      if (candidate.mode === 'docker') {
        for (const target of ['runtime', 'maintenance', 'previous-runtime', 'previous-maintenance']) {
          const image = `${candidate.project}:${target}`;
          const found = await effects.run('docker', ['image', 'inspect', image], { allowCodes: [1] });
          if (found.code === 0) await effects.run('docker', ['image', 'rm', image]);
        }
      }
      privateDirectory(candidate.root);
      rmSync(candidate.root, { recursive: true });
    },
    async serverAccess(record, operation, { output, migrate = false } = {}) {
      if (record.mode === 'docker') {
        if (!output) return compose(record, ['run', '--rm', '--no-deps', '-T', 'access', operation], { sensitive: true, env: { OURS_ACCESS_MIGRATE: migrate ? '1' : '0' } });
        privateDirectory(dirname(output));
        if (existsSync(output)) throw new Error('Credential output already exists');
        const name = `${record.project}-issue-${randomUUID()}`;
        const issuedPath = `/var/lib/ours/.issued-${randomUUID()}`;
        const staging = join(dirname(output), `.ours-issued-${randomUUID()}`);
        ensurePrivateDirectory(staging);
        try {
          await compose(record, ['run', '--name', name, '--no-deps', '-T', 'access', 'access-issue', issuedPath], { sensitive: true });
          const file = join(staging, 'credential');
          await effects.run('docker', ['cp', `${name}:${issuedPath}`, file], { sensitive: true });
          assertPrivateRegularFile(file, 'issued credential');
          // Exclusive publication never overwrites an unrelated credential.
          writePrivateNew(output, readFileSync(file));
        } finally {
          await compose(record, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'rm', 'access', '-f', issuedPath], { sensitive: true });
          await effects.run('docker', ['rm', '-f', name], { sensitive: true });
          rmSync(staging, { recursive: true, force: true });
        }
        return;
      }
      const options = { env: localEnv(record), sensitive: true };
      if (operation !== 'access-issue') return effects.run(bin(record, 'ours'), ['config', operation, '--config', record.configPath, ...(operation === 'access-replace' ? ['--confirm'] : migrate ? ['--migrate'] : []), '--json'], options);
      const outputs = output ? [output] : [join(installationPaths(record).daemon, 'daemon-token'), ...['telegram', 'cowork', 'messenger'].map(s => installationPaths(record).credentials[s])];
      for (const path of outputs) await effects.run(bin(record, 'ours'), ['config', operation, '--config', record.configPath, '--output', path, ...(output ? [] : ['--replace']), '--json'], options);
    },
    async recordRuntimeBuild(record) {
      if (record.mode === 'docker') return; // Image preparation records its build.
      verifyRuntimeRelease(record.workDir);
      const tree = join(record.workDir, 'dependency-tree.json');
      if (!existsSync(tree)) {
        const result = await effects.run('npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: record.workDir });
        JSON.parse(result.stdout);
        writePrivateNew(tree, result.stdout);
      }
    },
    async recordInstallationBuild(record) {
      if (record.mode === 'docker') return;
      await effects.recordRuntimeBuild(record);
      const paths = installationPaths(record);
      const records = readBuildRecords(record.workDir);
      for (const service of SERVER_SERVICES) {
        const marker = join(paths[service], '.ours-provenance');
        initializeBuildMarker(marker, records);
      }
    },
    async serverMaintenance(record, args) {
      if (record.schema !== 2 || record.layoutConversion) throw new Error('Finish managed layout conversion before maintenance');
      if (!['server', 'daemon', 'telegram', 'cowork', 'messenger'].includes(args.domain) || !['backup', 'restore', 'reset'].includes(args.operation) || (args.domain === 'server' && args.operation === 'reset')) {
        throw new Error('Addressed shared-state maintenance is not yet available');
      }
      const selected = maintenanceServices(record, args.domain);
      if (!selected.length) throw new Error('Selected component is not part of this installation');
      const running = await effects.serverLifecycle(record, 'status', selected);
      await effects.serverLifecycle(record, 'stop', selected);
      const command = [args.operation, args.domain, ...(args.operation === 'reset' ? ['--confirm'] : [args.label]), ...(args.compatible ? ['--compatible'] : [])];
      if (record.mode === 'docker') {
        await requireCleanContainerExit(record, selected);
        // Parent replacement invalidates every retained subpath mount.
        if (['restore', 'reset'].includes(args.operation)) await compose(record, ['rm', '-f', ...selected]);
        await compose(record, ['run', '--rm', '--no-deps', '-T', 'state-operation', ...command], {
          env: { OURS_STATE_DOMAIN: args.domain, OURS_LIVE_ROOT: ['server', 'daemon'].includes(args.domain) ? '/storage/state' : `/storage/state/${args.domain}` },
        });
      } else {
        const paths = installationPaths(record);
        await effects.run(process.execPath, [join(INSTALLER_ASSETS, 'scripts/maintenance/state-operation.mjs'), ...command], {
          env: { ...localEnv(record), OURS_STATE_DOMAIN: args.domain,
            OURS_STATE_ROOT: join(record.root, 'storage'), OURS_LIVE_ROOT: ['server', 'daemon'].includes(args.domain) ? paths.state : paths[args.domain],
            OURS_BUILD_ROOT: record.workDir, OURS_CLI_PATH: bin(record, 'ours'),
            OURS_DAEMON_CONFIG: record.configPath, OURS_COWORK_CLI_PATH: bin(record, 'ours-cowork'),
            OURS_COWORK_CONFIG: join(paths.cowork, 'config.json'), OURS_COWORK_STATE_DIR: paths.cowork },
        });
      }
      await effects.serverLifecycle(record, 'start', running);
    },
    async selectConversionVolumes(record, { allowMissingSources = false } = {}) {
      if (record.schema !== 1 || record.mode !== 'docker') {
        throw new Error('Select the recorded legacy Docker source');
      }
      const result = await compose(record, ['config', '--format', 'json']);
      const configuration = JSON.parse(result.stdout);
      const sources = {};
      const inspectOwned = async (name, key, optional = false) => {
        if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
          throw new Error('Invalid conversion volume name');
        }
        const result = await effects.run('docker', ['volume', 'inspect', '--format', '{{json .}}', name], {
          ...(optional ? { allowCodes: [1] } : {}),
        });
        if (result.code !== 0) {
          if (optional) {
            const inventory = await effects.run('docker', ['volume', 'ls', '--format', '{{.Name}}']);
            if (inventory.code === 0 && !inventory.stdout.split(/\s+/).includes(name)) return false;
          }
          throw new Error(`Source volume is missing or unavailable: ${name}`);
        }
        const volume = JSON.parse(result.stdout);
        if (volume.Name !== name || volume.Labels?.['com.docker.compose.project'] !== record.project
          || volume.Labels?.['com.docker.compose.volume'] !== key) {
          throw new Error(`Conversion volume ownership differs: ${name}`);
        }
        if (volume.Driver !== 'local' || Object.keys(volume.Options ?? {}).length) {
          throw new Error(`External or custom volume storage requires explicit ownership resolution: ${name}`);
        }
        return true;
      };
      for (const service of SERVER_SERVICES) {
        const mounts = configuration.services?.[service]?.volumes ?? [];
        const selected = [{ key: `${service}-state`, alias: service,
          target: service === 'daemon' ? '/var/lib/ours' : `/var/lib/ours-${service}`, subpath: 'data' }];
        if (service !== 'daemon') selected.push({
          key: `${service}-credential`, alias: `${service}-credential`, target: `/credentials/${service}`,
        });
        for (const selection of selected) {
          const mount = mounts.find(mount => mount.target === selection.target);
          const declared = configuration.volumes?.[selection.key];
          if (mount?.type !== 'volume' || mount.source !== selection.key
            || mount.volume?.subpath !== selection.subpath || !declared || declared.external) {
            throw new Error(`Unexpected legacy source mount for ${selection.alias}`);
          }
          if ((declared.driver && declared.driver !== 'local') || Object.keys(declared.driver_opts ?? {}).length) {
            throw new Error(`External or custom volume storage requires explicit ownership resolution: ${selection.key}`);
          }
          if (!await inspectOwned(declared.name, selection.key, allowMissingSources)) continue;
          if (Object.values(sources).includes(declared.name)) throw new Error('Conversion source volumes alias each other');
          sources[selection.alias] = declared.name;
        }
      }
      const target = `${record.project}_server-storage`;
      if (Object.values(sources).includes(target)) throw new Error('Conversion destination aliases a source volume');
      const targetExists = await inspectOwned(target, 'server-storage', true);
      if (targetExists && !record.layoutConversion) throw new Error('Unreserved conversion destination already exists');
      return { sources, target, targetExists };
    },
    async prepareDockerConversionRuntime(record) {
      const { prepareDockerConversionRuntime } = await import('./docker-conversion-runtime.mjs');
      await prepareDockerConversionRuntime(record, effects, INSTALLER_ASSETS);
    },
    async runDockerConversion(record, volumes, operation, label) {
      const { runDockerConversion } = await import('./docker-conversion-runtime.mjs');
      return runDockerConversion(record, volumes, operation, label, effects);
    },
    async convertDockerInstallation(record, operation) {
      const { convertDockerInstallation } = await import('./docker-layout-installation.mjs');
      return convertDockerInstallation(record, operation, effects);
    },
    async confirmDockerWritersStopped(record) {
      await requireCleanContainerExit(record, record.services);
    },
    async prepareLegacyPackageSource(record) {
      await ownerCommand(record, 'cowork', 'prepare-backup');
    },
    async retainConvertedPackageAuthority(record, daemon) {
      await effects.run(bin(record, 'ours'), [
        'config', 'access-retain', '--config', record.configPath,
        '--target-state-dir', daemon, '--json',
      ], { env: localEnv(record), sensitive: true });
    },
    async convertPackageInstallation(record, operation) {
      const { convertPackageInstallation } = await import('./layout-conversion.mjs');
      return convertPackageInstallation(record, operation, effects);
    },
    async stopPendingConversion(record) {
      validateInstallation(record, record.root);
      if (!record.layoutConversion) throw new Error('Select a pending layout conversion');
      const source = record.layoutConversion.sourceRecord;
      const selections = record.schema === 1 ? [source] : [record, source];
      for (const selection of selections) {
        if (record.mode === 'docker') {
          await effects.serverLifecycle(selection, 'stop', SERVER_SERVICES);
        } else {
          // Cleanup can already have removed former state. Never recreate it.
          const paths = installationPaths(selection);
          const retired = record.schema === 2 && selection === source;
          const selected = selection.services.filter(service => {
            if (!existsSync(paths[service])) return false;
            // Published conversion already retired old registrations. Partial
            // cleanup may leave directories without usable owner configuration.
            if (!retired || service === 'messenger') return true;
            return existsSync(service === 'daemon' ? selection.configPath : join(paths[service], 'config.json'));
          });
          await nativeLifecycle(selection, 'stop', selected, { effects, localEnv, ownerCommand, bin, stopSelections: selections });
        }
      }
    },
    async retireLegacyServices(record) {
      if (record.schema !== 1 || !['packages', 'docker'].includes(record.mode)) {
        throw new Error('Select a legacy managed installation for service retirement');
      }
      if (record.mode === 'docker') {
        await effects.serverLifecycle(record, 'stop');
        await requireCleanContainerExit(record, record.services);
        await compose(record, ['rm', '-f', ...record.services]);
        return;
      }
      await nativeLifecycle(record, 'retire', record.services, { effects, localEnv, ownerCommand, bin });
    },
    async serverLifecycle(record, operation, selected = record.services) {
      record = buildRuntime(record);
      if (record.mode === 'docker') {
        if (operation === 'status') {
          const result = await compose(record, ['ps', '--format', 'json', ...selected]);
          const raw = result.stdout.trim();
          const rows = !raw ? [] : raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').map(line => JSON.parse(line));
          return rows.filter(row => row.State === 'running').map(row => row.Service).filter(s => selected.includes(s));
        }
        if (operation === 'stop') {
          const consumers = selected.filter(s => s !== 'daemon').reverse();
          if (consumers.length) await compose(record, ['stop', ...consumers]);
          if (selected.includes('daemon')) await compose(record, ['stop', 'daemon']);
          if ((await effects.serverLifecycle(record, 'status', selected)).length) throw new Error('Writers did not stop');
          return;
        }
        const start = async service => {
          effects.out(`Starting ${service}; waiting for readiness...`);
          try { await compose(record, ['up', '-d', '--no-build', '--no-deps', '--wait', service]); }
          catch (cause) { throw await dockerStartupError(record, service, cause); }
          effects.out(`${service} is ready.`);
        };
        if (selected.includes('daemon')) await start('daemon');
        const failures = [];
        for (const service of selected.filter(s => s !== 'daemon')) {
          try { await start(service); }
          catch (error) { failures.push({ service, error }); }
        }
        if (failures.length) throw new Error(`Application readiness failed: ${failures.map(f => f.service).join(', ')}. Check the selected application prerequisites.\n${failures.map(f => f.error.message).join('\n\n')}`);
        return;
      }
      return nativeLifecycle(record, operation, selected, { effects, localEnv, ownerCommand, bin });
    },
    readManagedClientProfile() {
      const path = join(home, '.ours-client', 'profile.json');
      try { lstatSync(path); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      privateDirectory(dirname(path));
      if (!readHostProfileFile(path)) throw new Error('Managed client profile must contain a complete network profile');
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    async discoverClientProfile(endpoint, credentialPath) {
      const url = new URL(endpoint);
      if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
        throw new Error('Client endpoint must be an HTTP origin');
      const response = await fetch(`${url.origin}/selection`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Daemon selection answered HTTP ${response.status}`);
      const selection = await response.json();
      // Full metadata and authenticated capability validation follows before publication.
      return validateHostProfile({ endpoint: url.origin, expectedInstanceId: selection.instanceId, credentialPath: resolve(credentialPath) });
    },
    importClientProfile({ profile, sourcesPath, sources: resolvedSources, integrations, fleetSettingsPath, refresh = false }) {
      const root = join(home, '.ours-client');
      const configPath = join(root, 'profile.json');
      const credentialPath = join(root, 'credential');
      const current = effects.readManagedClientProfile();
      if (current && (current.endpoint !== profile.endpoint || current.expectedInstanceId !== profile.expectedInstanceId))
        throw new Error('Managed client already selects another server; existing default was not changed');
      assertPrivateRegularFile(profile.credentialPath, 'credential');
      const credential = readFileSync(profile.credentialPath, 'utf8');
      if (!credential.trim()) throw new Error('Client credential is empty');
      // Read every supplied input before any publication. Existing setup settings win on retry.
      const sources = current && !refresh ? null : resolvedSources
        ? Buffer.from(`${JSON.stringify(resolvedSources, null, 2)}\n`)
        : readFileSync(sourcesPath);
      const fleetSettings = (!current || refresh) && fleetSettingsPath ? readFileSync(fleetSettingsPath) : null;
      if (fleetSettings) JSON.parse(fleetSettings.toString());
      ensurePrivateDirectory(root);
      if (current && !refresh) {
        assertPrivateRegularFile(credentialPath, 'managed credential');
        if (readFileSync(credentialPath, 'utf8') !== credential) atomicWriteConfig(credentialPath, credential);
        return { configPath, profile: validateHostProfile(current), settings: current.installer };
      }
      const settings = { sourcesPath: join(root, 'sources.json'), integrations };
      if (fleetSettings) settings.fleetSettingsPath = join(root, 'fleet-settings.json');
      // Publish the profile last: clients cannot select incomplete imported inputs.
      atomicWriteConfig(settings.sourcesPath, sources);
      if (fleetSettings) atomicWriteConfig(settings.fleetSettingsPath, fleetSettings);
      atomicWriteConfig(credentialPath, credential);
      const saved = { ...profile, credentialPath, installer: settings };
      atomicWriteConfig(configPath, JSON.stringify(saved, null, 2) + '\n');
      return { configPath, profile: validateHostProfile(saved), settings };
    },
    async acquireClientPackages(configPath, sourcesPath, integrations, { refresh = false } = {}) {
      const manifest = JSON.parse(readFileSync(sourcesPath, 'utf8'));
      // Public SDK client APIs are actual integration dependencies; Fleet also owns CLI usage.
      const selected = [...new Set(['sdk', ...(integrations.includes('fleet') ? ['cli'] : []), ...integrations])];
      const packages = selectSourcePackages(manifest, 'client', selected);
      const selectionKey = refresh ? JSON.stringify([configPath, manifest, integrations]) : configPath;
      const root = join(home, '.ours-client-install', createHash('sha256').update(selectionKey).digest('hex').slice(0, 16));
      const hasGit = Object.values(packages).some(selection => selection.source);
      await effects.run('npm', ['--version']);
      if (hasGit) {
        for (const command of ['python3', 'git', 'make', 'cc']) await effects.run(command, ['--version']);
      }
      ensurePrivateDirectory(root);
      const retained = join(root, 'sources.json');
      const bytes = readFileSync(sourcesPath);
      if (!existsSync(retained)) writePrivateNew(retained, bytes);
      else if (!readFileSync(retained).equals(bytes)) throw new Error('Client installation has another exact source selection; select a distinct client profile');
      const selectionPath = join(root, 'integrations.json');
      const selectionBytes = JSON.stringify(integrations);
      if (existsSync(selectionPath) && readFileSync(selectionPath, 'utf8') !== selectionBytes) throw new Error('Client installation has another integration selection; retain its settings or select a distinct profile');
      if (!existsSync(selectionPath)) writePrivateNew(selectionPath, selectionBytes);
      if (!existsSync(join(root, '.packages-ready'))) {
        if (hasGit) {
          const sourceRoot = join(root, `build-${randomUUID()}`);
          ensurePrivateDirectory(sourceRoot);
          try {
            await effects.run(process.execPath, [join(INSTALLER_ASSETS, 'scripts/build/build.mjs')], { stream: true, cwd: root, env: { OURS_BUILD_ROOT: root, OURS_SOURCE_ROOT: sourceRoot, OURS_BUILD_PACKAGES: selected.join(',') } });
          } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
        } else {
          writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ours-native-clients', private: true, dependencies: Object.fromEntries(Object.entries(packages).map(([name, selection]) => [name, selection.version])) }), { mode: 0o600 });
        }
        await effects.run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { stream: true, cwd: root });
        verifyReleaseGraph(root, manifest, { requiredPackages: Object.keys(packages) });
        writePrivateNew(join(root, '.packages-ready'), 'ready\n');
      }
      verifyReleaseGraph(root, manifest, { requiredPackages: Object.keys(packages) });
      // Local acquisition alone does not publish native commands. Use the user's
      // configured npm prefix and retained dependency closure, including on retry.
      for (const name of integrations.filter(name => name === 'fleet' || name === 'codex')) {
        await effects.run('npm', ['install', '--global', '--install-links=false', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(root, 'node_modules', '@ours.network', name)]);
      }
      const localPackages = Object.fromEntries(integrations.filter(n => n !== 'fleet').map(name => [name, join(root, 'node_modules', '@ours.network', name)]));
      return { localPackages, packages: {}, fleetBin: integrations.includes('fleet') ? join(root, 'node_modules/.bin/ours-fleet') : null };
    },
    async prepareClientMarketplace(name, packagePath) {
      const acquisitionRoot = dirname(dirname(dirname(packagePath)));
      const sourcePath = join(acquisitionRoot, 'sources.json');
      const policy = existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, 'utf8')) : {}; // Retained pre-release client acquisitions.
      const release = releaseBinding(policy);
      const integrationsPath = join(acquisitionRoot, 'integrations.json');
      const integrations = existsSync(integrationsPath) ? JSON.parse(readFileSync(integrationsPath, 'utf8')) : null;
      const requiredPackages = integrations ? [...new Set(['sdk', ...(integrations.includes('fleet') ? ['cli'] : []), ...integrations])].map(name => '@ours.network/' + name) : Object.keys(policy.packages ?? {});
      verifyReleaseGraph(acquisitionRoot, policy, { requiredPackages });
      const root = join(acquisitionRoot, 'marketplaces', name);
      const plugin = join(root, 'plugins', 'ours');
      if (!existsSync(plugin)) {
        mkdirSync(dirname(plugin), { recursive: true, mode: 0o700 });
        cpSync(packagePath, plugin, { recursive: true });
        const manifestPath = join(plugin, 'package.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        for (const dependency of release ? [] : ['sdk', 'cli']) {
          const name = `@ours.network/${dependency}`;
          if (manifest.dependencies?.[name]) manifest.dependencies[name] = `file:${join(dirname(packagePath), dependency)}`;
        }
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      }
      if (release && JSON.stringify(JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'))) !== JSON.stringify(JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8')))) {
        throw new Error('Marketplace package differs from verified release acquisition');
      }
      // Native caches copy plugin contents; local SDK/CLI dependencies must not
      // remain links to acquisition paths. Repeating setup also repairs an interrupted install.
      await effects.run('npm', ['install', '--install-links', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: plugin });
      verifyReleaseGraph(plugin, policy);
      const value = name === 'codex'
        ? { name: 'ours-codex-marketplace', plugins: [{ name: 'ours', source: { source: 'local', path: './plugins/ours' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }
        : { name: 'ours.network', owner: { name: 'Adapt Toolkit' }, plugins: [{ name: 'ours', source: './plugins/ours' }] };
      const manifestPath = name === 'codex' ? join(root, '.agents/plugins/marketplace.json') : join(root, '.claude-plugin/marketplace.json');
      effects.writeJson(manifestPath, JSON.stringify(value, null, 2) + '\n');
      return root;
    },
    async verifyPackagedMcp(configPath) {
      const profile = typeof configPath === 'string' ? readHostProfileFile(configPath) : validateHostProfile(configPath);
      assertPrivateRegularFile(profile.credentialPath, 'credential');
      const token = readFileSync(profile.credentialPath, 'utf8').trim();
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-ours-api-token': token, 'x-ours-session-mode': 'external', 'x-ours-lease-token': randomUUID() };
      const request = async (method, params, id) => {
        const response = await fetch(`${profile.endpoint}/mcp`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers, body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) });
        const session = response.headers.get('mcp-session-id');
        if (session) headers['mcp-session-id'] = session;
        if (!response.ok) throw new Error(`Packaged MCP verification failed: HTTP ${response.status}`);
        if (id === undefined) { await response.body?.cancel(); return; }
        const text = await response.text();
        const messages = response.headers.get('content-type')?.includes('text/event-stream')
          ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
          : [JSON.parse(text)];
        const message = messages.find(value => value.id === id);
        if (!message || message.error || !message.result) throw new Error('Packaged MCP returned no successful protocol result');
        return message.result;
      };
      try {
        const initialized = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ours-install', version: '1' } }, 1);
        if (initialized.serverInfo?.name !== 'ours' || !initialized.protocolVersion) throw new Error('Selected MCP is not the packaged OURS server');
        headers['mcp-protocol-version'] = initialized.protocolVersion;
        await request('notifications/initialized', {}, undefined);
        const resources = await request('resources/list', {}, 2);
        if (!resources.resources?.some(resource => resource.uri === 'ours://application-identities')) throw new Error('Packaged network MCP identity resource is absent');
        const toolList = await request('tools/list', {}, 3);
        if (!toolList.tools?.some(tool => tool.name === 'list_identities')) throw new Error('Packaged OURS identity tools are absent');
      } finally {
        if (headers['mcp-session-id']) {
          const response = await fetch(`${profile.endpoint}/mcp`, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(5000), headers });
          await response.body?.cancel();
          if (!response.ok) throw new Error('MCP verification session could not be closed');
        }
      }
    },
  };
}

async function nativeLifecycle(record, operation, selected, { effects, localEnv, ownerCommand, bin, stopSelections }) {
  const linux = effects.platform.platform === 'linux';
  const daemonState = installationPaths(record).daemon;
  const daemonService = linux ? unitNameForStateDir(daemonState) : launchdLabelForStateDir(daemonState);
  if (!daemonService.ok) throw new Error('Cannot derive selected daemon service');
  const messenger = messengerServicePlan(record, effects.platform.platform, effects.home, bin(record, 'ours-messenger-server'), localEnv(record, 'messenger'), process.getuid());
  const plans = {
    daemon: {
      name: linux ? daemonService.unit : daemonService.label,
      path: linux
        ? join(effects.home, '.config/systemd/user', daemonService.unit)
        : join(effects.home, 'Library/LaunchAgents', `${daemonService.label}.plist`),
    },
    telegram: { name: linux ? 'ours-telegram.service' : 'solutions.adaptframework.ours-telegram', state: installationPaths(record).telegram },
    cowork: { name: linux ? 'ours-cowork.service' : 'network.ours.cowork', state: installationPaths(record).cowork },
    messenger,
  };
  for (const [service, plan] of Object.entries(plans)) {
    plan.path ??= linux ? join(effects.home, '.config/systemd/user', plan.name) : join(effects.home, 'Library/LaunchAgents', `${plan.name}.plist`);
    if (service === 'daemon') continue;
    if (existsSync(plan.path)) {
      const text = readFileSync(plan.path, 'utf8');
      const allowedStates = stopSelections?.map(selection => installationPaths(selection)[service]) ?? [plan.state];
      if (service === 'messenger' ? !text.includes(messenger.marker) : !allowedStates.includes(consumerServiceState(text, service, effects.platform.platform))) throw new Error(`Refusing unrelated existing ${service} service: ${plan.path}`);
    }
  }
  const manager = async (service, op) => {
    const plan = plans[service];
    if (!existsSync(plan.path)) return;
    if (linux) return effects.run('systemctl', ['--user', op, plan.name]);
    if (op === 'stop') {
      const found = await effects.run('launchctl', ['print', `gui/${process.getuid()}/${plan.name}`], { allowCodes: [113] });
      if (found.code === 0) await effects.run('launchctl', ['bootout', `gui/${process.getuid()}`, plan.path]);
    } else {
      const found = await effects.run('launchctl', ['print', `gui/${process.getuid()}/${plan.name}`], { allowCodes: [113] });
      if (found.code !== 0) await effects.run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plan.path]);
      await effects.run('launchctl', ['kickstart', `gui/${process.getuid()}/${plan.name}`]);
    }
  };
  const health = async service => {
    if (service === 'daemon') {
      const profilePath = join(installationPaths(record).mcp, 'profile.json');
      await effects.verifyHostProfile(profilePath);
      await effects.verifyPackagedMcp(profilePath);
      return;
    }
    if (service === 'cowork') { await ownerCommand(record, service, 'status'); return; }
    const endpoint = { telegram: 'http://127.0.0.1:3051/health', messenger: `http://127.0.0.1:${record.messengerPort}/api/healthz` }[service];
    const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`${service} health check failed`);
  };
  if (operation === 'status') {
    const running = [];
    for (const service of selected) {
      if (service === 'messenger') {
        if (!existsSync(messenger.path)) continue;
        const result = linux ? await effects.run('systemctl', ['--user', 'is-active', messenger.name], { allowCodes: [3, 4] }) : await effects.run('launchctl', ['print', `${messenger.domain}/${messenger.name}`], { allowCodes: [113] });
        if (result.code === 0 && (linux || /pid = \d+/.test(result.stdout))) running.push(service);
      } else {
        const result = await ownerCommand(record, service, 'status', { allowCodes: service === 'daemon' ? [3] : service === 'cowork' ? [6] : [1] });
        if (result.code === 0) running.push(service);
      }
    }
    return running;
  }
  if (operation === 'stop' || operation === 'retire') {
    for (const service of [...selected].reverse()) {
      if (operation === 'retire' && linux && service !== 'daemon' && existsSync(plans[service].path)) {
        await effects.run('systemctl', ['--user', 'disable', plans[service].name]);
      }
      if (service !== 'daemon') await manager(service, 'stop');
      else await ownerCommand(record, service, 'uninstall-service');
      if (service !== 'messenger') await ownerCommand(record, service, 'stop');
      if (service === 'daemon') {
        const stateDir = installationPaths(record).daemon;
        const derived = linux ? unitNameForStateDir(stateDir) : launchdLabelForStateDir(stateDir);
        if (!derived.ok) throw new Error('Cannot verify selected daemon service shutdown');
        const observed = linux
          ? await effects.run('systemctl', ['--user', 'is-active', derived.unit], { allowCodes: [3, 4] })
          : await effects.run('launchctl', ['print', `gui/${process.getuid()}/${derived.label}`], { allowCodes: [113] });
        if (observed.code === 0) throw new Error('Selected daemon service is still loaded or active; authority operation refused');
      }
    }
    if ((await nativeLifecycle(record, 'status', selected, { effects, localEnv, ownerCommand, bin, stopSelections })).length) throw new Error('Selected writers did not stop');
    if (operation === 'retire') {
      // Daemon registration removal belongs to its existing uninstall-service command.
      // Consumer definitions were checked against this installation before any stop.
      for (const service of selected.filter(service => service !== 'daemon')) {
        rmSync(plans[service].path, { force: true });
      }
      if (linux) await effects.run('systemctl', ['--user', 'daemon-reload']);
    }
    return;
  }
  const failures = [];
  for (const service of selected) {
    try {
      if (service === 'messenger') {
        if (!existsSync(messenger.path)) {
          mkdirSync(dirname(messenger.path), { recursive: true });
          writePrivateNew(messenger.path, messenger.text);
          if (linux) {
            await effects.run('systemctl', ['--user', 'daemon-reload']);
            await effects.run('systemctl', ['--user', 'enable', messenger.name]);
          }
        }
        await manager(service, 'start');
      } else if (service === 'daemon') {
        await ownerCommand(record, service, 'install-service');
        await manager(service, 'start');
      } else if (!existsSync(plans[service].path)) {
        await ownerCommand(record, service, 'install-service');
      } else await manager(service, 'start');
      let ready = false;
      // Restoring existing identities can take longer than 30 seconds.
      const readinessDeadline = Date.now() + 120_000;
      while (Date.now() < readinessDeadline) {
        try { await health(service); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
      }
      if (!ready) throw new Error('Application is not ready');
    } catch {
      if (service === 'daemon') throw new Error('Daemon and packaged MCP are not ready; consumers were not started');
      failures.push(service);
    }
  }
  if (failures.length) throw new Error(`Application readiness failed: ${failures.join(', ')}. Check the selected application prerequisites.`);
}
