/** Opaque format-1/2 archive codec. The caller excludes writers for the entire operation. */
import * as fs from 'node:fs';
import { dirname, basename, join, relative, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import { parseTree } from 'jsonc-parser';
import { publishNoReplace, setMtimeNs } from './state-native.mjs';

import { recordNames, validateBuildRecordSet, CONTEXT } from './build-context.mjs';
const archiveRecords = options => recordNames(options.provenance);
const archivePayloads = options => [...archiveRecords(options), 'state.tar'];
const archiveFiles = options => ['metadata.json', ...archivePayloads(options)];
const archiveFormat = options => Object.hasOwn(options.provenance, CONTEXT) ? 2 : 1;

/** Copy stopped state with private owner modes and exact timestamps; leave the source unchanged. */
export function copyPrivateTree(source, destination, ownership) {
  const entries = scanSource(source, ownership);
  let destinationExists = false;
  try {
    fs.lstatSync(destination);
    destinationExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (destinationExists) throw new Error('Copy destination already exists');
  fs.cpSync(source, destination, { recursive: true });
  for (const entry of entries.reverse()) {
    const path = entry.name === 'state'
      ? destination
      : join(destination, entry.name.slice(6));
    fs.chmodSync(path, entry.mode);
    setMtimeNs(path, entry.st.mtimeNs);
  }
}
const sameKeys = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const reject = message => { throw new Error(message); };
const exists = path => { try { fs.lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const absent = path => { if (exists(path)) throw Object.assign(new Error(`Destination exists: ${path}`), { code: 'EEXIST' }); };

function inputs({ domain, provenance, uid, gid }) {
  if (typeof domain !== 'string' || !domain) reject('domain must be a non-empty string');
  if (![uid, gid].every(n => Number.isSafeInteger(n) && n >= 0)) reject('uid/gid must be non-negative integers');
  validateBuildRecordSet(provenance);
}
function owner(st, { uid, gid }, label, allowedMode = 0o700) {
  if (Number(st.uid) !== uid || Number(st.gid) !== gid) reject(`${label} has foreign ownership`);
  const mode = Number(st.mode) & 0o7777;
  if (mode & ~allowedMode) reject(`${label} has unsafe permission bits`);
  return mode;
}
function parent(path, options) {
  const st = fs.lstatSync(dirname(path));
  if (!st.isDirectory()) reject('destination parent is not a directory');
  owner(st, options, 'destination parent');
}
function memberName(name) {
  if (!name || name.includes('\0') || name.startsWith('/') || name.endsWith('/') || posix.normalize(name) !== name || name.split('/').some(p => p === '.' || p === '..') || name.split('/')[0] !== 'state') reject(`Noncanonical archive member: ${name}`);
}
export function scanSource(source, options) {
  const entries = [];
  function visit(path, name) {
    const st = fs.lstatSync(path, { bigint: true });
    if (!st.isDirectory() && !st.isFile()) reject(`${name} is not a directory or regular file`);
    if (st.isFile() && st.nlink !== 1n) reject(`${name} is linked`);
    // Native packages may create readable descendants inside the private root.
    // Never accept shared writes or special bits; emitted state remains private.
    const mode = owner(st, options, name, name === 'state' ? 0o700 : 0o755) & 0o700;
    memberName(name);
    entries.push({ path, name, st, mode });
    if (st.isDirectory()) for (const child of fs.readdirSync(path).sort()) visit(join(path, child), name + '/' + child);
  }
  if (!fs.lstatSync(source).isDirectory()) reject('source must be a directory');
  visit(source, 'state');
  return entries;
}
function mtimeText(ns) {
  const sign = ns < 0n ? '-' : ''; const n = ns < 0n ? -ns : ns;
  return sign + n / 1000000000n + '.' + String(n % 1000000000n).padStart(9, '0');
}
function mtimeNs(header) {
  const text = header.pax?.mtime;
  if (typeof text !== 'string') reject('archive member lacks an exact mtime');
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m) reject('invalid archive mtime');
  const fraction = m[3] || '';
  const scale = Number(m[4] || 0) + 9 - fraction.length;
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 1000) reject('archive mtime is outside supported range');
  let value = BigInt(m[2] + fraction);
  if (scale >= 0) value *= 10n ** BigInt(scale);
  else { const divisor = 10n ** BigInt(-scale); if (value % divisor) reject('archive mtime has sub-nanosecond precision'); value /= divisor; }
  return m[1] === '-' ? -value : value;
}
async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
function strictJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const errors = []; const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || errors.length) reject('invalid metadata.json');
  function check(node) {
    if (node.type === 'object') {
      const keys = node.children.map(p => p.children[0].value);
      if (new Set(keys).size !== keys.length) reject('metadata contains duplicate key');
    }
    for (const child of node.children || []) check(child);
  }
  check(tree); return JSON.parse(text);
}
async function writeTar(path, entries) {
  const pack = tar.pack();
  const completion = pipeline(pack, fs.createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  completion.catch(() => {});
  try {
    for (const { path: source, name, st, mode } of entries) {
      const header = { name, type: st.isDirectory() ? 'directory' : 'file', uid: Number(st.uid), gid: Number(st.gid), mode,
        uname: '', gname: '', mtime: new Date(0), pax: { mtime: mtimeText(st.mtimeNs), uid: String(st.uid), gid: String(st.gid) }, size: st.isFile() ? Number(st.size) : 0 };
      if (st.isDirectory()) { await new Promise((yes, no) => pack.entry(header, error => error ? no(error) : yes())); continue; }
      const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let handedOff = false;
      try {
        const current = fs.fstatSync(fd, { bigint: true });
        owner(current, header, name, 0o755);
        if (!current.isFile() || current.dev !== st.dev || current.ino !== st.ino || current.size !== st.size) reject('source changed during archive creation');
        const input = fs.createReadStream(source, { fd, autoClose: true }); handedOff = true;
        await pipeline(input, pack.entry(header));
      } finally { if (!handedOff) fs.closeSync(fd); }
    }
    pack.finalize(); await completion;
  } catch (error) { pack.destroy(error); await completion.catch(() => {}); throw error; }
}
async function readTar(path, consume) {
  const extract = tar.extract();
  const completion = pipeline(fs.createReadStream(path), extract); completion.catch(() => {});
  try {
    for await (const entry of extract) {
      const header = { ...entry.header };
      // tar-stream applies PAX paths/size, but leaves uid/gid in raw headers.
      // PAX ownership is authoritative, including when it contradicts the base header.
      for (const key of ['uid', 'gid', 'size']) if (header.pax?.[key] !== undefined) {
        const encoded = header.pax[key];
        if (!/^[+-]?\d+$/.test(encoded) || !Number.isSafeInteger(Number(encoded)) || Number(encoded) < 0) reject(`invalid PAX ${key}`);
        header[key] = Number(encoded);
      }
      // Python TarInfo normalizes a directory's trailing slash in the same way.
      if (header.type === 'directory' && header.name.endsWith('/')) header.name = header.name.slice(0, -1);
      await consume(header, entry);
    }
    await completion;
  } catch (error) { extract.destroy(error); await completion.catch(() => {}); throw error; }
}
async function members(path, options) {
  const result = new Map();
  await readTar(path, async (header, entry) => {
    memberName(header.name);
    if (result.has(header.name)) reject('duplicate archive member');
    if (!['directory', 'file', 'contiguous-file'].includes(header.type)) reject('archive member is a link or special entry');
    owner(header, options, header.name); mtimeNs(header);
    result.set(header.name, header);
    for await (const chunk of entry) { /* Validate the whole stream without buffering file content. */ }
  });
  if (result.get('state')?.type !== 'directory') reject('state.tar lacks its root directory');
  for (const name of result.keys()) if (name !== 'state' && result.get(posix.dirname(name))?.type !== 'directory') reject('archive member has a missing or non-directory parent');
  return result;
}
export async function validateArchive(archive, options) {
  inputs(options);
  const RECORDS = archiveRecords(options), PAYLOADS = archivePayloads(options), FILES = archiveFiles(options);
  const st = fs.lstatSync(archive);
  if (!st.isDirectory() || owner(st, options, 'archive') !== 0o700) reject('archive must be a private directory');
  if (fs.readdirSync(archive).sort().join('\0') !== [...FILES].sort().join('\0')) reject('archive must contain exactly the expected format files');
  for (const name of FILES) {
    const st = fs.lstatSync(join(archive, name));
    if (!st.isFile() || owner(st, options, name) !== 0o600) reject('archive payload must be a private regular file');
  }
  const metadata = strictJson(fs.readFileSync(join(archive, 'metadata.json')));
  if (!sameKeys(metadata, ['format', 'domain', 'created_at', 'uid', 'gid', 'sha256']) || metadata.format !== archiveFormat(options) || metadata.domain !== options.domain || metadata.uid !== options.uid || metadata.gid !== options.gid) reject('archive metadata does not match');
  if (typeof metadata.created_at !== 'string' || !metadata.created_at.endsWith('Z') || !Number.isFinite(Date.parse(metadata.created_at))) reject('archive creation time is invalid');
  if (!sameKeys(metadata.sha256, PAYLOADS)) reject('archive digest map is invalid');
  for (const name of PAYLOADS) if (metadata.sha256[name] !== await hash(join(archive, name))) reject(`archive payload ${name} has a mismatched digest`);
  for (const name of RECORDS) if (!fs.readFileSync(join(archive, name)).equals(options.provenance[name])) reject(`archive provenance ${name} is not admitted`);
  await members(join(archive, 'state.tar'), options);
  return metadata;
}
function inside(child, parentPath) { const rel = relative(parentPath, child); return !rel || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/')); }
const destinationPath = path => join(fs.realpathSync(dirname(path)), basename(path));
export async function createArchive(source, destination, options) {
  inputs(options);
  const RECORDS = archiveRecords(options), PAYLOADS = archivePayloads(options); absent(destination); parent(destination, options);
  if (inside(destinationPath(destination), fs.realpathSync(source))) reject('archive destination must be outside the source');
  const entries = scanSource(source, options);
  const stage = fs.mkdtempSync(join(dirname(destination), '.' + basename(destination) + '.tmp-'));
  fs.chmodSync(stage, 0o700);
  try {
    await writeTar(join(stage, 'state.tar'), entries);
    fs.chmodSync(join(stage, 'state.tar'), 0o600);
    for (const name of RECORDS) {
      fs.writeFileSync(join(stage, name), options.provenance[name], { flag: 'wx', mode: 0o600 });
      fs.chmodSync(join(stage, name), 0o600);
    }
    const sha256 = {}; for (const name of PAYLOADS) sha256[name] = await hash(join(stage, name));
    const metadata = { format: archiveFormat(options), domain: options.domain, created_at: new Date().toISOString(), uid: options.uid, gid: options.gid, sha256 };
    fs.writeFileSync(join(stage, 'metadata.json'), JSON.stringify(metadata) + '\n', { flag: 'wx', mode: 0o600 });
    fs.chmodSync(join(stage, 'metadata.json'), 0o600);
    await validateArchive(stage, options); publishNoReplace(stage, destination);
    return metadata;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
export async function extractArchive(archive, staging, options) {
  inputs(options); absent(staging); parent(staging, options);
  const sourcePath = fs.realpathSync(archive), targetPath = destinationPath(staging);
  if (inside(sourcePath, targetPath) || inside(targetPath, sourcePath)) reject('extraction staging must be outside the archive');
  const metadata = await validateArchive(archive, options);
  const snapshotRoot = fs.mkdtempSync(join(dirname(staging), '.archive-snapshot-'));
  let created = false, completed = false;
  try {
    const snapshot = join(snapshotRoot, 'state.tar'); fs.copyFileSync(join(archive, 'state.tar'), snapshot); fs.chmodSync(snapshot, 0o600);
    if (await hash(snapshot) !== metadata.sha256['state.tar']) reject('state.tar changed after validation');
    const inventory = await members(snapshot, options);
    fs.mkdirSync(staging, { mode: 0o700 }); created = true;
    const directories = [...inventory.values()].filter(h => h.type === 'directory').sort((a, b) => a.name.split('/').length - b.name.split('/').length);
    const target = name => name === 'state' ? staging : join(staging, name.slice(6));
    for (const h of directories) if (h.name !== 'state') fs.mkdirSync(target(h.name), { mode: 0o700 });
    await readTar(snapshot, async (header, entry) => {
      if (header.type === 'directory') { for await (const chunk of entry) {} return; }
      const path = target(header.name);
      await pipeline(entry, fs.createWriteStream(path, { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode: 0o600 }));
      fs.chownSync(path, header.uid, header.gid); fs.chmodSync(path, header.mode); setMtimeNs(path, mtimeNs(header));
    });
    for (const header of directories.reverse()) { const path = target(header.name); fs.chownSync(path, header.uid, header.gid); fs.chmodSync(path, header.mode); setMtimeNs(path, mtimeNs(header)); }
    completed = true; return metadata;
  } finally {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
    if (created && !completed) fs.rmSync(staging, { recursive: true, force: true });
  }
}
