// ours-install v3 — daemon creation and boot-service installation.
//
// Pure planning code, like lib/target.mjs: the orchestrator
// injects file reads, and every function returns a PLAN the caller renders and
// executes. Nothing here writes, spawns, or runs systemctl.

import { join, resolve, basename, dirname } from 'node:path';
import { valid, validRange, satisfies } from 'semver';
import { releaseBinding } from '../assets/scripts/maintenance/release-graph.mjs';

export const CLI_UNIT_MARKER = '# Managed by @ours.network/cli';
export const SYSTEMD_USER_DIR = ['.config', 'systemd', 'user'];
export const DEFAULT_SYSTEMD_UNIT = 'ours.service';
export const DEFAULT_LAUNCHD_LABEL = 'solutions.adaptframework.ours';

// -----------------------------------------------------------------------------
// Which unit file does this state directory own?
// -----------------------------------------------------------------------------

// 1–32 chars, alphanumeric with interior hyphens/underscores, no dots.
const INSTANCE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9])?$/;

/**
 * State directory -> systemd user unit name.
 *
 * SOURCE OF TRUTH IS ours-sdk `packages/cli/src/service-instance.ts` (merged in
 * ours-sdk #20). The CLI performs this derivation itself when it installs, so
 * the installer does NOT pass a unit name — it only needs to know which file to
 * INSPECT before invoking the CLI, because of the unmarked-unit case below.
 * This is a deliberate second copy across two repos; the table test pins it, and
 * if the CLI's rule ever changes this must change with it.
 *
 * `~/.ours` -> '' -> ours.service (the historical unnamed unit, unchanged).
 */
export function unitNameForStateDir(stateDir) {
  const segment = basename(resolve(stateDir));
  const undotted = segment.startsWith('.') ? segment.slice(1) : segment;
  if (undotted === 'ours') return { ok: true, unit: DEFAULT_SYSTEMD_UNIT, instance: '' };
  const name = undotted.startsWith('ours-') ? undotted.slice('ours-'.length) : undotted;
  if (!name || name.length > 32 || !INSTANCE_RE.test(name)) {
    return { ok: false, unit: null, instance: null, reason: `state directory ${resolve(stateDir)} does not yield a usable service name (${JSON.stringify(name)})` };
  }
  return { ok: true, unit: `ours-${name}.service`, instance: name };
}

export function unitPathForStateDir(stateDir, home) {
  const derived = unitNameForStateDir(stateDir);
  if (!derived.ok) return derived;
  return { ...derived, path: join(home, ...SYSTEMD_USER_DIR, derived.unit) };
}

/**
 * Read-only launchd label derivation for accurate progress output. The CLI owns
 * the plist path, generation, permissions, conflict handling and launchctl.
 *
 * SOURCE OF TRUTH IS @ours.network/cli 2.6.1 service-instance.ts. Keep this in
 * the same table tests as the systemd derivation above.
 */
export function launchdLabelForStateDir(stateDir) {
  const derived = unitNameForStateDir(stateDir);
  if (!derived.ok) return derived;
  return {
    ok: true,
    label: derived.instance ? `${DEFAULT_LAUNCHD_LABEL}.${derived.instance}` : DEFAULT_LAUNCHD_LABEL,
    instance: derived.instance,
  };
}

// -----------------------------------------------------------------------------
// The unmarked-unit case — the migration blocker
// -----------------------------------------------------------------------------

/**
 * Classify whatever is already at the unit path.
 *
 *   absent      — nothing there; install proceeds
 *   cli-managed — written by @ours.network/cli; the CLI's own idempotence and
 *                 its baked-state-dir guard handle it from here
 *   legacy      — the unit published ours-mcp wrote: NO marker, ExecStart running
 *                 ours-mcp. This is the migration blocker. `ours daemon
 *                 install-service` refuses to overwrite an unmarked unit without
 *                 --force, so service installation fails for every existing Linux user.
 *   foreign     — unmarked and NOT recognisably ours-mcp's. Someone else's file.
 *
 * THE legacy/foreign SPLIT IS NOW THE ENTIRE SAFETY BOUNDARY. A `legacy` unit is
 * rewritten SILENTLY — no prompt stands between this match and someone's file —
 * so this match must stay a POSITIVE IDENTIFICATION of ours-mcp's own unit and
 * must never drift toward "probably ours". A later reader must not collapse the
 * two into one "unmarked unit" case for tidiness, and must not relax the patterns
 * to catch more variants.
 *
 * For `foreign` we do not know what the file is, so the installer stops, offers
 * no command, and does not prompt either: a confirmation dialogue over an
 * unidentified file in someone's systemd directory is how you talk a user into
 * destroying something.
 */
