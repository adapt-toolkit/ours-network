import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { NODE_DOWNLOAD_URL, NODE_SECURITY_ADVISORY, NODE_SECURITY_REQUIREMENT } from './security-versions.mjs';

// Native services run the Node.js their definition records. At every installer-controlled
// start, each selected service is first admitted without changing anything; then it is
// registered again through its own install-service command on this installer's verified
// Node.js (process.execPath), the definition the service manager has loaded is refreshed,
// and only then is the service started. Not covered: a restart by systemd or launchd itself
// after the Node.js at a recorded path was replaced by an unpatched release. The next
// installer start registers the service on a verified Node.js again.

/**
 * Package versions whose generated service definitions were reviewed. Each writes
 * [process.execPath, its own CLI, serve, ...] and reloads its job; any other version is refused.
 */
export const SERVICE_RECIPES = Object.freeze({
  daemon: { name: '@ours.network/daemon', versions: ['5.0.0', '4.1.1-nightly.4'] },
  telegram: { name: '@ours.network/tg-connector', versions: ['2.0.0', '1.0.1-nightly.16'] },
  cowork: { name: '@ours.network/cowork', versions: ['2.0.0', '1.3.4-nightly.20261019.b0d73c0'] },
});

// Paths and values every recipe records verbatim: no whitespace, quotes, backslashes, `%`
// specifiers or `$` substitutions, which systemd would split or expand in a command line.
const SAFE_PATH = /^\/[A-Za-z0-9._/+@:,-]*$/;
const SAFE_VALUE = /^[A-Za-z0-9._/+@:,-]*$/;
const SUPPORTED = 'letters, digits and . _ / + @ : , -';

/**
 * The CLI an installed package's bin link runs, when the package is one of the reviewed
 * recipes: { cliPath } or { error }. Only package.json is read; nothing is executed.
 */
export function packageRecipe(service, binPath, modulesRoot) {
  const recipe = SERVICE_RECIPES[service];
  let cliPath;
  try { cliPath = realpathSync(binPath); } catch { return { error: `has no installed ${recipe.name} command` }; }
  if (!cliPath.startsWith(realpathSync(modulesRoot) + sep) || !lstatSync(cliPath).isFile()) return { error: `runs ${recipe.name} from outside this installation` };
  for (let dir = dirname(cliPath); dir.startsWith(realpathSync(modulesRoot) + sep); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    let pkg;
    try { pkg = JSON.parse(readFileSync(manifest, 'utf8')); } catch { return { error: `has an unreadable ${recipe.name} package.json` }; }
    if (pkg.name !== recipe.name) continue;
    if (!recipe.versions.includes(pkg.version)) return { error: `would be registered by ${recipe.name} ${typeof pkg.version === 'string' ? pkg.version.slice(0, 40) : 'of an unknown version'}, whose service definition this installer has not reviewed (update the component through the installer)` };
    return { cliPath };
  }
  return { error: `runs a command that is not part of ${recipe.name}` };
}

/** Why a value the new definition would record cannot be recorded unchanged, or null. */
export function renderedProblem({ execPath, cliPath, environment = {} }) {
  if (!SAFE_PATH.test(execPath)) return `would record a Node.js path that a service definition cannot hold unchanged (supported: ${SUPPORTED})`;
  if (!SAFE_PATH.test(cliPath)) return `would record a command path that a service definition cannot hold unchanged (supported: ${SUPPORTED})`;
  for (const [key, value] of Object.entries(environment)) {
    if (!SAFE_VALUE.test(String(value))) return `would record a ${key} value that its unquoted definition cannot hold unchanged (supported: ${SUPPORTED})`;
  }
  return null;
}

// The keys the reviewed recipes and the installer's Messenger write; any other key refuses.
const UNIT_KEYS = { '[Unit]': ['Description', 'After', 'Wants', 'StartLimitIntervalSec'], '[Service]': ['Type', 'ExecStart', 'Environment', 'Restart', 'RestartSec'], '[Install]': ['WantedBy'] };
const PLIST_KEYS = new Set(['Label', 'ProgramArguments', 'EnvironmentVariables', 'RunAtLoad', 'KeepAlive', 'StandardOutPath', 'StandardErrorPath']);

/**
 * A definition in the bounded recipe form: { interpreter } (the program it starts) or
 * { error }. systemd units have only the recipe sections and keys, one ExecStart without a
 * prefix, continuation, specifier or substitution; plists are canonical with only the recipe
 * root keys and the expected Label. Text only; nothing is executed.
 */
