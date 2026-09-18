import * as fs from 'node:fs';
import * as net from 'node:net';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, isAbsolute, sep } from 'node:path';
import { installationPaths } from './plan.mjs';
import { copyPrivateTree, scanSource } from '../assets/scripts/maintenance/state-archive.mjs';
import { publishNoReplace } from '../assets/scripts/maintenance/state-native.mjs';

const MARKER = '.ours-legacy-import.json';
const uid = () => process.getuid();
const ownership = () => ({ uid: uid(), gid: process.getgid() });
function canonical(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw Error('Legacy migration requires normalized absolute paths');
  let cursor = path;
  while (true) {
    try { if (fs.realpathSync(cursor) !== cursor) throw Error('Legacy migration refuses symlink paths'); return path; }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(cursor); if (parent === cursor) throw error; cursor = parent; }
  }
}
function privatePath(path, directory = false) {
  canonical(path); const stat = fs.lstatSync(path);
  if (!(directory ? stat.isDirectory() : stat.isFile()) || stat.uid !== uid()
    || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) || (!directory && stat.nlink !== 1))
    throw Error('Legacy migration requires private owner-only regular files and directories');
  return stat;
}
function objectFile(path) {
  privatePath(path); const value = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Legacy configuration must be an object');
  return value;
}
const contains = (parent, child) => parent === child || child.startsWith(parent + sep);
function inspectRoot(stateDir) {
  const root = objectFile(join(stateDir, 'root.json'));
  if (root.v !== 1 || typeof root.name !== 'string' || !root.name || root.name !== root.name.trim()
    || root.name.normalize('NFC') !== root.name || root.name.length > 64 || /[\x00-\x1f\x7f/\\]/.test(root.name)
    || ['.', '..', 'contact-book', 'root.json', 'bindings.json'].includes(root.name)) throw Error('Legacy root marker is invalid');
  privatePath(join(stateDir, root.name), true);
  for (const file of ['identity.key', 'state_data.bin']) if (privatePath(join(stateDir, root.name, file)).size === 0) throw Error('Legacy root identity is incomplete');
  // CID and hierarchy are packet facts, not fields in root.json. The caller
  // must compare authenticated identity-list results before/after activation.
  return root.name;
}
export function inspectLegacyState(configPath, targetRoot) {
  canonical(configPath); canonical(targetRoot);
  const config = objectFile(configPath);
  const defaultState = join(homedir(), '.ours');
  if (config.stateDir === undefined && configPath !== join(defaultState, 'config.json')) throw Error('Custom legacy config requires explicit stateDir');
  const stateDir = config.stateDir === undefined ? canonical(defaultState) : canonical(config.stateDir);
  privatePath(stateDir, true);
  if (contains(stateDir, targetRoot) || contains(targetRoot, stateDir) || contains(targetRoot, configPath)) throw Error('Legacy source and target roots must be disjoint');
  if (config.database && (typeof config.database !== 'object' || Array.isArray(config.database)
    || (config.database.provider !== undefined && config.database.provider !== 'sqlite') || config.database.url))
    throw Error('Legacy migration does not support external or non-SQLite history');
  const entries = scanSource(stateDir, ownership());
  if (entries.some(entry => entry.name.split('/').includes('.ours-provenance'))) throw Error('Legacy unmanaged migration does not support existing build provenance');
  if (entries.some(entry => entry.name.endsWith('/history-postgresql.json'))) throw Error('Legacy migration cannot copy external PostgreSQL history');
  if (fs.existsSync(join(stateDir, '.mcp'))) privatePath(join(stateDir, '.mcp'), true);
  if (config.networkMcp !== undefined) {
    const mcp = config.networkMcp;
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)
      || mcp.applicationConfigPath !== join(stateDir, '.mcp/config.json')
      || !mcp.profile || mcp.profile.credentialPath !== join(stateDir, 'daemon-token'))
      throw Error('Legacy migration requires embedded MCP configuration and credentials; external MCP paths are unsupported');
  }
  if (config.apiTokenDeliveryFiles !== undefined && (!Array.isArray(config.apiTokenDeliveryFiles)
    || config.apiTokenDeliveryFiles.some(path => path !== join(stateDir, 'daemon-token'))))
    throw Error('Legacy migration does not support external token delivery paths');
  return { configPath, stateDir, config, rootCid: null, rootName: inspectRoot(stateDir) };
}
const receipt = (source, record) => ({ sourceStateDir: source.stateDir, sourceConfigPath: source.configPath, targetRoot: record.root, rootName: source.rootName });
function writePrivate(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.chmodSync(path, 0o600);
}