export function classifyUnit(text) {
  if (text === null || text === undefined) return { kind: 'absent' };
  const s = String(text);
  if (s.startsWith(CLI_UNIT_MARKER)) return { kind: 'cli-managed' };
  const looksLikeOursMcp = /ExecStart=.*\bours-mcp\b/.test(s)
    || /^Description=ours MCP daemon\b/m.test(s)
    || (/^Environment=OURS_STATE_DIR=/m.test(s) && /^Environment=OURS_TRANSPORT=http$/m.test(s));
  return looksLikeOursMcp ? { kind: 'legacy' } : { kind: 'foreign' };
}

/**
 * Decide what this run should do about the boot service.
 *
 * Returns one of:
 *   { action: 'install' }                        — call the CLI; it does the rest
 *   { action: 'adopt', notice, … }               — a legacy ours-mcp unit is in the
 *                                                  way; rewrite it, and print one
 *                                                  informational line naming it
 *   { action: 'refuse', exitCode: 2, … }         — unknown unit, or unusable state dir
 *
 * Adoption of a legacy unit is SILENT: no prompt, no question, so an upgrading
 * user has no manual step. The one line of output exists so the replacement is not
 * literally invisible; it does not block and it is not a warning.
 *
 * BECAUSE THERE IS NO PROMPT, `classifyUnit`'s `legacy` match is now the ENTIRE
 * safety boundary between a stranger's file and a silent rewrite. It must stay
 * strict — a positive identification of ours-mcp's own unit, never "probably
 * ours". A `foreign` unit is still a hard stop with no command and no prompt.
 *
 * `adopt` still carries no command: the --force comes from
 * serviceInstallCommand({ adoptLegacyUnit: true }), which the orchestrator opts
 * into explicitly. The boundary is worth keeping in the shape of the API even
 * without a question in front of it — it is what keeps --force from becoming a
 * default that spreads to the other cases.
 */
export function planServiceInstall({ stateDir, home, readText, platform = 'linux' }) {
  // @ours.network/cli 2.6.1 dispatches this same command to user systemd on
  // Linux and launchd on macOS. Other platforms still have no service adapter.
  if (platform && platform !== 'linux' && platform !== 'darwin') {
    return {
      action: 'unsupported',
      platform,
      reason: 'no-service-manager',
      message: `installing a boot service is not available on ${platform} — the ours CLI supports Linux user systemd and macOS launchd`,
      manual: ['ours', 'daemon', 'serve', '--config'],
    };
  }

  if (platform === 'darwin') {
    const derived = launchdLabelForStateDir(stateDir);
    if (!derived.ok) {
      return { action: 'refuse', exitCode: 2, reason: 'unusable-state-dir', message: derived.reason };
    }
    return {
      action: 'install', platform, unit: derived.label, instance: derived.instance,
    };
  }

  const derived = unitPathForStateDir(stateDir, home);
  if (!derived.ok) {
    return { action: 'refuse', exitCode: 2, reason: 'unusable-state-dir', message: derived.reason };
  }
  const existing = classifyUnit(readText(derived.path));
  if (existing.kind === 'absent' || existing.kind === 'cli-managed') {
    return { action: 'install', unit: derived.unit, unitPath: derived.path, instance: derived.instance };
  }
  if (existing.kind === 'foreign') {
    return {
      action: 'refuse',
      exitCode: 2,
      reason: 'unknown-unit',
      unit: derived.unit,
      unitPath: derived.path,
      message: `${derived.path} already exists and was not written by ours. Refusing to touch it. Inspect it, and remove it yourself if it is no longer wanted.`,
    };
  }
  // The legacy case: a unit we POSITIVELY identify as the one published ours-mcp
  // wrote. It is adopted and rewritten SILENTLY — no prompt, no question — so an
  // upgrading user has no manual step at all. Safe because nothing under the
  // state directory changes when a unit file is replaced: identities, keys,
  // contacts and message history are untouched, which the 0.16.0 -> ours-sdk
  // migration run established rather than assumed.
  //
  // There is no assumeYes parameter any more, and that is the point: with no
  // consent to withhold, an unattended run must behave EXACTLY like an
  // interactive one. A dead flag here would be an invitation to reintroduce a
  // difference between the two.
  return {
    action: 'adopt',
    unit: derived.unit,
    unitPath: derived.path,
    instance: derived.instance,
    stateDir: resolve(stateDir),
    notice: legacyReplacedNotice(derived.path, resolve(stateDir)),
  };
}

