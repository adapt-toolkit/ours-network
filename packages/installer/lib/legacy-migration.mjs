/** Local-only migration: preserve opaque daemon state and retire its old launcher. */
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectLegacyState, stageLegacyState, withLegacyStateLock, ensureLegacyLockSupport } from './legacy-state.mjs';
import { inspectManagedCli, installManagedCli } from './managed-cli.mjs';
import { atomicWriteConfig } from './config.mjs';
import { classifyUnit, unitPathForStateDir, validateInstallation } from './plan.mjs';

const journalPath = root => join(root, 'legacy-migration.json');
const parse = result => JSON.parse(result.stdout);
const phases = ['prepared', 'stopped', 'copied', 'activating', 'verified', 'complete'];
function readJournal(root) {
  const path = journalPath(root);
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path));
  if (j.schema !== 1 || j.targetRoot !== root || !phases.includes(j.phase) || !Array.isArray(j.identities)) throw new Error('Invalid legacy migration journal');
  return j;
}
function selection(source) {
  return { env: { OURS_CONFIG: source.configPath, OURS_STATE_DIR: source.stateDir, OURS_PORT: String(source.config.port ?? 3050), OURS_API_TOKEN: undefined, OURS_DAEMON_ID: undefined, OURS_DAEMON_URL: undefined, OURS_DAEMON_CREDENTIAL_PATH: undefined }, sensitive: true };
}
async function oldCommand(effects, source, args, options = {}) {
  return effects.run(source.originalProgram ?? 'ours', [...args, '--config', source.configPath, '--state-dir', source.stateDir, '--json'], { ...selection(source), ...options });
}
function validateIdentities(rows, source) {
  if (!Array.isArray(rows) || !rows.length || rows.some(r => !['root', 'role'].includes(r.kind) || typeof r.cid !== 'string' || !r.cid || typeof r.name !== 'string')) throw new Error('Legacy identities are not fully restored; migration requires a healthy source daemon');
  const roots = rows.filter(r => r.kind === 'root');
  if (roots.length !== 1 || roots[0].name !== source.rootName) throw new Error('Legacy Human identity does not match its stored root');
  return rows.map(({ name, kind, cid }) => ({ name, kind, cid })).sort((a,b) => a.name.localeCompare(b.name));
}

export async function inspectLegacyMigration(options, effects, deps = {}) {
  const inspect = deps.inspectLegacyState ?? inspectLegacyState;
  await (deps.ensureLegacyLockSupport ?? ensureLegacyLockSupport)();
  const cliPlan = options.dryRun ? null : await (deps.inspectManagedCli ?? inspectManagedCli)(effects, options.stateDir);
  const journal = readJournal(options.stateDir);
  if (journal) {
    if (journal.sourceConfig !== options.migrateFrom) throw new Error('Another legacy source is already selected for this target');
    return { journal, cliPlan, source: journal.phase === 'complete' ? null : { ...inspect(options.migrateFrom, options.stateDir), originalProgram: cliPlan?.originalProgram } };
  }
  const source = { ...inspect(options.migrateFrom, options.stateDir), originalProgram: cliPlan?.originalProgram };
  if (options.mode === 'docker' && options.stateDir.includes(':')) throw new Error('Docker migration requires an installation path without colon characters');
  if (effects.readJson(join(options.stateDir, 'installation.json'))) throw new Error('Legacy migration requires a new managed installation root');
  if (existsSync(options.stateDir) && readdirSync(options.stateDir).length) throw new Error('Legacy migration target must be empty');
  if (options.dryRun) return { source, journal: { schema: 1, sourceConfig: source.configPath, sourceStateDir: source.stateDir, targetRoot: options.stateDir, phase: 'prepared', identities: [], service: null } };
  // The owning CLI verifies endpoint, process and state directory. No PID guessing.
  const status = parse(await oldCommand(effects, source, ['daemon', 'status']));
  if (status.state !== 'running' || status.stateDir !== source.stateDir) throw new Error('Start the legacy daemon before migration so its identities can be verified');
  const identities = validateIdentities(parse(await oldCommand(effects, source, ['identity', 'list'])), source);
  const service = parse(await oldCommand(effects, source, ['daemon', 'uninstall-service', '--dry-run']));
  if (service.conflict) {
    const legacy = effects.platform?.platform === 'linux' && source.stateDir === join(effects.home, '.ours')
      ? unitPathForStateDir(source.stateDir, effects.home) : null;
    if (!legacy?.ok || legacy.path !== service.serviceFile || classifyUnit(effects.readText(legacy.path)).kind !== 'legacy') {
      throw new Error('Legacy boot service ownership could not be verified: ' + service.conflict.message);
    }
    service.legacyUnit = legacy.unit;
  }
  return { source, cliPlan, journal: { schema: 1, sourceConfig: source.configPath, sourceStateDir: source.stateDir, targetRoot: options.stateDir,
    phase: 'prepared', identities, service, sourcePort: source.config.port ?? 3050 } };
}

