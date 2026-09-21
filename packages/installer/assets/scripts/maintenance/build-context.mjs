/** Verified installer vendor bindings. Context hashes are consistency, not signatures. */
import * as fs from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { semanticRecordEqual } from './provenance-compare.mjs';

export const BASE_RECORDS = ['package-lock.json', 'dependency-tree.json'];
export const CONTEXT = 'build-context.json';
const admitted = new WeakMap();
const packages = new Set(['sdk', 'cli', 'daemon', 'mcp', 'tg-connector', 'cowork', 'messenger-server', 'fleet', 'codex', 'claude-code', 'install'].map(n => '@ours.network/' + n));
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const fail = text => { throw new Error(`Build context: ${text}`); };
const keys = (v, expected) => v && !Array.isArray(v) && typeof v === 'object' && Object.keys(v).sort().join('\0') === [...expected].sort().join('\0');
const vendorPath = name => `docker/vendor/ours.network-${name.slice('@ours.network/'.length)}.tgz`;
const exists = path => { try { fs.lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export const recordNames = records => Object.hasOwn(records, CONTEXT) ? [...BASE_RECORDS, CONTEXT] : [...BASE_RECORDS];

function view(records) {
  if (!keys(records, recordNames(records)) || !Object.values(records).every(Buffer.isBuffer)) fail('invalid record set');
  if (!Object.hasOwn(records, CONTEXT)) return null;
  const bytes = records[CONTEXT];
  let c, lock, tree;
  try { c = JSON.parse(bytes); lock = JSON.parse(records[BASE_RECORDS[0]]); tree = JSON.parse(records[BASE_RECORDS[1]]); }
  catch { fail('invalid JSON'); }
  // The creator owns this encoding: reject duplicate keys and alternate ambiguous JSON.
  if (!bytes.equals(Buffer.from(JSON.stringify(c, null, 2) + '\n'))) fail('noncanonical context JSON');
  for (const name of BASE_RECORDS) {
    if (!semanticRecordEqual(name, records[name], Buffer.concat([records[name], Buffer.from('\n')]))) fail('unsupported build record shape');
  }
  if (!keys(c, ['schema', 'buildRoot', 'records', 'vendors']) || c.schema !== 1) fail('unsupported schema');
  if (typeof c.buildRoot !== 'string' || !isAbsolute(c.buildRoot) || resolve(c.buildRoot) !== c.buildRoot || c.buildRoot.includes('\0')) fail('invalid build root');
  if (!keys(c.records, BASE_RECORDS)) fail('invalid record digests');
  for (const name of BASE_RECORDS) if (c.records[name] !== digest(records[name])) fail('record digest mismatch');
  if (!Array.isArray(c.vendors) || !c.vendors.length) fail('missing vendor bindings');
  const names = c.vendors.map(v => v?.name);
  if (new Set(names).size !== names.length || names.join('\0') !== [...names].sort().join('\0')) fail('noncanonical vendor set');
  const deps = lock?.packages?.['']?.dependencies;
  if (lock.lockfileVersion !== 3 || !keys(deps, names) || !keys(tree.dependencies, names)) fail('vendor selection differs from records');
  for (const v of c.vendors) {
    if (!keys(v, ['name', 'version', 'relativePath', 'integrity']) || !packages.has(v.name) || v.relativePath !== vendorPath(v.name)) fail('invalid vendor binding');
    if (typeof v.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(v.integrity)) fail('invalid vendor version/integrity');
    const entry = lock.packages['node_modules/' + v.name], node = tree.dependencies[v.name];
    if (!entry || entry.version !== v.version || entry.integrity !== v.integrity || entry.resolved !== 'file:' + v.relativePath || deps[v.name] !== 'file:' + v.relativePath || entry.link) fail('vendor lock binding mismatch');
    if (!node || node.version !== v.version || node.resolved !== 'file:' + join(c.buildRoot, v.relativePath)) fail('vendor tree binding mismatch');
    node.resolved = 'file:' + v.relativePath;
  }
  return { vendors: c.vendors, tree: Buffer.from(JSON.stringify(tree)) };
}

export function validateBuildRecordSet(records) { view(records); }

function safeFile(path, privateFile = false) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || ![process.getuid(), 0].includes(st.uid) || (st.mode & 0o7022) || (privateFile && (st.uid !== process.getuid() || st.gid !== process.getgid() || (st.mode & 0o777) !== 0o600))) fail('unsafe regular file ownership/permissions');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Only protected filesystem records enter the comparison API. Missing context is legacy. */
export function readBuildRecords(directory, { privateFiles = false, marker = false } = {}) {
  const st = fs.lstatSync(directory);
  if (!st.isDirectory() || fs.realpathSync(directory) !== directory || ![process.getuid(), 0].includes(st.uid) || (st.mode & 0o7022)) fail('unsafe record directory');
  const names = [...BASE_RECORDS, ...(exists(join(directory, CONTEXT)) ? [CONTEXT] : [])];
  if (marker && fs.readdirSync(directory).sort().join('\0') !== [...names].sort().join('\0')) fail('mixed or incomplete marker records');
  const records = Object.fromEntries(names.map(name => [name, safeFile(join(directory, name), privateFiles)]));
  const normalized = view(records);
  // Snapshot privately as well as exposing buffers: caller mutation never alters admitted evidence.
  const handle = {};
  for (const [name, bytes] of Object.entries(records)) Object.defineProperty(handle, name, { enumerable: true, get: () => Buffer.from(bytes) });
  admitted.set(handle, { records, normalized });
  return Object.freeze(handle);
}

export function equalBuildRecords(a, b) {
  const x = admitted.get(a), y = admitted.get(b);
  if (!x || !y) fail('comparison requires verified record handles');
  if (!semanticRecordEqual(BASE_RECORDS[0], x.records[BASE_RECORDS[0]], y.records[BASE_RECORDS[0]])) return false;
  if (x.normalized && y.normalized) {
    if (JSON.stringify(x.normalized.vendors) !== JSON.stringify(y.normalized.vendors)) return false;
    return semanticRecordEqual(BASE_RECORDS[1], x.normalized.tree, y.normalized.tree);
  }
  // No one-sided normalization/adoption of historic records.
  return semanticRecordEqual(BASE_RECORDS[1], x.records[BASE_RECORDS[1]], y.records[BASE_RECORDS[1]]);
}

export function createBuildContext(root) {
  if (fs.realpathSync(root) !== root || resolve(root) !== root) fail('build root must be canonical');
  const destination = join(root, CONTEXT);
  if (exists(destination)) fail('context already exists; never regenerate historic evidence');
  const records = readBuildRecords(root);
  const lock = JSON.parse(records['package-lock.json']);
  const deps = lock?.packages?.['']?.dependencies;
  if (!deps || Array.isArray(deps) || typeof deps !== 'object') fail('missing vendor dependencies');
  const manifest = JSON.parse(safeFile(join(root, 'package.json')));
  if (manifest.name !== lock.name || manifest.version !== lock.version || !keys(manifest.dependencies, Object.keys(deps)) || Object.keys(deps).some(n => manifest.dependencies[n] !== deps[n])) fail('runtime manifest differs from lock selection');
  const vendors = [];
  for (const name of Object.keys(deps).sort()) {
    if (!packages.has(name)) fail('unknown vendor package');
    const relativePath = vendorPath(name), path = join(root, relativePath);
    let part = root;
    for (const component of relativePath.split('/')) {
      part = join(part, component); const st = fs.lstatSync(part);
      if (st.isSymbolicLink() || ![process.getuid(), 0].includes(st.uid) || fs.realpathSync(part) !== part || (st.mode & 0o7022)) fail('vendor path is not canonical or is writable by others');
    }
    if (relative(root, path).startsWith('..')) fail('vendor path escaped root');
    const bytes = safeFile(path), integrity = 'sha512-' + digest(bytes, 'sha512', 'base64');
    const entry = lock.packages['node_modules/' + name];
    if (!entry || entry.integrity !== integrity) fail('tar integrity mismatch');
    const before = fs.statSync(path);
    const metadata = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json', path], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const after = fs.statSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || !safeFile(path).equals(bytes)) fail('tar changed during verification');
    if (metadata.length !== 1 || metadata[0].name !== name || metadata[0].version !== entry.version) fail('tar package identity mismatch');
    vendors.push({ name, version: entry.version, relativePath, integrity });
  }
  const context = { schema: 1, buildRoot: root, records: Object.fromEntries(BASE_RECORDS.map(n => [n, digest(records[n])])), vendors };
  const bytes = Buffer.from(JSON.stringify(context, null, 2) + '\n');
  view({ ...records, [CONTEXT]: bytes });
  for (const name of BASE_RECORDS) if (!safeFile(join(root, name)).equals(records[name])) fail('records changed during verification');
  const sync = path => { const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  for (const name of BASE_RECORDS) sync(join(root, name));
  const temp = join(root, '.' + CONTEXT + '-' + randomUUID());
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    sync(temp);
    // link publishes atomically without replacement; unlink the private temp immediately.
    fs.linkSync(temp, destination);
  } finally { if (exists(temp)) fs.unlinkSync(temp); }
  sync(root);
  return readBuildRecords(root);
}

/** Fresh marker publication only; an existing generation requires explicit maintenance. */
export function initializeBuildMarker(marker, records) {
  const selected = admitted.get(records);
  if (!selected) fail('marker initialization requires verified record handles');
  if (exists(marker) && fs.readdirSync(marker).length) {
    const current = readBuildRecords(marker, { privateFiles: true, marker: true });
    if (recordNames(current).length !== recordNames(records).length || recordNames(records).some(n => !current[n].equals(records[n]))) fail('existing state provenance differs; use reviewed update --compatible');
    return;
  }
  const parent = resolve(marker, '..');
  const st = fs.lstatSync(parent);
  if (!st.isDirectory() || fs.realpathSync(parent) !== parent || st.uid !== process.getuid() || (st.mode & 0o7077)) fail('unsafe marker parent');
  if (exists(marker)) {
    const st = fs.lstatSync(marker);
    if (!st.isDirectory() || fs.realpathSync(marker) !== marker || st.uid !== process.getuid() || (st.mode & 0o7077)) fail('unsafe marker directory');
  }
  const stage = fs.mkdtempSync(join(parent, '.provenance-'));
  fs.chmodSync(stage, 0o700);
  const sync = path => { const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  try {
    for (const [name, bytes] of Object.entries(selected.records)) {
      const path = join(stage, name); fs.writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); fs.chmodSync(path, 0o600); sync(path);
    }
    sync(stage); fs.renameSync(stage, marker); sync(parent);
  } finally { if (exists(stage)) fs.rmSync(stage, { recursive: true }); }
}