/**
 * The single informational line printed when a legacy unit is replaced.
 *
 * Not a warning and not a question — it exists so the replacement is not
 * literally invisible. It names the exact file, and says the state directory is
 * untouched.
 *
 * That second clause is accuracy, not reassurance: replacing a systemd unit does
 * not change a byte under the state directory. DO NOT "improve" this line by
 * adding a data-loss warning. It would be false, and it would push people into
 * reinstalling — the one action that really would cost them their identities. A
 * test asserts this text contains no lost/delete/erase/wipe/destroy wording, and
 * that assertion is here to stop exactly that edit.
 */
export function legacyReplacedNotice(unitPath, stateDir) {
  return `replaced ${unitPath} — the boot unit an older ours-mcp installed (your state directory ${stateDir} is untouched)`;
}

/**
 * The CLI invocation that installs the boot service. The unit NAME is not passed:
 * ours-sdk #20 made the CLI derive it from --state-dir itself, so the installer
 * neither passes a per-instance unit name nor writes the unit itself: it selects
 * the daemon and the CLI names
 * the unit. One derivation, in one place.
 */
export function serviceInstallCommand({ stateDir, adoptLegacyUnit = false }) {
  const dir = resolve(stateDir);
  // --json so the caller can read back whether the unit actually CHANGED. The
  // CLI owns that byte-comparison, and an installer that guessed at it would
  // report "nothing changed" on a run that rewrote a unit.
  // --json so the caller can read back whether the unit actually CHANGED rather
  // than assuming it did. --force is reachable only through the explicit argument
  // above, and the CLI refuses to overwrite a unit it did not write.
  const cmd = ['ours', 'daemon', 'install-service', '--yes', '--json', '--state-dir', dir, '--config', join(dir, 'config.json')];
  if (adoptLegacyUnit) cmd.push('--force');
  return cmd;
}

// -----------------------------------------------------------------------------
// Daemon configuration file
// -----------------------------------------------------------------------------

/**
 * Merge, never rewrite: only `port`, `stateDir` and `brokerUrl` are set, every
 * other key in the file is preserved, and a merge that would change nothing
 * reports `changed: false` so the caller can leave the file untouched.
 *
 * `stateDir` is written absolute and always alongside `port`, so the pair that
 * identifies a daemon never travels half-formed.
 */
export function planDaemonConfig(existing, { port, stateDir, brokerUrl }) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const patch = { port, stateDir: resolve(stateDir), brokerUrl };
  const merged = { ...base };
  const changes = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (merged[key] === value) continue;
    changes.push(key);
    merged[key] = value;
  }
  return { changed: changes.length > 0, changes, config: merged, text: `${JSON.stringify(merged, null, 2)}\n` };
}

/**
 * The ordered, announced steps for the daemon half of a run. Each is
 * idempotent, and an `update` skips creation entirely: it never moves a port and
 * never creates a second daemon.
 */
