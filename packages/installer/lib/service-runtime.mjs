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

// The only plist forms the installer reads: the header, doctype and tags the published
// definitions use, written canonically (no whitespace or attributes inside tags beyond
// these exact forms), named entities only, and comments that are closed. Anything else
// refuses the definition before any change, so every key is found where launchd finds it.
const PLIST_TAGS = new Set(['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">', '</plist>', '<dict>', '</dict>', '<key>', '</key>', '<string>', '</string>', '<array>', '</array>', '<integer>', '</integer>', '<true/>', '<false/>']);
export function plistCanonical(text) {
  if (typeof text !== 'string') return false;
  const clean = text.replace(/<!--[\s\S]*?-->/g, '');
  if (clean.includes('<!--')) return false;
  const tags = clean.match(/<[^<>]*>/g) ?? [];
  if (!tags.every(tag => PLIST_TAGS.has(tag))) return false;
  const textOutsideTags = clean.replace(/<[^<>]*>/g, '');
  return !/[<>]/.test(textOutsideTags) && !/&(?!(?:amp|lt|gt|quot|apos);)/.test(textOutsideTags);
}

const decodeXml = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
const count = (text, part) => text.split(part).length - 1;
// Keys launchd reads from the root job dictionary; anywhere else they are not supported.
const JOB_KEYS = new Set(['Program', 'ProgramArguments', 'EnvironmentVariables', 'RootDirectory', 'NODE_OPTIONS']);

/**
 * The root launchd job of a canonical plist, parsed structurally: the single `<plist>`
 * value must be a dictionary, every dictionary has unique keys and one value per key,
 * values are strings, integers, booleans, arrays or dictionaries, and only whitespace and
 * closed comments separate them. ProgramArguments (a non-empty string array) and
 * EnvironmentVariables (a string dictionary) are taken from the root job only, and none of
 * the job keys may appear deeper. Returns { job } or { error }; nothing is executed.
 */
export function parsePlistJob(text) {
  if (!plistCanonical(text)) return { error: 'non-canonical syntax' };
  const tokens = [...text.matchAll(/<!--[\s\S]*?-->|<[^<>]*>|[^<]+/g)].map(m => ({ value: m[0], end: m.index + m[0].length }));
  if (tokens.map(t => t.value).join('') !== text) return { error: 'unrecognized content' };
  let i = 0;
  const fail = error => { throw Object.assign(new Error(error), { plist: true }); };
  const skip = () => { while (i < tokens.length && (tokens[i].value.startsWith('<!--') || (!tokens[i].value.startsWith('<') && !tokens[i].value.trim()))) i++; };
  const expect = tag => { if (tokens[i]?.value !== tag) fail(`expected ${tag}`); i++; };
  const content = () => (tokens[i] && !tokens[i].value.startsWith('<') ? decodeXml(tokens[i++].value) : '');
  const value = () => {
    skip();
    const tag = tokens[i]?.value;
    if (tag === '<string>') { i++; const v = content(); expect('</string>'); return { type: 'string', value: v }; }
    if (tag === '<integer>') { i++; const v = content(); expect('</integer>'); if (!/^-?\d+$/.test(v)) fail('invalid integer'); return { type: 'integer', value: v }; }
    if (tag === '<true/>' || tag === '<false/>') { i++; return { type: 'boolean', value: tag === '<true/>' }; }
    if (tag === '<array>') {
      i++; const items = [];
      for (;;) { skip(); if (tokens[i]?.value === '</array>') { i++; return { type: 'array', items }; } items.push(value()); }
    }
    if (tag === '<dict>') {
      const openEnd = tokens[i].end; i++; const entries = new Map();
      for (;;) {
        skip();
        if (tokens[i]?.value === '</dict>') { i++; return { type: 'dict', entries, openEnd }; }
        // Keys are taken literally: an entity in a key is not a supported form.
        expect('<key>'); if (tokens[i]?.value.includes('&')) fail('an entity in a key'); const key = content(); expect('</key>');
        if (!key || entries.has(key)) fail(key ? `repeated key ${key}` : 'empty key');
        entries.set(key, value());
      }
    }
    fail('unsupported value');
  };
  let root;
  try {
    skip();
    if (tokens[i]?.value.startsWith('<?xml')) { i++; skip(); }
    if (tokens[i]?.value.startsWith('<!DOCTYPE')) { i++; skip(); }
    expect('<plist version="1.0">');
    root = value();
    skip(); expect('</plist>'); skip();
    if (i !== tokens.length) fail('content after the plist');
    if (root.type !== 'dict') fail('the root is not a dictionary');
  } catch (error) {
    if (error?.plist) return { error: error.message };
    throw error;
  }
  // Below the root job, the job keys are not supported anywhere (except NODE_OPTIONS in its environment).
  const nested = (node, environment = false) => {
    if (node.type === 'array') return node.items.some(item => nested(item));
    if (node.type !== 'dict') return false;
    return [...node.entries].some(([key, child]) => (!environment && JOB_KEYS.has(key)) || nested(child));
  };
  for (const [key, child] of root.entries) if (nested(child, key === 'EnvironmentVariables')) return { error: `a launchd job key is nested under ${key}` };
  if (root.entries.has('NODE_OPTIONS')) return { error: 'NODE_OPTIONS is a root key' };
  const args = root.entries.get('ProgramArguments');
  if (!args || args.type !== 'array' || !args.items.length || args.items.some(item => item.type !== 'string')) return { error: 'ProgramArguments is not a non-empty list of strings' };
  const env = root.entries.get('EnvironmentVariables');
  if (env && (env.type !== 'dict' || [...env.entries.values()].some(item => item.type !== 'string'))) return { error: 'EnvironmentVariables is not a dictionary of strings' };
  return { job: {
    keys: new Set(root.entries.keys()),
    programArguments: args.items.map(item => item.value),
    environment: env ? [...env.entries].map(([key, item]) => [key, item.value]) : null,
    environmentOpenEnd: env?.openEnd ?? null,
  } };
}

