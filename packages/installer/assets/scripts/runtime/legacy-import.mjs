/** Import a stopped, read-only host migration stage into the managed Docker volume. */
import * as fs from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
// Repository layout and the maintenance image intentionally place this binding differently.
const nativeModule = new URL('../maintenance/state-native.mjs', import.meta.url);
const { publishNoReplace } = await import(fs.existsSync(nativeModule) ? nativeModule.href : new URL('./state-native.mjs', import.meta.url).href);

const MARKER = '.ours-legacy-import.json';
const COMPONENTS = ['mcp', 'daemon'];
const fail = message => { throw Error(`Legacy volume import: ${message}`); };
function canonical(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('paths must be normalized absolute paths');
  if (fs.realpathSync(path) !== path) fail('symlink paths are not supported');
}
function privateEntry(path, uid, gid, directory) {
  const stat = fs.lstatSync(path);
  if (!(directory ? stat.isDirectory() : stat.isFile()) || stat.isSymbolicLink()
    || stat.uid !== uid || stat.gid !== gid
    || (directory ? (stat.mode & 0o7777) !== 0o700 : ((stat.mode & 0o7077) !== 0 || !(stat.mode & 0o400)))
    || (!directory && stat.nlink !== 1)) fail('unsafe ownership, permissions, or linked state entry');
  return stat;
}
function scan(root, uid, gid) {
  const entries = [];
  function visit(path, relative) {
    const stat = fs.lstatSync(path), directory = stat.isDirectory();
    privateEntry(path, uid, gid, directory); entries.push({ relative, directory, mode: stat.mode & 0o700 });
    if (directory) for (const name of fs.readdirSync(path).sort()) visit(join(path, name), relative ? join(relative, name) : name);
  }
  canonical(root); visit(root, ''); return entries;
}
function readReceipt(root, uid, gid, targetRoot) {
  privateEntry(join(root, MARKER), uid, gid, false);
  const value = JSON.parse(fs.readFileSync(join(root, MARKER), 'utf8'));
  const keys = ['sourceStateDir', 'sourceConfigPath', 'targetRoot', 'rootName'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')
    || keys.some(key => typeof value[key] !== 'string' || !value[key])
    || value.targetRoot !== targetRoot
    || ['sourceStateDir', 'sourceConfigPath', 'targetRoot'].some(key => !isAbsolute(value[key]) || resolve(value[key]) !== value[key])) fail('invalid or mismatched migration receipt');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function existingDestination(path, expected, uid, gid, targetRoot) {
  if (!fs.existsSync(path)) return false;
  canonical(path); privateEntry(path, uid, gid, true);
  if (!fs.readdirSync(path).length) return false;
  if (!fs.existsSync(join(path, MARKER)) || !same(readReceipt(path, uid, gid, targetRoot), expected)) fail('nonmatching existing destination');
  return true;
}
function makeDirectory(path, uid, gid) {
  if (!fs.existsSync(path)) { fs.mkdirSync(path, { mode: 0o700 }); fs.chownSync(path, uid, gid); }
  canonical(path); privateEntry(path, uid, gid, true);
}

/** Caller holds installation exclusion and has stopped all destination writers. */
export function importLegacyVolume({ sourceRoot = '/legacy-import', storageRoot = '/storage', targetRoot, uid, gid }) {
  if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) fail('numeric target UID/GID required');
  if (typeof targetRoot !== 'string' || !isAbsolute(targetRoot) || resolve(targetRoot) !== targetRoot) fail('expected target root required');
  canonical(sourceRoot); canonical(storageRoot);
  const sourceOwner = fs.lstatSync(sourceRoot);
  privateEntry(sourceRoot, sourceOwner.uid, sourceOwner.gid, true);
  const sources = COMPONENTS.map(component => {
    const path = join(sourceRoot, component);
    const entries = scan(path, sourceOwner.uid, sourceOwner.gid);
    return { component, path, entries, receipt: readReceipt(path, sourceOwner.uid, sourceOwner.gid, targetRoot) };
  });
  if (!same(sources[0].receipt, sources[1].receipt)) fail('source daemon and MCP receipts differ');
  const rootStat = fs.lstatSync(storageRoot);
  const freshRoot = rootStat.isDirectory() && rootStat.uid === 0 && rootStat.gid === 0 && fs.readdirSync(storageRoot).length === 0;
  if (!freshRoot) privateEntry(storageRoot, uid, gid, true);
  const state = join(storageRoot, 'state');
  if (fs.existsSync(state)) { canonical(state); privateEntry(state, uid, gid, true); }
  // Validate every existing destination before changing even an empty volume.
  for (const source of sources) source.reused = existingDestination(join(state, source.component), source.receipt, uid, gid, targetRoot);
  if (freshRoot) { fs.chmodSync(storageRoot, 0o700); fs.chownSync(storageRoot, uid, gid); }
  makeDirectory(state, uid, gid);
  for (const source of sources) {
    if (source.reused) continue;
    const destination = join(state, source.component), staging = join(state, `.legacy-import-${randomUUID()}`);
    try {
      fs.cpSync(source.path, staging, { recursive: true, errorOnExist: true, force: false });
      for (const entry of [...source.entries].reverse()) {
        const path = entry.relative ? join(staging, entry.relative) : staging;
        fs.chmodSync(path, entry.mode); fs.chownSync(path, uid, gid);
      }
      scan(staging, uid, gid);
      if (!same(readReceipt(staging, uid, gid, targetRoot), source.receipt)) fail('copied receipt changed');
      if (fs.existsSync(destination)) fs.rmdirSync(destination); // empty skeleton only
      publishNoReplace(staging, destination);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  return { imported: sources.filter(source => !source.reused).map(source => source.component), retained: sources.filter(source => source.reused).map(source => source.component) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    importLegacyVolume({ targetRoot: process.env.OURS_LEGACY_TARGET_ROOT, uid: Number(process.env.OURS_UID), gid: Number(process.env.OURS_GID) });
    console.log('Legacy daemon and MCP state imported into the selected volume.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