export function planDaemonSteps(target, { cliVersionChanged = false, cliStartedIt = true } = {}) {
  const dir = target.stateDir;
  const steps = [{ id: 'cli', label: 'install the ours-sdk CLI', command: ['npm', 'i', '-g', '@ours.network/cli'] }];
  steps.push({ id: 'config', label: `write ${join(dir, 'config.json')}`, port: target.port });
  if (target.action === 'create') {
    steps.push({ id: 'start', label: `start the daemon on port ${target.port}`, command: ['ours', 'daemon', 'start', '--config', join(dir, 'config.json')] });
  } else if (cliVersionChanged) {
    // `ours daemon stop` refuses to signal a daemon it did not start, so a
    // daemon under another launcher is left running and the caller says which
    // launcher must be restarted instead.
    steps.push(cliStartedIt
      ? { id: 'restart', label: 'restart the daemon (package version changed)', command: ['ours', 'daemon', 'restart', '--config', join(dir, 'config.json')] }
      : { id: 'restart-external', label: 'daemon was not started by the CLI — restart it with its own launcher', command: null });
  }
  steps.push({ id: 'service', label: 'install the boot service', command: serviceInstallCommand({ stateDir: dir }) });
  return steps;
}

export const SERVER_PACKAGES = ['sdk', 'cli', 'tg-connector', 'cowork', 'messenger-server'].map(n => `@ours.network/${n}`);
export const SERVER_DEPENDENCIES = {
  daemon: [], telegram: ['daemon'], cowork: ['daemon'], messenger: ['daemon'],
};
export const SERVER_SERVICES = Object.keys(SERVER_DEPENDENCIES);

export function maintenanceServices(record, domain) {
  const selected = new Set(domain === 'server' ? record.services : [domain]);
  for (const service of SERVER_SERVICES) {
    if (SERVER_DEPENDENCIES[service].some(provider => selected.has(provider))) selected.add(service);
  }
  return record.services.filter(service => selected.has(service));
}

/** Validate exact supplied selections, without rewriting the source authority. */
export function selectSourcePackages(manifest, role, clients = []) {
  const names = role === 'server' ? SERVER_PACKAGES : clients.map(n => `@ours.network/${n}`);
  const result = {};
  for (const name of names) {
    const selected = manifest?.packages?.[name];
    if (selected?.type === 'npm' && Object.keys(selected).length === 2 && valid(selected.version) !== null) {
      result[name] = selected;
    } else if (selected && Object.keys(selected).length === 1 && typeof selected.source === 'string') {
      const source = manifest.sources?.[selected.source];
      if (source?.type !== 'git' || typeof source.url !== 'string' || !source.url || !/^[0-9a-f]{40}$/.test(source.commit)) throw new Error(`Invalid exact Git selection for ${name}`);
      result[name] = selected;
    } else throw new Error(`Missing or non-exact source selection for ${name}`);
  }
  return result;
}

/** Resolve a packaged compatibility policy into a role-filtered exact selection. */
export async function resolveSourcePolicy(manifest, role, clients = [], resolveNpm) {
  const release = releaseBinding(manifest);
  const names = role === 'server' ? SERVER_PACKAGES : clients.map(name => `@ours.network/${name}`);
  const packages = {};
  const sourceNames = new Set();
  for (const name of names) {
    const selected = manifest?.packages?.[name];
    if (selected?.type === 'npm' && Object.keys(selected).length === 2 && typeof selected.version === 'string') {
      if (valid(selected.version) !== null) packages[name] = selected;
      else {
        if (validRange(selected.version) === null) throw new Error(`Invalid npm source policy for ${name}`);
        if (typeof resolveNpm !== 'function') throw new Error(`Cannot resolve npm source policy for ${name}`);
        const version = await resolveNpm(name, selected.version);
        if (valid(version) === null || !satisfies(version, selected.version)) throw new Error(`Resolved ${name}@${version} outside allowed range ${selected.version}`);
        packages[name] = { type: 'npm', version };
      }
    } else if (selected && Object.keys(selected).length === 1 && typeof selected.source === 'string') {
      const source = manifest.sources?.[selected.source];
      if (source?.type !== 'git' || typeof source.url !== 'string' || !source.url || !/^[0-9a-f]{40}$/.test(source.commit)) throw new Error(`Invalid exact Git selection for ${name}`);
      packages[name] = selected;
      sourceNames.add(selected.source);
    } else throw new Error(`Missing source policy for ${name}`);
  }
  const sources = Object.fromEntries([...sourceNames].map(name => [name, manifest.sources[name]]));
  const exact = { ...(sourceNames.size ? { sources } : {}), packages, ...(release ? { release } : {}) };
  selectSourcePackages(exact, role, clients);
  return exact;
}