export function definitionRecipe(text, platform, name) {
  if (platform === 'darwin') {
    const { job, error } = parsePlistJob(text);
    if (error) return { error: `is not a supported launchd definition (${error})` };
    const other = [...job.keys].find(key => !PLIST_KEYS.has(key));
    if (other) return { error: `uses the launchd key ${other.slice(0, 40)}, which this installer does not support` };
    if (job.label !== name) return { error: 'has a different launchd Label' };
    return isAbsolute(job.programArguments[0]) ? { interpreter: job.programArguments[0] } : { error: 'does not start an absolute program path' };
  }
  let section = null;
  const starts = [];
  for (const source of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = source.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.endsWith('\\')) return { error: 'continues a line with a backslash' };
    if (/^\[.*\]$/.test(line)) {
      if (!UNIT_KEYS[line]) return { error: `has the section ${line.slice(0, 40)}, which this installer does not support` };
      section = line;
      continue;
    }
    const key = /^([A-Za-z]+)\s*=/.exec(line)?.[1];
    if (!section || !UNIT_KEYS[section].includes(key)) return { error: `uses ${key ? `${key}=` : 'a line'} ${section ? `in ${section}` : 'outside a section'}, which this installer does not support` };
    if (key === 'Type' && line.replace(/^Type\s*=\s*/, '') !== 'simple') return { error: 'is not Type=simple' };
    if (key === 'ExecStart') starts.push(line.replace(/^ExecStart\s*=\s*/, ''));
  }
  if (starts.length !== 1) return { error: 'does not have exactly one ExecStart' };
  const command = starts[0];
  if (/[%$\\]/.test(command)) return { error: 'has an ExecStart with a specifier, substitution or escape' };
  const program = command.startsWith('"') ? /^"([^"]*)"(?:\s|$)/.exec(command)?.[1] : command.split(/\s/, 1)[0];
  return program && isAbsolute(program) ? { interpreter: program } : { error: 'does not start an absolute program path (or uses an ExecStart prefix)' };
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

const exists = path => { try { lstatSync(path); return true; } catch { return false; } };

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

// The [Service] settings that choose the main command or the root its paths are resolved in.
const RUNTIME_KEYS = ['ExecStart', 'RootDirectory', 'RootImage'];

/**
 * Why a drop-in or another unit systemd would load could change which program the unit's
 * main command runs, or null: a replaced search path, a linked or template unit, a same-named
 * unit with higher precedence, or a drop-in (its own, dash-prefix or type-wide, anywhere on
 * the search path) that assigns ExecStart (even empty) or a RootDirectory or RootImage value. Other drop-ins,
 * such as distribution policy, are accepted and never changed. Nothing is executed.
 */
export function systemdOverrideProblem({ env, home, uid, unit, fragment }) {
  if (env.SYSTEMD_UNIT_PATH) return 'cannot be qualified: SYSTEMD_UNIT_PATH replaces the systemd user unit search path';
  if (unit.includes('@')) return 'is a template unit, which this installer does not support';
  const path = systemdUserSearchPath(env, home, uid);
  const position = path.indexOf(dirname(fragment));
  if (position < 0) return `cannot be qualified: ${dirname(fragment)} is not in the systemd user unit search path`;
  if (exists(fragment) && lstatSync(fragment).isSymbolicLink()) return 'is a link, which this installer does not support';
  for (const dir of path.slice(0, position)) if (exists(join(dir, unit))) return `cannot be qualified: ${join(dir, unit)} takes precedence over it`;
  for (const dir of path) for (const name of dropInDirectoryNames(unit)) {
    const directory = join(dir, name);
    if (!exists(directory)) continue;
    let entries;
    try { entries = readdirSync(directory).filter(entry => entry.endsWith('.conf')); } catch { return `cannot be qualified: the drop-in directory ${directory} cannot be read`; }
    for (const entry of entries) {
      let text;
      try { text = readFileSync(join(directory, entry), 'utf8'); } catch { return `cannot be qualified: the drop-in ${join(directory, entry)} cannot be read`; }
      for (const [section, line] of logicalLines(text)) {
        const [, key, value] = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line) ?? [];
        // Any ExecStart assignment replaces or clears the main command; an empty root reset does not change it.
        if (section === '[Service]' && RUNTIME_KEYS.includes(key) && (key === 'ExecStart' || value)) return `has the drop-in ${join(directory, entry)}, which sets ${key}= and so could change which program it runs`;
      }
    }
  }
  return null;
}

/**
 * The main command the systemd user manager reports for a unit, from the complete output of
 * `systemctl --user show <unit> -p ExecStart -p RootDirectory -p RootImage`: { program } when
 * there is exactly one ExecStart record whose path is argv[0] and both root settings are
 * empty, otherwise { error }. Any other shape is unverifiable.
 */
