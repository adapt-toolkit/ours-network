import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isSecureNodeVersion, NODE_DOWNLOAD_URL, NODE_SECURITY_ADVISORY } from './security-versions.mjs';

// Native services start the Node.js their definition records. The installer migrates a
// retained definition whose interpreter is unpatched, and loads an installer-owned guard
// into every service process (NODE_OPTIONS=--require), so each later start or restart by
// systemd or launchd refuses an interpreter that has become unpatched since.

export const NODE_FLOOR_GUARD = 'node-floor-guard.cjs';
export const NODE_FLOOR_DROP_IN = 'ours-node-floor.conf';
const DROP_IN_MARKER = '# Managed by @ours.network/install: refuse an unpatched Node.js before every start.';

// Plain JavaScript without backslashes, dollar or percent signs; floors match security-versions.mjs.
export const NODE_FLOOR_GUARD_SOURCE = `'use strict';
// Managed by @ours.network/install. Loaded into native services through NODE_OPTIONS.
const v = process.versions.node.split('.').map(Number), f = { 22: [23, 4], 24: [22, 1], 26: [12, 1] }[v[0]];
if (v.length !== 3 || v.some(n => !Number.isInteger(n)) || !f || v[1] < f[0] || (v[1] === f[0] && v[2] < f[1])) {
  process.stderr.write('Node.js ' + process.versions.node + ' is not permitted. Ours requires a patched supported Node.js release: 22.23.4+, 24.22.1+, 26.12.1+ within those release lines. '
    + 'Earlier patch levels are affected by CVE-2026-111497: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases '
    + 'Update Node.js (https://nodejs.org/en/download), then run the Ours installer again.' + String.fromCharCode(10));
  process.exit(1);
}
`;

/** The NODE_OPTIONS value that loads the guard; refuses paths it cannot quote safely. */
export function guardNodeOptions(guardPath) {
  if (!isAbsolute(guardPath) || /[\0\n\r"\\%$<>&']/.test(guardPath)) throw new Error('Node.js floor guard path is not safe for NODE_OPTIONS');
  return `--require "${guardPath}"`;
}

/** systemd drop-in that loads the guard into the unit's actual process. */
export function nodeFloorDropIn(guardPath) {
  const value = `NODE_OPTIONS=${guardNodeOptions(guardPath)}`.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `${DROP_IN_MARKER}\n[Service]\nEnvironment="${value}"\n`;
}

const decodeXml = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
const ENVIRONMENT_KEY = '<key>EnvironmentVariables</key>';
const count = (text, part) => text.split(part).length - 1;

/**
 * The active key/value pairs of a launchd plist's single EnvironmentVariables dictionary,
 * parsed with comments excluded, or null when that dictionary is missing, repeated (also
 * inside a comment) or holds anything but string values.
 */
export function plistEnvironment(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/<!--[\s\S]*?-->/g, '');
  if (clean.includes('<!--') || clean.includes('<![CDATA[') || count(clean, ENVIRONMENT_KEY) !== 1 || count(text, ENVIRONMENT_KEY) !== 1) return null;
  const body = clean.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1];
  if (body === undefined || body.includes('<dict')) return null;
  const pairs = [...body.matchAll(/\s*<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/gy)];
  if (pairs.map(match => match[0]).join('') !== body.replace(/\s+$/, '')) return null;
  return pairs.map(([, key, value]) => [decodeXml(key), decodeXml(value)]);
}

/**
 * Whether a launchd plist carries the installer's guard: 'present' only when the single
 * active EnvironmentVariables dictionary has exactly one NODE_OPTIONS holding exactly the
 * guard and NODE_OPTIONS appears nowhere else, including comments; 'absent' when
 * NODE_OPTIONS appears nowhere; otherwise 'conflict'.
 */
export function plistGuardState(text, guardPath) {
  const mentions = count(text, 'NODE_OPTIONS');
  if (mentions === 0) return 'absent';
  const options = (plistEnvironment(text) ?? []).filter(([key]) => key === 'NODE_OPTIONS');
  return mentions === 1 && options.length === 1 && options[0][1] === guardNodeOptions(guardPath) ? 'present' : 'conflict';
}