/** Installer-owned physical layout; package defaults remain unchanged. */
export function installationPaths(record) {
  const root = record.root;
  const shared = record.schema === 2;
  const state = shared ? join(root, 'storage', 'state') : root;
  const daemon = join(state, shared ? 'daemon' : 'data');
  const credentials = Object.fromEntries(['telegram', 'cowork', 'messenger'].map(service => [
    service, shared ? join(state, 'credentials', service, 'daemon-token') : join(root, 'credentials', `${service}-token`),
  ]));
  return {
    state, daemon, mcp: join(state, 'mcp'), telegram: join(state, 'telegram'),
    cowork: join(state, 'cowork'), messenger: join(state, 'messenger'), credentials,
    config: shared ? join(daemon, 'config.json') : join(root, 'config.json'),
  };
}

export function validateInstallation(record, root) {
  if (!record || ![1, 2].includes(record.schema) || !['docker', 'packages'].includes(record.mode)
    || record.root !== root || record.configPath !== installationPaths(record).config
    || record.sourcesPath !== join(root, 'sources.json') || record.workDir !== join(root, 'runtime')
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(record.instanceId ?? '')
    || !/^ours-[a-z0-9]+$/.test(record.project ?? '')
    || (record.sourcePolicyHash !== undefined && !/^[0-9a-f]{64}$/.test(record.sourcePolicyHash))
    || !Array.isArray(record.services) || record.services[0] !== 'daemon' || new Set(record.services).size !== record.services.length || record.services.some(s => !SERVER_SERVICES.includes(s))) {
    throw new Error('Invalid or conflicting installation selection');
  }
  if (record.layoutConversion !== undefined) {
    // DEPRECATED (introduced in 2.0): legacy managed-layout conversion only.
    // Removal target: 3.0, after supported installs convert and upgrade inputs
    // no longer need this reader. Retain backups and supported archive import.
    const conversion = record.layoutConversion;
    const source = conversion?.sourceRecord;
    if (conversion?.version !== 1 || source?.schema !== 1 || source.layoutConversion !== undefined
      || typeof conversion.backupPath !== 'string'
      || dirname(conversion.backupPath) !== join(root, 'storage', 'backups')
      || resolve(conversion.backupPath) !== conversion.backupPath
      || !Array.isArray(conversion.runningServices)
      || new Set(conversion.runningServices).size !== conversion.runningServices.length) {
      throw new Error('Invalid layout conversion record');
    }
    validateInstallation(source, root);
    if (['mode', 'instanceId', 'project', 'sourcesPath', 'workDir'].some(key => source[key] !== record[key])
      || JSON.stringify(source.services) !== JSON.stringify(record.services)
      || conversion.runningServices.some(service => !source.services.includes(service))) {
      throw new Error('Conflicting layout conversion source');
    }
  }
  if (record.buildTransition !== undefined) {
    const transition = record.buildTransition, candidate = transition?.candidate;
    if (record.schema !== 2 || record.layoutConversion || !candidate
      || candidate.buildTransition !== undefined || candidate.layoutConversion !== undefined
      || dirname(candidate.root ?? '') !== root || !/^\.build-[A-Za-z0-9]{6}$/.test(basename(candidate.root ?? ''))
      || !/^ours-build[0-9a-f]{32}$/.test(candidate.project ?? '')
      || !['update', 'rebuild'].includes(transition.operation)
      || !['prepared', 'state-updated', 'runtime-activated'].includes(transition.phase)
      || typeof transition.compatible !== 'boolean'
      || (transition.sourcePolicyHash !== undefined && !/^[0-9a-f]{64}$/.test(transition.sourcePolicyHash))
      || !Array.isArray(transition.runningServices)
      || new Set(transition.runningServices).size !== transition.runningServices.length
      || transition.runningServices.some(service => !record.services.includes(service))) {
      throw new Error('Invalid server build transition');
    }
    validateInstallation(candidate, candidate.root);
    for (const key of ['schema', 'mode', 'instanceId', 'services', 'port', 'coworkPort', 'messengerPort', 'messengerIdentity', 'uid', 'gid']) {
      if (JSON.stringify(candidate[key]) !== JSON.stringify(record[key])) throw new Error('Conflicting server build candidate');
    }
  }
  return record;
}

