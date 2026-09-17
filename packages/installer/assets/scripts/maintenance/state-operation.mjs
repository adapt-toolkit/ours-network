#!/usr/bin/env node
/** One-shot maintenance for a selected domain; the installer excludes administrative writers. */
import * as fs from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createArchive, extractArchive, validateArchive, scanSource, copyPrivateTree } from './state-archive.mjs';
import { exchange, tryLock, setMtimeNs } from './state-native.mjs';
import { recordNames, readBuildRecords, equalBuildRecords, initializeBuildMarker } from './build-context.mjs';

const PROVENANCE = '.ours-provenance';
const APPLICATIONS = ['daemon', 'telegram', 'cowork', 'messenger'];
const exists = path => { try { fs.lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const canonical = path => exists(path) ? fs.realpathSync(path) : join(canonical(dirname(path)), basename(path));
const sameRecords = (a, b) => recordNames(a).length === recordNames(b).length && recordNames(a).every(name => a[name].equals(b[name]));
const semanticSameRecords = equalBuildRecords;
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fail = message => { throw new Error(message); };

export async function runStateOperation(argv, env = process.env, checkpoints = {}) {
  const selected = name => {
    const value = env[name];
    if (!value || resolve(value) !== value || canonical(value) !== value) fail(`${name} must select an absolute canonical path`);
    return value;
  };
  const state = selected('OURS_STATE_ROOT'), live = selected('OURS_LIVE_ROOT'), build = selected('OURS_BUILD_ROOT');
  if ([state, build].some(path => path === live || path.startsWith(live + '/'))) fail('maintenance and build records must be outside live application state');
  const backups = join(state, 'backups'), maintenance = join(state, '.maintenance');
  const domain = argv[1];
  if (![...APPLICATIONS, 'server'].includes(domain)) fail('select server, daemon, telegram, cowork or messenger');
  if (Object.hasOwn(env, 'OURS_STATE_DOMAIN') && env.OURS_STATE_DOMAIN !== domain) fail('selected volume domain does not match operation');
  const compatible = argv.at(-1) === '--compatible';
  if (compatible) argv = argv.slice(0, -1);
  const operation = argv[0];
  const paired = domain === 'daemon' && ['backup', 'restore', 'reset'].includes(operation);
  const commonTree = domain === 'server' || paired;
  if (compatible && !['restore', 'update'].includes(operation)) fail('compatibility attestation applies only to update or restore');
  if (domain === 'server' && !['backup', 'restore', 'update', 'rebuild'].includes(operation)) fail('full-server scope supports only backup, restore, update and rebuild');
  if (operation === 'rebuild' && domain !== 'server') fail('rebuild selects the complete server');
  const adopt = operation === 'init' && argv[2] === '--adopt-existing';
  const valid = (['init', 'update', 'rebuild'].includes(operation) && argv.length === 2) || (adopt && argv.length === 3) || (['backup', 'restore'].includes(operation) && argv.length === 3) || (operation === 'reset' && argv.length === 3 && argv[2] === '--confirm');
  if (!valid) fail('usage: init DOMAIN | backup DOMAIN LABEL | restore DOMAIN LABEL | reset DOMAIN --confirm | update DOMAIN');
  const uid = process.getuid(), gid = process.getgid();
  if (!uid || !gid) fail('state maintenance requires a non-root UID and GID');
  const options = records => ({ domain, uid, gid, provenance: records });
  const labelPath = label => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/.test(label)) fail('backup label must be a plain basename');
    return join(backups, label);
  };
  if (['backup', 'restore'].includes(operation)) labelPath(argv[2]);
  function privateStat(path, directory, exact) {
    const st = fs.lstatSync(path), mode = st.mode & 0o7777;
    if (!(directory ? st.isDirectory() : st.isFile()) || st.uid !== uid || st.gid !== gid || (mode & ~0o700) || (exact !== undefined && mode !== exact)) fail(`unsafe ownership, type or permissions: ${path}`);
    return st;
  }
  function mkdir(path) {
    if (exists(path)) privateStat(path, true, 0o700);
    else { fs.mkdirSync(path, { mode: 0o700 }); fs.chmodSync(path, 0o700); }
  }
  function layout() { privateStat(state, true, 0o700); mkdir(backups); mkdir(maintenance); }
  function readRecords(path, marker = true) {
    privateStat(path, true, 0o700);
    return readBuildRecords(path, { privateFiles: true, marker });
  }
  function writeRecord(path, bytes) {
    fs.writeFileSync(path, bytes, { flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode: 0o600 });
    fs.chmodSync(path, 0o600);
  }
  function owner(command, extraEnv = {}) {
    try { execFileSync(command[0], command.slice(1), { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe', ...(env.OURS_INSTALLER_LOCK_FD === '3' ? [3] : [])] }); }
    catch { fail(`owning package ${command[1]} operation failed`); }
  }
  function prepare() {
    if (!['server', 'cowork'].includes(domain) && !paired) return;
    if (!env.OURS_COWORK_CLI_PATH || !env.OURS_COWORK_CONFIG) fail('Cowork maintenance requires its selected executable and configuration');
    owner([env.OURS_COWORK_CLI_PATH, '--json', 'prepare-backup'], { OURS_COWORK_CONFIG: env.OURS_COWORK_CONFIG });
  }
  function liveDescriptor() {
    privateStat(live, true, 0o700);
    const fd = fs.openSync(live, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.realpathSync(live) !== live || !sameInode(fs.fstatSync(fd), fs.statSync(live))) fail('domain state path changed or is not canonical');
      return fd;
    } catch (e) { fs.closeSync(fd); throw e; }
  }
  function validateTree(tree, records) {
    const roots = domain === 'server' ? APPLICATIONS.map(name => join(tree, name)) : [tree];
    for (const root of roots) if (!sameRecords(readRecords(join(root, PROVENANCE)), records)) fail('restored component provenance does not match the archive build');
    if (domain === 'server') for (const name of ['mcp', 'credentials']) privateStat(join(tree, name), true, 0o700);
    if (paired) privateStat(join(tree, '.mcp'), true, 0o700);
    return roots;
  }
  function retarget(tree, source, target) {
    // Call only on private staging. Publish the entire generation at exchange.
    for (const root of validateTree(tree, source)) {
      const marker = join(root, PROVENANCE);
      fs.rmSync(marker, { recursive: true }); mkdir(marker);
      for (const name of recordNames(target)) writeRecord(join(marker, name), target[name]);
    }
  }
  function copyTree(source, destination) {
    copyPrivateTree(source, destination, { uid, gid });
  }
  async function backupTo(path, records) {
    if (!paired) return createArchive(live, path, options(records));
    const payload = join(maintenance, `daemon-payload-${randomBytes(12).toString('hex')}`);
    try {
      if (exists(join(live, 'daemon/.mcp'))) fail('daemon state collides with the separate MCP source');
      privateStat(join(live, 'mcp'), true, 0o700);
      copyTree(join(live, 'daemon'), payload);
      copyTree(join(live, 'mcp'), join(payload, '.mcp'));
      await createArchive(payload, path, options(records));
    } finally { if (exists(payload)) fs.rmSync(payload, { recursive: true }); }
  }
  async function automaticBackup(prefix, records) {
    const path = labelPath(`${prefix}-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`);
    checkpoints.beforeBackup?.();
    await backupTo(path, records);
    checkpoints.afterBackup?.();
    return path;
  }
  function bindConfig(path, source, keys) {
    privateStat(source, false, 0o600);
    const current = JSON.parse(fs.readFileSync(source));
    const restored = exists(path) ? JSON.parse(fs.readFileSync(path)) : {};
    for (const value of [current, restored]) if (!value || Array.isArray(value) || typeof value !== 'object') fail('component configuration must be an object');
    for (const key of keys) {
      if (Object.hasOwn(current, key)) restored[key] = current[key]; else delete restored[key];
    }
    fs.writeFileSync(path, JSON.stringify(restored, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(path, 0o600);
    return current;
  }
  function bindDeployment(tree) {
    if (commonTree) {
      const current = bindConfig(join(tree, 'daemon/config.json'), env.OURS_DAEMON_CONFIG, ['stateDir', 'port', 'apiVisibility', 'networkMcp']);
      if (current.networkMcp?.profile) {
        const path = join(tree, 'mcp/profile.json');
        fs.writeFileSync(path, JSON.stringify(current.networkMcp.profile, null, 2) + '\n', { mode: 0o600 });
        fs.chmodSync(path, 0o600);
      }
    }
    if (['server', 'cowork'].includes(domain)) bindConfig(join(tree, domain === 'server' ? 'cowork/config.json' : 'config.json'), env.OURS_COWORK_CONFIG, ['version', 'stateDir', 'rest']);
  }
  function retainAuthority(staging) {
    if (!['daemon', 'server'].includes(domain)) return;
    if (!env.OURS_CLI_PATH || !env.OURS_DAEMON_CONFIG) fail('daemon maintenance requires its selected executable and configuration');
    const daemon = commonTree ? join(staging, 'daemon') : staging;
    owner([env.OURS_CLI_PATH, 'config', 'access-retain', '--config', env.OURS_DAEMON_CONFIG, '--target-state-dir', daemon, '--json']);
    if (!commonTree) return;
    const credentials = join(live, 'credentials'), destination = join(staging, 'credentials');
    for (const name of ['telegram', 'cowork', 'messenger']) if (!privateStat(join(credentials, name, 'daemon-token'), false, 0o600).size) fail('current managed credential is empty');
    fs.rmSync(destination, { recursive: true }); copyTree(credentials, destination);
  }
  function replace(staging) {
    const fd = fs.openSync(staging, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      if (!tryLock(fd)) fail('replacement staging is in use');
      if (!sameInode(fs.fstatSync(fd), fs.statSync(staging))) fail('replacement staging changed before exchange');
      checkpoints.beforeExchange?.();
      exchange(live, staging);
      checkpoints.afterExchange?.();
      fs.rmSync(staging, { recursive: true });
    } finally { fs.closeSync(fd); }
  }
  privateStat(state, true, 0o700);
  if (!exists(live)) { if (operation !== 'init') fail('domain state does not exist; run init for this domain first'); layout(); mkdir(live); }
  const target = readBuildRecords(build);
  const fd = liveDescriptor();
  try {
    if (!tryLock(fd)) fail('domain state is already in use');
    const check = liveDescriptor();
    try { if (!sameInode(fs.fstatSync(fd), fs.fstatSync(check))) fail('domain state changed while acquiring its lock'); }
    finally { fs.closeSync(check); }
    let records;
    if (domain === 'server') { records = readRecords(join(live, 'daemon', PROVENANCE)); validateTree(live, records); }
    else if (paired) { records = readRecords(join(live, 'daemon', PROVENANCE)); privateStat(join(live, 'mcp'), true, 0o700); }
    else if (operation !== 'init') records = readRecords(join(live, PROVENANCE));
    else {
      const marker = join(live, PROVENANCE), application = fs.readdirSync(live).filter(name => name !== PROVENANCE);
      records = target;
      if (exists(marker)) {
        privateStat(marker, true, 0o700);
        if (fs.readdirSync(marker).length) {
          records = readRecords(marker); // Partial generations are never repaired implicitly.
          if (!sameRecords(records, target)) fail('existing provenance differs; use reviewed update --compatible to establish the new build context');
        } else if (application.length && !adopt) fail('existing unmarked domain state requires evidence-backed adoption');
      } else if (application.length && !adopt) fail('existing unmarked domain state requires evidence-backed adoption');
      prepare(); if (application.length && adopt) scanSource(live, { uid, gid });
      checkpoints.beforeInitialMarker?.();
      initializeBuildMarker(marker, records);
      checkpoints.afterInitialMarker?.();
      layout(); return;
    }
    if (operation === 'update' || operation === 'rebuild') {
      // The installer admits rebuild only after verifying unchanged sources.
      // This is not a recorded user compatibility attestation.
      if (!semanticSameRecords(records, target) && !(compatible && operation !== 'rebuild')) fail('different-build restore/update requires reviewed storage compatibility (--compatible)');
      prepare(); layout(); const archive = await automaticBackup('pre-update', records);
      console.log(`Validated pre-update backup: ${basename(archive)}`);
      // Stage the complete set for every domain; no in-place partial retarget.
      const staging = join(maintenance, `update-${randomBytes(12).toString('hex')}`);
      try {
        copyTree(live, staging);
        retarget(staging, records, target);
        validateTree(staging, target);
        replace(staging);
      } finally { if (exists(staging)) fs.rmSync(staging, { recursive: true }); }
      return;
    }
    if (operation === 'backup') { prepare(); layout(); await backupTo(labelPath(argv[2]), records); return; }
    const staging = join(maintenance, `${operation}-${randomBytes(12).toString('hex')}`);
    try {
      if (operation === 'restore') {
        const archive = labelPath(argv[2]); if (fs.realpathSync(archive) !== archive) fail('backup path is not canonical');
        const archived = readRecords(archive, false);
        if (!semanticSameRecords(archived, target) && !compatible) fail('different-build restore/update requires reviewed storage compatibility (--compatible)');
        await validateArchive(archive, options(archived)); prepare(); layout(); await automaticBackup('pre-restore', records);
        if (paired) {
          const payload = `${staging}-payload`;
          try {
            await extractArchive(archive, payload, options(archived)); retarget(payload, archived, target);
            copyTree(live, staging);
            fs.rmSync(join(staging, 'daemon'), { recursive: true });
            fs.rmSync(join(staging, 'mcp'), { recursive: true });
            fs.renameSync(join(payload, '.mcp'), join(staging, 'mcp'));
            fs.renameSync(payload, join(staging, 'daemon'));
          } finally { if (exists(payload)) fs.rmSync(payload, { recursive: true }); }
        } else { await extractArchive(archive, staging, options(archived)); retarget(staging, archived, target); }
      } else {
        prepare(); layout(); await automaticBackup('pre-reset', records);
        if (paired) {
          copyTree(live, staging);
          for (const name of ['daemon', 'mcp']) { fs.rmSync(join(staging, name), { recursive: true }); mkdir(join(staging, name)); }
        } else mkdir(staging);
        const marker = join(paired ? join(staging, 'daemon') : staging, PROVENANCE);
        mkdir(marker);
        for (const name of recordNames(records)) writeRecord(join(marker, name), records[name]);
        bindDeployment(staging);
      }
      retainAuthority(staging); bindDeployment(staging); replace(staging);
    } finally { if (exists(staging)) fs.rmSync(staging, { recursive: true }); }
  } finally { fs.closeSync(fd); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runStateOperation(process.argv.slice(2)); }
  catch (error) { console.error(`OURS state operation refused: ${error.message}`); process.exitCode = 1; }
}