/**
 * The root job's EnvironmentVariables as key/value pairs, or null when the plist is not
 * accepted by parsePlistJob, has no root EnvironmentVariables, or (as before) spells
 * `<key>EnvironmentVariables</key>` anywhere else, including inside a comment.
 */
export function plistEnvironment(text) {
  if (typeof text !== 'string' || text.includes('&#') || count(text, '<key>EnvironmentVariables</key>') !== 1) return null;
  return parsePlistJob(text).job?.environment ?? null;
}

/**
 * Whether a launchd plist carries the installer's guard: 'present' only when the root job's
 * EnvironmentVariables has exactly one NODE_OPTIONS holding exactly the guard and
 * NODE_OPTIONS appears nowhere else, including comments; 'absent' when NODE_OPTIONS appears
 * nowhere; otherwise 'conflict', including every plist that plistEnvironment does not accept.
 */
export function plistGuardState(text, guardPath) {
  const environment = plistEnvironment(text);
  if (environment === null) return 'conflict';
  const mentions = count(text, 'NODE_OPTIONS');
  if (mentions === 0) return 'absent';
  const options = environment.filter(([key]) => key === 'NODE_OPTIONS');
  return mentions === 1 && options.length === 1 && options[0][1] === guardNodeOptions(guardPath) ? 'present' : 'conflict';
}

/** Adds the guard to the root job's EnvironmentVariables dictionary, or returns null. */
export function plistWithGuard(text, guardPath) {
  const state = plistGuardState(text, guardPath);
  if (state === 'present') return text;
  if (state !== 'absent') return null;
  const at = parsePlistJob(text).job.environmentOpenEnd;
  const entry = `<key>NODE_OPTIONS</key><string>${guardNodeOptions(guardPath).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}</string>`;
  return text.slice(0, at) + entry + text.slice(at);
}

/**
 * Why a launchd plist runs something other than its root job's first ProgramArguments entry,
 * or null. The plist must be canonical and structurally a single root job; Program takes
 * precedence over ProgramArguments[0] and RootDirectory changes what every path names, so
 * neither is interpreted and either refuses.
 */
export function plistExecutableConflict(text) {
  if (typeof text !== 'string' || text.includes('&#')) return 'uses a numeric character reference';
  if (!plistCanonical(text)) return 'uses plist syntax the installer does not read (only the canonical tags of published definitions are accepted)';
  const parsed = parsePlistJob(text);
  if (parsed.error) return `has a plist structure the installer does not read (${parsed.error})`;
  for (const key of ['Program', 'RootDirectory']) if (parsed.job.keys.has(key)) return `sets ${key}, which changes the program launchd runs`;
  return null;
}

/** The interpreter (first program argument) of a systemd unit or launchd plist, or null. Text only; nothing is executed. */
export function recordedInterpreter(text, platform) {
  if (typeof text !== 'string') return null;
  if (platform === 'darwin') {
    if (plistExecutableConflict(text) || count(text, '<key>ProgramArguments</key>') !== 1) return null;
    const value = parsePlistJob(text).job.programArguments[0];
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

/**
 * systemd's logical lines (systemd.syntax(7)): a trailing backslash joins the next line with
 * a space, and comment lines inside a continuation are skipped. Returns [section, line] pairs.
 */
function logicalLines(text) {
  const result = [];
  let section = '', pending = null;
  for (const source of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = source.trim();
    if (pending !== null && /^[#;]/.test(line)) continue;
    if (pending === null && (!line || /^[#;]/.test(line))) continue;
    const joined = pending === null ? line : `${pending} ${line}`;
    if (joined.endsWith('\\')) { pending = joined.slice(0, -1).trimEnd(); continue; }
    pending = null;
    if (/^\[.*\]$/.test(joined)) { section = joined; continue; }
    result.push([section, joined]);
  }
  if (pending !== null) result.push([section, pending]);
  return result;
}

function execStarts(text) {
  return logicalLines(text).filter(([section, line]) => section === '[Service]' && /^ExecStart\s*=/.test(line)).map(([, line]) => line.replace(/^ExecStart\s*=/, ''));
}

/**
 * Why the unit or another user drop-in makes the service's effective environment or
 * command ambiguous, or null. EnvironmentFile= overrides Environment= and
 * UnsetEnvironment= is applied last, so either could drop NODE_OPTIONS; an empty
 * Environment= resets earlier assignments. Diagnostics name only the directive and file.
 */
export function definitionConflict(text, otherDropIns = []) {
  // Environment= values are C-unquoted and %-expanded by systemd; any escape or specifier could
  // spell NODE_OPTIONS or reset it, so those forms are refused rather than interpreted.
  const directives = source => {
    const found = [];
    for (const [section, line] of logicalLines(source)) {
      if (section !== '[Service]') continue;
      // RootDirectory= and RootImage= change which executable every path names.
      if (/^(EnvironmentFile|UnsetEnvironment|PassEnvironment|RootDirectory|RootImage)\s*=/.test(line)) found.push(line.split('=')[0].trim());
      else if (/^Environment\s*=/.test(line)) {
        const value = line.replace(/^Environment\s*=/, '');
        if (!value.replace(/["'\s]/g, '')) found.push('an empty Environment= reset');
        else if (value.includes('\\')) found.push('an escaped Environment= value');
        else if (value.replaceAll('%%', '').includes('%')) found.push('a specifier in an Environment= value');
      }
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
