import * as fs from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installationPaths, validateInstallation, SERVER_SERVICES } from './plan.mjs';
import { copyPrivateTree, createArchive, validateArchive, scanSource } from '../assets/scripts/maintenance/state-archive.mjs';
import { publishNoReplace } from '../assets/scripts/maintenance/state-native.mjs';

import { recordNames, readBuildRecords, initializeBuildMarker } from '../assets/scripts/maintenance/build-context.mjs';
const PROVENANCE_DIRECTORY = '.ours-provenance';
const COMPONENTS = [...SERVER_SERVICES, 'mcp'];
const CONSUMERS = SERVER_SERVICES.filter(service => service !== 'daemon');

function privateFile(path) {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.gid !== process.getgid() || (stat.mode & 0o7777) !== 0o600) {
    throw new Error(`Unsafe conversion source file: ${path}`);
  }
  return fs.readFileSync(path);
}

function readConfig(path) {
  const value = JSON.parse(privateFile(path));
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Conversion source configuration must be an object');
  }
  return value;
}

function writeConfig(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(path, 0o600);
}

function conversionPaths(record, staging) {
  const paths = installationPaths(record);
  const parent = join(record.root, 'storage', '.maintenance');
  if (dirname(staging) !== parent || resolve(staging) !== staging || fs.realpathSync(parent) !== parent) {
    throw new Error('Conversion staging must use the selected private maintenance directory');
  }
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.uid !== process.getuid() || parentStat.gid !== process.getgid() || (parentStat.mode & 0o7777) !== 0o700) {
    throw new Error('Conversion staging parent must be private and owned by the operator');
  }
  return {
    paths,
    staged: path => join(staging, relative(paths.state, path)),
  };
}

// DEPRECATED (introduced in 2.0): legacy managed-layout conversion only.
// Removal target: 3.0 after supported upgrades no longer need this reader.
// Retain protected backups and supported archive import.
// The caller holds installation exclusion and has stopped/prepared all writers.
export async function stageLegacyPackageState(sourceRecord, staging) {
  validateInstallation(sourceRecord, sourceRecord.root);
  if (sourceRecord.schema !== 1 || sourceRecord.mode !== 'packages') {
    throw new Error('Select a legacy managed package installation');
  }
  const source = installationPaths(sourceRecord);
  const targetRecord = { ...sourceRecord, schema: 2 };
  targetRecord.configPath = installationPaths(targetRecord).config;
  const { paths: target, staged } = conversionPaths(targetRecord, staging);
  const ownership = { uid: process.getuid(), gid: process.getgid() };
  const configBytes = privateFile(source.config);
  const config = readConfig(source.config);
  const nestedConfig = join(source.daemon, 'config.json');
  if (fs.existsSync(nestedConfig) && !privateFile(nestedConfig).equals(configBytes)) {
    throw new Error('Conflicting daemon config sources require explicit resolution');
  }
  const applicationConfig = config.networkMcp?.applicationConfigPath;
  if (applicationConfig && applicationConfig !== join(source.mcp, 'config.json')) {
    throw new Error('External MCP configuration ownership requires explicit resolution');
  }
  if (config.networkMcp && (
    config.networkMcp.profile?.credentialPath !== join(source.daemon, 'daemon-token') ||
    config.networkMcp.profile?.expectedInstanceId !== sourceRecord.instanceId
  )) {
    throw new Error('MCP profile does not select this managed installation');
  }
  if (fs.existsSync(join(source.daemon, '.mcp'))) {
    throw new Error('Conflicting embedded and separate MCP sources require explicit resolution');
  }
  const provenance = readBuildRecords(sourceRecord.workDir);
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    for (const component of COMPONENTS) {
      copyPrivateTree(source[component], staged(target[component]), ownership);
      if (component === 'mcp') continue;
      const marker = join(staged(target[component]), PROVENANCE_DIRECTORY);
      initializeBuildMarker(marker, provenance);
    }
    fs.writeFileSync(staged(target.config), configBytes, { mode: 0o600 });
    for (const consumer of CONSUMERS) {
      const destination = staged(target.credentials[consumer]);
      fs.mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, privateFile(source.credentials[consumer]), { mode: 0o600, flag: 'wx' });
    }
    scanSource(staging, ownership);
    return targetRecord;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Call only after archiving and validating the still-unmodified staged payload. */