/** Adds the guard to a launchd plist's single active EnvironmentVariables dictionary, or returns null. */
export function plistWithGuard(text, guardPath) {
  if (plistEnvironment(text) === null) return null;
  const state = plistGuardState(text, guardPath);
  if (state === 'present') return text;
  if (state !== 'absent') return null;
  const entry = `<key>NODE_OPTIONS</key><string>${guardNodeOptions(guardPath).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}</string>`;
  return text.replace(/<key>EnvironmentVariables<\/key>(\s*)<dict>/, (match) => `${match}${entry}`);
}

/** The interpreter (first program argument) of a systemd unit or launchd plist, or null. Text only; nothing is executed. */
export function recordedInterpreter(text, platform) {
  if (typeof text !== 'string') return null;
  if (platform === 'darwin') {
    const clean = text.replace(/<!--[\s\S]*?-->/g, '');
    const lists = [...clean.matchAll(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/g)];
    if (lists.length !== 1) return null;
    const value = decodeXml(lists[0][1]);
    return isAbsolute(value) && !/[\0\n\r]/.test(value) ? value : null;
  }
  if (platform !== 'linux') return null;
  const starts = execStarts(text);
  if (starts.length !== 1) return null;
  // Exec prefixes (-, @, :, +, !) change how the command runs; they are not interpreted.
  const command = starts[0].trimStart();
  let value;
  if (command.startsWith('"')) {
    let i = 1, out = '';
    for (; i < command.length && command[i] !== '"'; i++) {
      if (command[i] === '\\') { i++; if (i >= command.length) return null; }
      out += command[i];
    }
    if (command[i] !== '"') return null;
    value = out;
  } else value = command.split(/\s/, 1)[0];
  if (!value || /[%$\\\0\n\r]/.test(value) || !isAbsolute(value)) return null;
  return value;
}

function execStarts(text) {
  let section = '';
  const starts = [];
  for (const source of text.split('\n')) {
    const line = source.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (/^\[.*\]$/.test(line)) { section = line; continue; }
    if (section === '[Service]' && /^ExecStart\s*=/.test(line)) starts.push(line.replace(/^ExecStart\s*=/, ''));
  }
  return starts;
}

/**
 * Why the unit or another user drop-in makes the service's effective environment or
 * command ambiguous, or null. EnvironmentFile= overrides Environment= and
 * UnsetEnvironment= is applied last, so either could drop NODE_OPTIONS; an empty
 * Environment= resets earlier assignments. Diagnostics name only the directive and file.
 */