/** Messenger exposes serve only; these definitions contain no credentials. */
export function messengerServicePlan(record, platform, home, executable, environment, uid) {
  const marker = `Managed by @ours.network/install; state=${record.root}`;
  const name = `${record.project}-messenger`;
  if ([record.root, executable, ...Object.values(environment)].some(v => /[\n\r\0]/.test(String(v)))) throw new Error('Service values must not contain control characters');
  if (platform === 'linux') {
    const escape = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
    return { path: join(home, '.config/systemd/user', `${name}.service`), marker: `# ${marker}`, name: `${name}.service`, text: `# ${marker}\n[Unit]\nDescription=OURS Messenger\nAfter=network-online.target\n[Service]\nType=simple\nExecStart=${escape(executable)} serve\n${Object.entries(environment).map(([k, v]) => `Environment=${escape(`${k}=${v}`)}`).join('\n')}\nRestart=on-failure\nRestartSec=2\n[Install]\nWantedBy=default.target\n` };
  }
  if (platform !== 'darwin') throw new Error('Messenger requires systemd-user or launchd');
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const label = `network.ours.${name}`;
  return { path: join(home, 'Library/LaunchAgents', `${label}.plist`), marker: `<!-- Managed by @ours.network/install; selection=${record.project} -->`, name: label, domain: `gui/${uid}`, text: `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Managed by @ours.network/install; selection=${record.project} -->\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(executable)}</string><string>serve</string></array><key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>\n` };
}

/** Read the owning field emitted by the existing consumer service recipes.
 * Unknown/ambiguous definitions are not evidence of ownership. In particular,
 * comments, another key, or a longer state path never authorize manager calls.
 */
export function consumerServiceState(text, service, platform) {
  const key = { telegram: 'OURS_TG_STATE_DIR', cowork: 'OURS_COWORK_STATE_DIR' }[service];
  if (!key || typeof text !== 'string') return undefined;
  if (platform === 'darwin') {
    const clean = text.replace(/<!--[\s\S]*?-->/g, '');
    if (clean.includes('<!--')) return undefined;
    const dictionaries = [...clean.matchAll(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)];
    if (dictionaries.length !== 1) return undefined;
    const fields = [...dictionaries[0][1].matchAll(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'g'))];
    if (fields.length !== 1) return undefined;
    const raw = fields[0][1];
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(raw)) return undefined;
    try {
      return raw.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity) => {
        if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(entity[1] === 'x' ? 2 : 1), entity[1] === 'x' ? 16 : 10));
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
      });
    } catch { return undefined; }
  }
  if (platform !== 'linux') return undefined;
  let section = '', selected;
  let matches = 0;
  for (const source of text.split('\n')) {
    const line = source.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (/^\[.*\]$/.test(line)) { section = line; continue; }
    if (section !== '[Service]') continue;
    if (/^(EnvironmentFile|UnsetEnvironment)\s*=/.test(line)) return undefined;
    const assignment = /^Environment\s*=(.*)$/.exec(line);
    if (!assignment) continue;
    let value = assignment[1].trim();
    if (!value) { selected = undefined; matches = 0; continue; }
    if (value.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\[\\"])*"$/.test(value)) return undefined;
      value = value.slice(1, -1).replace(/\\([\\"])/g, '$1');
    } else if (/[\s"\\]/.test(value)) return undefined;
    if (/%(?!%)/.test(value.replaceAll('%%', ''))) return undefined;
    value = value.replaceAll('%%', '%');
    if (value.startsWith(`${key}=`)) { selected = value.slice(key.length + 1); matches++; }
  }
  return matches === 1 ? selected : undefined;
}

export function clientPackageNames(integrations) {
  return [...new Set(['sdk', 'cli', ...(integrations.some(name => ['codex', 'claude-code'].includes(name)) ? ['mcp'] : []), ...integrations])];
}