function publishLegacyMcp(source, destination, expected, profile) {
  canonical(destination);
  if (fs.existsSync(destination)) {
    privatePath(destination, true);
    if (fs.existsSync(join(destination, MARKER))) {
      if (JSON.stringify(objectFile(join(destination, MARKER))) !== JSON.stringify(expected)) throw Error('Legacy MCP destination receipt mismatch');
      return;
    }
    if (fs.readdirSync(destination).length) throw Error('Legacy MCP destination must be absent or empty');
  }
  const staging = join(dirname(destination), `.legacy-mcp-${randomUUID()}`);
  try {
    const embedded = join(source.stateDir, '.mcp');
    if (fs.existsSync(embedded)) copyPrivateTree(embedded, staging, ownership());
    else fs.mkdirSync(staging, { mode: 0o700 });
    writePrivate(join(staging, 'profile.json'), profile);
    writePrivate(join(staging, MARKER), expected);
    scanSource(staging, ownership());
    if (fs.existsSync(destination)) fs.rmdirSync(destination);
    publishNoReplace(staging, destination);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

// Caller excludes source writers and owns installation exclusion through activation.
export function stageLegacyState(source, record) {
  if (record.schema !== 2 || !['packages', 'docker'].includes(record.mode)
    || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) throw Error('Unsupported legacy migration destination');
  const fresh = inspectLegacyState(source.configPath, record.root);
  if (fresh.stateDir !== source.stateDir || fresh.rootName !== source.rootName) throw Error('Legacy source selection changed');
  const paths = installationPaths(record);
  const destination = paths.daemon, parent = dirname(destination);
  canonical(destination); privatePath(parent, true);
  const expected = receipt(fresh, record);
  if (fs.existsSync(destination)) {
    privatePath(destination, true);
    if (fs.existsSync(join(destination, MARKER))) {
      const saved = objectFile(join(destination, MARKER));
      if (JSON.stringify(saved) !== JSON.stringify(expected) || inspectRoot(destination) !== fresh.rootName) throw Error('Legacy destination receipt does not match selected source');
      const mcpReceipt = objectFile(join(paths.mcp, MARKER));
      if (JSON.stringify(mcpReceipt) !== JSON.stringify(expected)) throw Error('Legacy MCP destination receipt does not match selected source');
      return { ...expected, destination, reused: true };
    }
    if (fs.readdirSync(destination).length) throw Error('Legacy destination must be absent or empty');
  }
  const staging = join(parent, `.legacy-${randomUUID()}`);
  try {
    copyPrivateTree(fresh.stateDir, staging, ownership());
    // Preserve the untouched source as the rollback copy. Only copied PID hints
    // are discarded; opaque identities, authority, SQLite sidecars all survive.
    for (const name of ['ours-cli-daemon.json', 'daemon.pid', 'startup-progress.json']) fs.rmSync(join(staging, name), { force: true });
    const config = structuredClone(fresh.config);
    config.stateDir = record.mode === 'docker' ? '/var/lib/ours' : destination;
    config.port = record.mode === 'docker' ? 3050 : record.port; config.apiVisibility = 'owner';
    delete config.apiToken; delete config.apiTokenDeliveryFiles;
    config.networkMcp = {
      profile: { endpoint: `http://127.0.0.1:${config.port}`, expectedInstanceId: record.instanceId, credentialPath: join(config.stateDir, 'daemon-token') },
      applicationConfigPath: record.mode === 'docker' ? '/var/lib/ours-mcp/config.json' : join(paths.mcp, 'config.json'),
    };
    // Publish MCP separately before daemon publication. Its receipt allows a
    // retry after an interrupted second rename, without overwriting live data.
    publishLegacyMcp(fresh, paths.mcp, expected, config.networkMcp.profile);
    writePrivate(join(staging, 'config.json'), config); writePrivate(join(staging, MARKER), expected);
    scanSource(staging, ownership());
    if (fs.existsSync(destination)) fs.rmdirSync(destination); // succeeds only for the empty skeleton
    publishNoReplace(staging, destination);
    return { ...expected, destination, reused: false };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

let Database;
export async function ensureLegacyLockSupport() {
  if (!['linux', 'darwin'].includes(process.platform) || typeof process.getuid !== 'function') throw Error('Legacy migration requires Linux/macOS source locking');
  try { ({ DatabaseSync: Database } = await import('node:sqlite')); }
  catch { throw Error('Legacy migration requires Node with node:sqlite support; upgrade Node before stopping the source daemon'); }
}

// Protocol adapted from SDK src/internal/state-root-lock.ts: permanent SQLite
// guard serializes stale socket probe/unlink/rebind; socket ownership lasts for
// the callback. Never replace the guard inode or unlink on ambiguous probes.
function lockDirectory(path) {
  try { fs.mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  privatePath(path, true);
}
function probe(path) {
  return new Promise(resolveProbe => {
    const socket = net.createConnection(path); let finished = false;
    const done = result => { if (finished) return; finished = true; socket.destroy(); resolveProbe(result); };
    socket.setTimeout(1000);
    socket.once('connect', () => done('live'));
    socket.once('timeout', () => done('ambiguous'));
    socket.once('error', error => done(['ECONNREFUSED', 'ENOENT'].includes(error.code) ? 'stale' : 'ambiguous'));
  });
}
async function socketLock(stateDir, path) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const server = net.createServer(socket => { socket.on('error', () => {}); socket.end(JSON.stringify({ pid: process.pid, stateDir, startedAt: new Date().toISOString() }) + '\n'); });
    try {
      await new Promise((accept, reject) => { server.once('error', reject); server.listen(path, () => { server.removeListener('error', reject); accept(); }); });
      server.unref(); return server;
    } catch (error) {
      try { server.close(); } catch { /* not listening */ }
      if (error.code !== 'EADDRINUSE') throw error;
      const result = await probe(path);
      if (result !== 'stale') throw Error(`Legacy source lock is ${result}; refusing to remove a potentially live owner`);
      try { fs.unlinkSync(path); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    }
  }
  throw Error('Could not acquire legacy source lock');
}
export async function withLegacyStateLock(stateDir, callback) {
  await ensureLegacyLockSupport(); canonical(stateDir); privatePath(stateDir, true);
  const base = `/tmp/ours-${uid()}`; lockDirectory(base); lockDirectory(join(base, 'locks'));
  const path = join(base, 'locks', createHash('sha256').update(stateDir).digest('hex') + '.sock');
  if (Buffer.byteLength(path) > 103) throw Error('Legacy lock socket path exceeds portable limit');
  const guardPath = path + '.guard';
  try { const fd = fs.openSync(guardPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.closeSync(fd); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const before = privatePath(guardPath), guard = new Database(guardPath); let server;
  try {
    const after = privatePath(guardPath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.uid !== after.uid) throw Error('Legacy acquisition guard changed');
    guard.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); server = await socketLock(stateDir, path);
  } finally { guard.close(); }
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await new Promise(resolveClose => server.close(resolveClose)); };
  if (callback === undefined) return { stateDir, close };
  try { return await callback(); }
  finally { await close(); }
}
