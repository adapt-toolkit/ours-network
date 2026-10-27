import { isAbsolute } from 'node:path';
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

/** Adds the guard to a launchd plist's single EnvironmentVariables dictionary, or returns null. */
export function plistWithGuard(text, guardPath) {
  if (typeof text !== 'string' || text.includes('NODE_OPTIONS')) return null;
  const clean = text.replace(/<!--[\s\S]*?-->/g, '');
  if ((clean.match(/<key>EnvironmentVariables<\/key>/g) ?? []).length !== 1) return null;
  const anchor = /<key>EnvironmentVariables<\/key>(\s*)<dict>/;
  if (!anchor.test(text)) return null;
  const entry = `<key>NODE_OPTIONS</key><string>${guardNodeOptions(guardPath).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}</string>`;
  return text.replace(anchor, (match) => `${match}${entry}`);
}

/** The interpreter (first program argument) of a systemd unit or launchd plist, or null. Text only; nothing is executed. */
export function recordedInterpreter(text, platform) {
  if (typeof text !== 'string') return null;
  if (platform === 'darwin') {
    const clean = text.replace(/<!--[\s\S]*?-->/g, '');
    const lists = [...clean.matchAll(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/g)];
    if (lists.length !== 1) return null;
    const value = lists[0][1].replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
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
  if (/NODE_OPTIONS/.test(text)) return 'already sets NODE_OPTIONS';
  const own = directives(text);
  if (own.length) return `uses ${own[0]}, which can change the service environment`;
  for (const { name, text: dropIn } of otherDropIns) {
    if (/NODE_OPTIONS/.test(dropIn)) return `has drop-in ${name}, which sets NODE_OPTIONS`;
    if (execStarts(dropIn).length) return `has drop-in ${name}, which overrides ExecStart`;
    const found = directives(dropIn);
    if (found.length) return `has drop-in ${name}, which uses ${found[0]}`;
  }
  return null;
}

/** Runs only `<interpreter> -p process.versions.node` with argv; anything unparseable is unpatched. */
export async function interpreterIsPatched(effects, interpreter) {
  if (interpreter === process.execPath) return true;
  try {
    const result = await effects.run(interpreter, ['-p', 'process.versions.node'], { timeout: 10_000, env: { NODE_OPTIONS: '' } });
    return isSecureNodeVersion(String(result.stdout ?? '').trim());
  } catch { return false; }
}

export function interpreterRefusal(service, detail, path) {
  return `Refusing to start ${service}: its service definition ${path} ${detail}. Nothing was started or changed. `
    + `Native services must run a patched Node.js (22.23.4+, 24.22.1+ or 26.12.1+; CVE-2026-111497: ${NODE_SECURITY_ADVISORY}). `
    + `Update Node.js (${NODE_DOWNLOAD_URL}), then run the Ours installer again.`;
}