export async function prepareMigrationCliRuntime(record, effects) {
  const root = join(record.root, 'launcher-runtime');
  const entry = join(root, 'node_modules', '@ours.network', 'install', 'install.mjs');
  const ready = join(root, '.ready');
  if (existsSync(ready) && existsSync(entry)) return entry;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  effects.out('Preparing permanent management commands so ours will keep working after this installer exits.');
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const packed = parse(await effects.run('npm', ['pack', packageRoot, '--ignore-scripts', '--pack-destination', root, '--json']));
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0].filename !== 'string' || basename(packed[0].filename) !== packed[0].filename) throw new Error('Cannot prepare the persistent installer package');
  await effects.run('npm', ['install', '--prefix', root, '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', join(root, packed[0].filename)], { stream: true });
  if (!existsSync(entry)) throw new Error('Persistent installer entry is missing');
  await effects.run(process.execPath, [entry, '--help']);
  atomicWriteConfig(ready, 'ready\n');
  return entry;
}

/** Called under the normal installation lock; retries never overwrite imported state. */
export async function executeLegacyMigration(args, effects, install, deps = {}) {
  const stage = deps.stageLegacyState ?? stageLegacyState;
  const lock = deps.withLegacyStateLock ?? withLegacyStateLock;
  const save = (root, value) => (deps.atomicWriteConfig ?? atomicWriteConfig)(journalPath(root), JSON.stringify(value, null, 2) + '\n');
  const prepareCli = deps.prepareMigrationCliRuntime ?? prepareMigrationCliRuntime;
  const inspected = args.legacyPlan ?? await inspectLegacyMigration(args, effects, deps);
  let journal = readJournal(args.stateDir) ?? inspected.journal;
  if (journal.phase === 'complete') {
    const retained = effects.readJson(join(args.stateDir, 'installation.json'));
    inspected.cliPlan.installerPath = await prepareCli(retained, effects);
    await (deps.installManagedCli ?? installManagedCli)(retained, inspected.cliPlan, effects);
    const rows = validateIdentities(parse(await effects.run('ours', ['identity', 'list', '--json'])), { rootName: journal.identities.find(row => row.kind === 'root')?.name });
    if (JSON.stringify(rows) !== JSON.stringify(journal.identities)) throw new Error('Completed migration identity verification failed; no replacement Human was created');
    effects.out('Legacy migration already completed; retained identities verified.');
    return 0;
  }
  const source = inspected.source;
  let record;
  let sourceLock;
  let activationAttempted = phases.indexOf(journal.phase) >= phases.indexOf('activating');
  const wrapped = { ...effects,
    newInstallation(root, mode) {
      if (journal.record) {
        if (journal.record.root !== root || journal.record.mode !== mode) throw new Error('Migration target selection changed');
        return validateInstallation(journal.record, root);
      }
      return effects.newInstallation(root, mode);
    },
    async initializeSelection(selected, manifest) {
      record = selected;
      selected.legacyMigrationSource = args.migrateFrom;
      journal.record = selected;
      journal.sourcePolicy = args.sourcePolicy;
      journal.sourceManifest = manifest;
      save(selected.root, journal);
      effects.writeJson(join(selected.root, 'installation.json'), JSON.stringify(selected, null, 2) + '\n');
      await effects.initializeSelection(selected, manifest, { retainConfig: true });
    },
    async serverPreflight(selected, operation, options) {
      if (journal.record && !existsSync(selected.sourcesPath)) {
        if (!journal.sourceManifest) throw new Error('Migration journal lacks its retained package selection');
        await effects.initializeSelection(selected, journal.sourceManifest, { retainConfig: true });
      }
      return effects.serverPreflight(selected, operation, options);
    },
    async prepareInstallation(selected) {
      record = selected;
      if (!existsSync(selected.sourcesPath)) {
        const manifest = journal.sourceManifest ?? await effects.resolveSourcePolicy(args.sourcePolicy, 'server');
        await effects.initializeSelection(selected, manifest, { retainConfig: true });
      }
      await effects.prepareInstallation(selected, { runtimeOnly: true });
      if (selected.mode === 'docker') await effects.prepareLegacyDockerImport(selected);
      inspected.cliPlan.installerPath = await prepareCli(selected, effects);
      journal.cliInstallerPath = inspected.cliPlan.installerPath;
      if (activationAttempted) await effects.serverLifecycle(selected, 'stop');
      // Backups contain secrets; the enclosing installation is private.
      const backup = join(selected.root, 'legacy-backup');
      mkdirSync(backup, { mode: 0o700, recursive: true });
      const configBackup = join(backup, 'config.json');
      if (!existsSync(configBackup)) writeFileSync(configBackup, readFileSync(source.configPath), { flag: 'wx', mode: 0o600 });
      if (journal.service.serviceFile && existsSync(journal.service.serviceFile) && !existsSync(join(backup, 'service'))) {
        writeFileSync(join(backup, 'service'), readFileSync(journal.service.serviceFile), { flag: 'wx', mode: 0o600 });
      }
      save(selected.root, journal);
      if (!activationAttempted) {
        effects.out('Migration: retire the old boot service and stop its daemon.');
        if (journal.service.legacyUnit) await effects.run('systemctl', ['--user', 'disable', '--now', journal.service.legacyUnit]);
        else await oldCommand(effects, source, ['daemon', 'uninstall-service', '--yes']);
        await oldCommand(effects, source, ['daemon', 'stop']);
        journal.phase = 'stopped'; save(selected.root, journal);
      }
      // Hold the SDK-compatible owner lock until activation finishes, including failures.
      sourceLock = await lock(source.stateDir);
      effects.out('Migration: copy retained identities, keys, history and session state.');
      stage(source, selected);
      if (selected.mode === 'docker') await effects.importLegacyDockerState(selected);
      if (!activationAttempted) { journal.phase = 'copied'; save(selected.root, journal); }
      await effects.prepareInstallation(selected);
    },
    async serverLifecycle(selected, operation, services) {
      if (operation === 'start') {
        activationAttempted = true;
        journal.phase = 'activating'; save(selected.root, journal);
      }
      return effects.serverLifecycle(selected, operation, services);
    },
    async serverEnsureIdentity(selected) {
      const rows = await effects.serverListIdentities(selected);
      const actual = validateIdentities(rows, source);
      if (JSON.stringify(actual) !== JSON.stringify(journal.identities)) throw new Error('Migrated identities differ from the source; no replacement Human was created');
      journal.phase = 'verified'; save(selected.root, journal);
      const root = actual.find(r => r.kind === 'root');
      return { ...root, created: false };
    },
  };
  try {
    const result = await install({ ...args, migrate: true }, wrapped);
    if (result !== 0) throw new Error('Migrated server setup did not complete');
    // Publish an explicit host profile; a daemon --config file is not a client profile.
    const directory = join(record.root, 'legacy-client');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const credentialPath = join(directory, 'credential');
    if (!existsSync(credentialPath)) await effects.serverAccess(record, 'access-issue', { output: credentialPath });
    const profile = { endpoint: `http://127.0.0.1:${record.port}`, expectedInstanceId: record.instanceId, credentialPath };
    atomicWriteConfig(join(directory, 'profile.json'), JSON.stringify(profile, null, 2) + '\n');
    await (deps.installManagedCli ?? installManagedCli)(record, inspected.cliPlan, effects);
    const defaultRows = validateIdentities(parse(await effects.run('ours', ['identity', 'list', '--json'])), source);
    if (JSON.stringify(defaultRows) !== JSON.stringify(journal.identities)) throw new Error('Default ours command does not select the migrated identities');
    journal.phase = 'complete'; save(record.root, journal);
    effects.out(`Migration complete. Original state remains at ${source.stateDir}; original config/service are backed up in ${join(record.root, 'legacy-backup')}. Do not start the original state alongside the migrated daemon.`);
    return 0;
  } catch (error) {
    if (record && activationAttempted) {
      try { await effects.serverLifecycle(record, 'stop'); }
      catch { throw new Error(`Migration activation failed and destination shutdown could not be confirmed. Keep the source stopped; repair this same target. ${error.message}`); }
      throw new Error(`Migration paused after activation; source remains stopped to avoid diverging identity sessions. Repeat the same migration command to repair the retained target. ${error.message}`);
    }
    throw new Error(`Migration paused before activation; source data is retained. Repeat the same migration command. ${error.message}`);
  } finally { await sourceLock?.close(); }
}