export function definitionConflict(text, otherDropIns = []) {
  const directives = source => {
    let section = '';
    const found = [];
    for (const raw of source.split('\n')) {
      const line = raw.trim();
      if (!line || /^[#;]/.test(line)) continue;
      if (/^\[.*\]$/.test(line)) { section = line; continue; }
      if (section !== '[Service]') continue;
      if (/^(EnvironmentFile|UnsetEnvironment|PassEnvironment)\s*=/.test(line)) found.push(line.split('=')[0].trim());
      else if (/^Environment\s*=\s*$/.test(line)) found.push('an empty Environment= reset');
    }
    return found;
  };
  const own = directives(text);
  if (own.length) return `uses ${own[0]}, which can change the service environment`;
  if (/NODE_OPTIONS/.test(text)) return 'already sets NODE_OPTIONS';
  for (const { name, text: dropIn } of otherDropIns) {
    const found = directives(dropIn);
    if (found.length) return `has drop-in ${name}, which uses ${found[0]}`;
    if (/NODE_OPTIONS/.test(dropIn)) return `has drop-in ${name}, which sets NODE_OPTIONS`;
    if (execStarts(dropIn).length) return `has drop-in ${name}, which overrides ExecStart`;
  }
  return null;
}

/**
 * The systemd user manager's unit search path, highest precedence first
 * (systemd.unit(5), "User Unit Search Path"), from the XDG variables or their defaults.
 */
export function systemdUserSearchPath(env, home, uid) {
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const dataHome = env.XDG_DATA_HOME || join(home, '.local/share');
  const list = value => value.split(':').filter(isAbsolute);
  return [
    join(configHome, 'systemd/user.control'), join(runtime, 'systemd/user.control'),
    join(runtime, 'systemd/transient'), join(runtime, 'systemd/generator.early'),
    join(configHome, 'systemd/user'), ...list(env.XDG_CONFIG_DIRS || '/etc/xdg').map(dir => join(dir, 'systemd/user')),
    '/etc/systemd/user', join(runtime, 'systemd/user'), '/run/systemd/user', join(runtime, 'systemd/generator'),
    join(dataHome, 'systemd/user'), ...list(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').map(dir => join(dir, 'systemd/user')),
    '/usr/local/lib/systemd/user', '/usr/lib/systemd/user', '/lib/systemd/user', join(runtime, 'systemd/generator.late'),
  ];
}

/** Drop-in directory names systemd applies to a unit: its own, each dash prefix, then the type-wide one. */
export function dropInDirectoryNames(unit) {
  const dot = unit.lastIndexOf('.');
  const stem = unit.slice(0, dot), type = unit.slice(dot + 1);
  const names = [`${unit}.d`];
  for (let i = stem.lastIndexOf('-', stem.length - 2); i > 0; i = stem.lastIndexOf('-', i - 1)) names.push(`${stem.slice(0, i + 1)}.${type}.d`);
  names.push(`${type}.d`);
  return names;
}

/**
 * Every fragment and drop-in systemd could load for a user unit, read without following
 * them into anything but their contents. Throws a reason when the effective definition is
 * ambiguous: a custom search path, a same-named fragment ahead of the installer's one, or a
 * drop-in that cannot be read. Returns the drop-ins other than the installer's own.
 */
export function systemdEffectiveDropIns({ env, home, uid, unit, fragment, ownDropIn }) {
  if (env.SYSTEMD_UNIT_PATH) throw new Error('SYSTEMD_UNIT_PATH replaces the systemd user unit search path');
  const path = systemdUserSearchPath(env, home, uid);
  const fragmentDir = fragment.slice(0, fragment.length - unit.length - 1);
  const position = path.indexOf(fragmentDir);
  if (position < 0) throw new Error(`${fragmentDir} is not in the systemd user unit search path`);
  for (const dir of path.slice(0, position)) {
    const shadow = join(dir, unit);
    if (exists(shadow)) throw new Error(`${shadow} takes precedence over ${fragment}`);
  }
  const dropIns = [];
  for (const dir of path) for (const name of dropInDirectoryNames(unit)) {
    const directory = join(dir, name);
    if (!existsSync(directory)) continue;
    let entries;
    try { entries = readdirSync(directory); } catch { throw new Error(`drop-in directory ${directory} cannot be read`); }
    for (const entry of entries.filter(entry => entry.endsWith('.conf')).sort()) {
      const file = join(directory, entry);
      if (file === ownDropIn) continue;
      try { dropIns.push({ name: file, text: readFileSync(file, 'utf8') }); } catch { throw new Error(`drop-in ${file} cannot be read`); }
    }
  }
  return dropIns;
}

const exists = path => { try { lstatSync(path); return true; } catch { return false; } };

/**
 * Runs only `<interpreter> -p process.versions.node` with argv and without NODE_OPTIONS.
 * Anything unparseable is unpatched; `version` is reported only when it parses safely.
 */
export async function inspectInterpreter(effects, interpreter) {
  if (interpreter === process.execPath) return { patched: true, version: process.versions.node };
  try {
    const result = await effects.run(interpreter, ['-p', 'process.versions.node'], { timeout: 10_000, env: { NODE_OPTIONS: '' } });
    const output = String(result.stdout ?? '').trim();
    return { patched: isSecureNodeVersion(output), version: /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,40})?$/.test(output) ? output : null };
  } catch { return { patched: false, version: null }; }
}

export async function interpreterIsPatched(effects, interpreter) {
  return (await inspectInterpreter(effects, interpreter)).patched;
}

export function interpreterRefusal(service, detail, path, outcome = 'Nothing was started or changed.') {
  return `Refusing to start ${service}: its service definition ${path} ${detail}. ${outcome} `
    + `Native services must run a patched Node.js (22.23.4+, 24.22.1+ or 26.12.1+; CVE-2026-111497: ${NODE_SECURITY_ADVISORY}). `
    + `Update that Node.js (${NODE_DOWNLOAD_URL}) or remove the definition so the installer registers it again, then run the Ours installer again.`;
}