export function managerMainCommand(output) {
  const properties = new Map();
  for (const line of String(output).split('\n').filter(Boolean)) {
    const [, key, value] = /^(ExecStart|RootDirectory|RootImage)=(.*)$/.exec(line) ?? [];
    if (!key || properties.has(key)) return { error: 'could not be verified from the service manager' };
    properties.set(key, value);
  }
  if (properties.size !== 3) return { error: 'could not be verified from the service manager' };
  if (properties.get('RootDirectory') || properties.get('RootImage')) return { error: 'runs in another root directory or image' };
  const record = /^\{ path=([^ ;]+) ; argv\[\]=([^ ;]+)(?: [^;]*)? ; [^{}]*\}$/.exec(properties.get('ExecStart'));
  if (!record || record[1] !== record[2]) return { error: 'could not be verified from the service manager' };
  return { program: record[1] };
}

export function serviceRefusal(service, path, detail, outcome = 'Nothing was registered, started or changed.') {
  return `Refusing to start ${service}: its service definition ${path} ${detail}. ${outcome} `
    + `Native services are registered only in their reviewed definition form, on the installer's own patched Node.js (${NODE_SECURITY_REQUIREMENT}; CVE-2026-111497: ${NODE_SECURITY_ADVISORY}; ${NODE_DOWNLOAD_URL}).`;
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

/**
 * The root launchd job of a canonical plist, parsed structurally: the single `<plist>`
 * value must be a dictionary, every dictionary has unique keys and one value per key,
 * values are strings, integers, booleans, arrays or dictionaries, and only whitespace and
 * closed comments separate them. ProgramArguments must be a non-empty string array and
 * Label a string. Returns { job } or { error }; nothing is executed.
 */
export function parsePlistJob(text) {
  if (!plistCanonical(text)) return { error: 'non-canonical syntax' };
  const tokens = [...text.matchAll(/<!--[\s\S]*?-->|<[^<>]*>|[^<]+/g)].map(m => m[0]);
  if (tokens.join('') !== text) return { error: 'unrecognized content' };
  let i = 0;
  const fail = error => { throw Object.assign(new Error(error), { plist: true }); };
  const skip = () => { while (i < tokens.length && (tokens[i].startsWith('<!--') || (!tokens[i].startsWith('<') && !tokens[i].trim()))) i++; };
  const expect = tag => { if (tokens[i] !== tag) fail(`expected ${tag}`); i++; };
  const content = () => (tokens[i] && !tokens[i].startsWith('<') ? decodeXml(tokens[i++]) : '');
  const value = () => {
    skip();
    const tag = tokens[i];
    if (tag === '<string>') { i++; const v = content(); expect('</string>'); return { type: 'string', value: v }; }
    if (tag === '<integer>') { i++; const v = content(); expect('</integer>'); if (!/^-?\d+$/.test(v)) fail('invalid integer'); return { type: 'integer', value: v }; }
    if (tag === '<true/>' || tag === '<false/>') { i++; return { type: 'boolean', value: tag === '<true/>' }; }
    if (tag === '<array>') {
      i++; const items = [];
      for (;;) { skip(); if (tokens[i] === '</array>') { i++; return { type: 'array', items }; } items.push(value()); }
    }
    if (tag === '<dict>') {
      i++; const entries = new Map();
      for (;;) {
        skip();
        if (tokens[i] === '</dict>') { i++; return { type: 'dict', entries }; }
        // Keys are taken literally: an entity in a key is not a supported form.
        expect('<key>'); if (tokens[i]?.includes('&')) fail('an entity in a key'); const key = content(); expect('</key>');
        if (!key || entries.has(key)) fail(key ? `repeated key ${key.slice(0, 40)}` : 'empty key');
        entries.set(key, value());
      }
    }
    fail('unsupported value');
  };
  let root;
  try {
    skip();
    if (tokens[i]?.startsWith('<?xml')) { i++; skip(); }
    if (tokens[i]?.startsWith('<!DOCTYPE')) { i++; skip(); }
    expect('<plist version="1.0">');
    root = value();
    skip(); expect('</plist>'); skip();
    if (i !== tokens.length) fail('content after the plist');
    if (root.type !== 'dict') fail('the root is not a dictionary');
  } catch (error) {
    if (error?.plist) return { error: error.message };
    throw error;
  }
  const args = root.entries.get('ProgramArguments');
  if (!args || args.type !== 'array' || !args.items.length || args.items.some(item => item.type !== 'string')) return { error: 'ProgramArguments is not a non-empty list of strings' };
  const label = root.entries.get('Label');
  return { job: { keys: new Set(root.entries.keys()), label: label?.type === 'string' ? label.value : null, programArguments: args.items.map(item => item.value) } };
}