export function bindConvertedPackageState(targetRecord, staging) {
  validateInstallation(targetRecord, targetRecord.root);
  const { paths, staged } = conversionPaths(targetRecord, staging);
  const configPath = staged(paths.config);
  const config = readConfig(configPath);
  config.stateDir = paths.daemon;
  if (config.networkMcp) {
    config.networkMcp.applicationConfigPath = join(paths.mcp, 'config.json');
    config.networkMcp.profile.credentialPath = join(paths.daemon, 'daemon-token');
    writeConfig(join(staged(paths.mcp), 'profile.json'), config.networkMcp.profile);
  }
  writeConfig(configPath, config);
  const coworkPath = join(staged(paths.cowork), 'config.json');
  if (fs.existsSync(coworkPath)) {
    const cowork = readConfig(coworkPath);
    cowork.stateDir = paths.cowork;
    writeConfig(coworkPath, cowork);
  }
}

/** Prepare stopped source data; publication and service activation belong to the caller. */
export async function prepareLegacyPackageState(sourceRecord, staging, backupPath) {
  validateInstallation(sourceRecord, sourceRecord.root);
  const backupParent = join(sourceRecord.root, 'storage', 'backups');
  if (dirname(backupPath) !== backupParent || resolve(backupPath) !== backupPath || fs.realpathSync(backupParent) !== backupParent) {
    throw new Error('Conversion backup must use the selected backup directory');
  }
  const targetRecord = await stageLegacyPackageState(sourceRecord, staging);
  try {
    const provenance = readBuildRecords(sourceRecord.workDir);
    // createArchive validates the complete archive before publishing it without replacement.
    // Keep original configuration bytes in the backup, then bind the deployment copy.
    await createArchive(staging, backupPath, {
      domain: 'server',
      uid: process.getuid(),
      gid: process.getgid(),
      provenance,
    });
    bindConvertedPackageState(targetRecord, staging);
    return targetRecord;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function pathExists(path) {
  try { fs.lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function ensureConversionDirectory(path) {
  if (!pathExists(path)) fs.mkdirSync(path, { mode: 0o700 });
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.gid !== process.getgid()
    || (stat.mode & 0o7777) !== 0o700 || fs.realpathSync(path) !== path) {
    throw new Error(`Unsafe conversion directory: ${path}`);
  }
}

function removePrivateTree(path) {
  if (!pathExists(path)) return;
  scanSource(path, { uid: process.getuid(), gid: process.getgid() });
  fs.rmSync(path, { recursive: true });
}

export function validateConvertedPackageState(record, tree = installationPaths(record).state) {
  const paths = installationPaths(record);
  const physical = path => join(tree, relative(paths.state, path));
  scanSource(tree, { uid: process.getuid(), gid: process.getgid() });
  const records = readBuildRecords(record.workDir);
  const BUILD_RECORDS = recordNames(records);
  for (const component of SERVER_SERVICES) {
    const marker = join(physical(paths[component]), PROVENANCE_DIRECTORY);
    if (fs.readdirSync(marker).sort().join() !== [...BUILD_RECORDS].sort().join()) {
      throw new Error(`Incomplete converted ${component} provenance`);
    }
    for (const name of BUILD_RECORDS) {
      if (!privateFile(join(marker, name)).equals(records[name])) {
        throw new Error(`Converted ${component} differs from the selected build`);
      }
    }
    const configPath = join(physical(paths[component]), 'config.json');
    if (pathExists(configPath)) readConfig(configPath);
  }
  const daemon = readConfig(physical(paths.config));
  const profile = readConfig(join(physical(paths.mcp), 'profile.json'));
  if (daemon.stateDir !== paths.daemon || daemon.port !== record.port
    || daemon.networkMcp?.applicationConfigPath !== join(paths.mcp, 'config.json')
    || profile.expectedInstanceId !== record.instanceId
    || profile.credentialPath !== join(paths.daemon, 'daemon-token')
    || profile.endpoint !== `http://127.0.0.1:${record.port}`
    || JSON.stringify(daemon.networkMcp.profile) !== JSON.stringify(profile)) {
    throw new Error('Converted daemon/MCP deployment configuration is inconsistent');
  }
  if (pathExists(join(physical(paths.mcp), 'config.json'))) readConfig(join(physical(paths.mcp), 'config.json'));
  if (readConfig(join(physical(paths.cowork), 'config.json')).stateDir !== paths.cowork) {
    throw new Error('Converted Cowork configuration selects another state directory');
  }
  for (const credential of [profile.credentialPath, ...Object.values(paths.credentials)]) {
    if (!privateFile(physical(credential)).length) throw new Error('Converted managed credential is empty');
  }
}

/** The caller holds the installation lock. The record is the sole selection commit. */
export async function convertPackageInstallation(record, operation, effects) {
  validateInstallation(record, record.root);
  if (record.mode !== 'packages' || (record.schema !== 1 && !record.layoutConversion)) {
    throw new Error('Select a legacy or pending package installation');
  }
  const selectionPath = join(record.root, 'installation.json');
  const writeSelection = value => effects.writeJson(selectionPath, JSON.stringify(value, null, 2) + '\n');
  const source = record.layoutConversion?.sourceRecord ?? record;
  const resumingPublished = record.schema === 2;
  const storage = join(record.root, 'storage');
  const maintenance = join(storage, '.maintenance');
  const backups = join(storage, 'backups');
  const targetState = join(storage, 'state');
  const staging = join(maintenance, 'layout-conversion');

  if (record.schema === 1) {
    if (readConfig(source.configPath).stateDir !== installationPaths(source).daemon) {
      throw new Error('Daemon authority source differs from the selected legacy state');
    }
    ensureConversionDirectory(record.root);
    for (const path of [storage, maintenance, backups]) ensureConversionDirectory(path);
    if (!record.layoutConversion && (pathExists(targetState) || pathExists(staging))) {
      throw new Error('Unowned conversion destination already exists');
    }
    await effects.prepareInstallation(source, { runtimeOnly: true });
    if (!record.layoutConversion) {
      const runningServices = await effects.serverLifecycle(source, 'status');
      record = {
        ...source,
        layoutConversion: {
          version: 1, sourceRecord: source, runningServices,
          backupPath: join(backups, `before-layout-2-${randomUUID()}`),
        },
      };
      writeSelection(record);
    }
    await effects.retireLegacyServices(source);
    await effects.prepareLegacyPackageSource(source);
    removePrivateTree(staging);
    try {
      const target = await stageLegacyPackageState(source, staging);
      const archiveOptions = {
        domain: 'server', uid: process.getuid(), gid: process.getgid(),
        provenance: readBuildRecords(source.workDir),
      };
      const backupPath = record.layoutConversion.backupPath;
      if (pathExists(backupPath)) await validateArchive(backupPath, archiveOptions);
      else await createArchive(staging, backupPath, archiveOptions);
      await effects.retainConvertedPackageAuthority(source, join(staging, 'daemon'));
      bindConvertedPackageState(target, staging);
      validateConvertedPackageState(target, staging);
      // A schema-1 pending record reserves this destination. Rebuild an interrupted
      // publication from the stopped source; never merge two copies of state.
      removePrivateTree(targetState);
      publishNoReplace(staging, targetState);
      record = { ...target, layoutConversion: record.layoutConversion };
      writeSelection(record);
    } finally {
      removePrivateTree(staging);
    }
  }

  const selected = ['install', 'start'].includes(operation)
    ? record.services : record.layoutConversion.runningServices;
  if (resumingPublished) {
    // A previous readiness failure can leave some new-layout services running.
    // Offline validation and residue preparation require stopping those writers.
    await effects.serverLifecycle(record, 'stop');
    await effects.prepareLegacyPackageSource(record);
  }
  validateConvertedPackageState(record);
  await effects.serverLifecycle(record, 'start', selected);

  // Selection is already committed: cleanup retries stay on the new state.
  const oldPaths = installationPaths(source);
  for (const component of COMPONENTS) removePrivateTree(oldPaths[component]);
  removePrivateTree(join(source.root, 'credentials'));
  if (pathExists(source.configPath)) {
    privateFile(source.configPath);
    fs.unlinkSync(source.configPath);
  }
  const finished = { ...record };
  delete finished.layoutConversion;
  writeSelection(finished);
  return finished;
}
