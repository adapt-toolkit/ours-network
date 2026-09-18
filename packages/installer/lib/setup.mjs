import { join } from 'node:path';
import { parseSetupArgs, collectSetupOptions, validateSetupOptions } from './setup-options.mjs';
import { parseNetworkArgs, validateHostProfile, InstallUsageError } from './target.mjs';
import { validateInstallation } from './plan.mjs';
import { runServerCommand, runClientCommand } from './orchestrate.mjs';
import { banner, heading, info, ok, warn, progress } from './ui.mjs';
import { isCancel } from './prompt.mjs';
import { USAGE } from './usage.mjs';
import { validateIdentityName } from './server-onboarding.mjs';
import { validateFleetSettings } from './fleet-settings.mjs';

const maintenance = new Set(['status', 'start', 'stop', 'restart', 'rebuild', 'access-issue', 'access-replace', 'backup', 'restore', 'reset']);
const clientPackages = integrations => [...new Set(['sdk', ...(integrations.includes('fleet') ? ['cli'] : []), ...integrations])];

export function completeReleasePolicy(retained, supplied) {
  if (retained?.release) {
    return { release: retained.release, packages: Object.fromEntries(Object.entries(retained.release.packages).map(([name, entry]) => [name, { type: 'npm', version: entry.version }])) };
  }
  if (supplied) return supplied;
  throw new InstallUsageError('This development installation needs its full --sources policy to configure clients; server-only selections cannot supply client packages');
}

function readObject(effects, path, label) {
  const value = effects.readJson(path);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InstallUsageError(`${label} must be a readable JSON object: ${path}`);
  return value;
}

/** Read-only validation of the complete plan, before any locks, installs or service changes. */
export async function prepareSetupPlan(options, effects) {
  options = validateSetupOptions(options, { interactive: options.interactive });
  if (effects.platform?.platform === 'win32') throw new InstallUsageError('Run ours-install inside WSL with Docker Desktop integration on Windows. Direct Windows Node installations are not supported.');
  const plan = { ...options };
  if (options.scope !== 'client') validateIdentityName(options.identityName);
  if (options.fleetSettingsPath) validateFleetSettings(readObject(effects, options.fleetSettingsPath, 'Fleet settings'));
  const policy = options.sources ? readObject(effects, options.sources, 'Source policy') : effects.packagedSourcePolicy();
  plan.sourcePolicy = policy;
  if (options.scope !== 'client') {
    const value = effects.readJson(join(options.stateDir, 'installation.json'));
    if (value) {
      plan.existing = validateInstallation(value, options.stateDir);
      if (options.mode !== plan.existing.mode) throw new InstallUsageError('The selected mode conflicts with the retained installation; choose its existing mode or a separate empty directory');
      for (const key of ['port', 'coworkPort', 'messengerPort']) {
        if (options.explicitPorts?.includes(key) && options[key] !== plan.existing[key]) throw new InstallUsageError(`${key} conflicts with the retained installation`);
        plan[key] = plan.existing[key];
      }
      if (options.operation === 'install') {
        const retained = readObject(effects, plan.existing.sourcesPath, 'Retained source policy');
        plan.sourcePolicy = options.scope === 'server' || !options.integrations?.length ? retained : completeReleasePolicy(retained, options.sources ? policy : null);
      }
    } else if (options.operation === 'update') {
      throw new InstallUsageError('Update requires an existing installation.json; choose install for a new installation');
    }
    // Reject a local client already attached to another server before changing the server.
    const saved = options.scope === 'all' && options.integrations.length ? effects.readManagedClientProfile() : null;
    if (saved && (!plan.existing || saved.expectedInstanceId !== plan.existing.instanceId || saved.endpoint !== `http://127.0.0.1:${plan.port}`)) {
      throw new InstallUsageError('This user already has clients attached to a different server; their saved connection was not changed');
    }
  } else {
    const profile = validateHostProfile(readObject(effects, options.config, 'Client profile'));
    if (!profile) throw new InstallUsageError('Client profile must contain endpoint, expectedInstanceId and credentialPath');
    if (!effects.readText(profile.credentialPath)?.trim()) throw new InstallUsageError('Client credential file is missing or empty');
    plan.profile = profile;
    const saved = effects.readManagedClientProfile();
    if (saved && (saved.endpoint !== profile.endpoint || saved.expectedInstanceId !== profile.expectedInstanceId)) throw new InstallUsageError('Managed clients already select another server; existing connection was not changed');
    if (saved && options.operation === 'install' && !options.sources) plan.sourcePolicy = readObject(effects, saved.installer.sourcesPath, 'Retained client source policy');
  }
  // Dry-run never spawns a resolver or acquires an installation lock.
  if (!options.dryRun) {
    if (options.scope === 'all' && options.operation === 'update' && options.integrations.length) {
      const running = await effects.serverLifecycle(plan.existing, 'status', ['daemon']);
      if (!running.includes('daemon')) throw new InstallUsageError('Full-stack update requires the selected daemon to be running for client verification. Start it first, or use server update to preserve its stopped state.');
    }
    if (options.scope !== 'client') await effects.resolveSourcePolicy(plan.sourcePolicy, 'server');
    if (options.scope !== 'server' && options.integrations.length) await effects.resolveSourcePolicy(plan.sourcePolicy, 'client', clientPackages(options.integrations));
  }
  return plan;
}

export async function executeSetupPlan(plan, effects, { server = runServerCommand, client = runClientCommand } = {}) {
  if (!plan.interactive) effects.out(banner());
  effects.out(heading(`${plan.operation === 'update' ? 'Update' : 'Install'} ours.network`));
  effects.out(info(`Scope: ${plan.scope}; ${plan.scope === 'client' ? `profile: ${plan.config}` : `mode: ${plan.mode === 'packages' ? 'native' : 'docker'}; directory: ${plan.stateDir}`}`));
  if (plan.scope !== 'server') effects.out(info(`Client integrations: ${plan.integrations.join(', ') || 'none'}`));
  if (plan.dryRun) {
    effects.out(info('Preview only. No packages, identities, credentials or services will be changed.'));
    if (plan.scope !== 'client') effects.out(info('Server: prerequisites → runtime preparation/update → retained identity/state restoration → readiness.'));
    if (plan.scope !== 'server' && plan.integrations.length) effects.out(info('Clients: private connection → exact packages → selected integrations → Fleet settings when selected.'));
    return 0;
  }
  let clientConfig = plan.config;
  let clientPolicy = plan.sourcePolicy;
  if (plan.scope !== 'client') {
    effects.out(heading(plan.operation === 'update' ? 'Server update and identity restoration' : 'Server installation'));
    const result = await server({ ...plan, role: 'server', operation: plan.operation, sourcePolicy: plan.sourcePolicy }, effects);
    if (result !== 0) return result;
    const record = validateInstallation(effects.readJson(join(plan.stateDir, 'installation.json')), plan.stateDir);
    if (plan.operation === 'update') {
      effects.out(progress(0, 1, 'Retained identities', 'Verify the Human identity after state restoration; existing names and keys are retained.'));
      const running = await effects.serverLifecycle(record, 'status', ['daemon']);
      if (running.includes('daemon')) {
        await effects.serverEnsureIdentity(record, plan.identityName);
        effects.out(ok('Retained identities verified.'));
      } else effects.out(info('Daemon remains stopped; stored identities are retained and will restore on the next start.'));
    }
    if (plan.scope === 'all' && plan.integrations.length) {
      clientPolicy = completeReleasePolicy(readObject(effects, record.sourcesPath, 'Server source policy'), plan.sourcePolicy);
      effects.out(heading('Connect local clients'));
      const handoff = await effects.prepareLocalClient(record, plan.integrations, plan.fleetSettingsPath);
      clientConfig = handoff.configPath;
    }
  }
  if (plan.scope !== 'server' && plan.integrations.length) {
    const result = await client({ role: 'client', operation: 'install', config: clientConfig,
      integrations: plan.integrations, fleetSettingsPath: plan.fleetSettingsPath, sourcePolicy: clientPolicy,
      preset: true, nonInteractive: !plan.interactive }, effects);
    if (result !== 0) return result;
  }
  effects.out(ok(`Requested ${plan.operation} completed. Existing identities were retained.`));
  if (plan.integrations?.includes('fleet')) effects.out(info('Fleet is configured but stopped. Review its settings, then run ours-fleet doctor, ours-fleet config and ours-fleet up.'));
  return 0;
}

/** The sole executable entry: manual answers and CLI presets share one plan/executor. */
export async function runSetup(argv, effects) {
  try {
    if (argv.includes('--help') || argv.includes('-h')) { effects.out(USAGE); return 0; }
    if (argv.length === 1 && ['--version', '-V'].includes(argv[0])) { effects.out(effects.version ?? 'unknown'); return 0; }
    if (argv[0] === 'server' && maintenance.has(argv[1])) return await runServerCommand(parseNetworkArgs(argv), effects);
    if (!argv.length) { effects.out(banner()); effects.out(heading('Interactive setup')); }
    const options = argv.length ? parseSetupArgs(argv, { home: effects.home }) : await collectSetupOptions(effects);
    const plan = await prepareSetupPlan(options, effects);
    return await executeSetupPlan(plan, effects);
  } catch (error) {
    if (isCancel(error)) { effects.out(warn('Installation cancelled.')); return 130; }
    effects.out(warn(`ours-install: ${error.message}`));
    return 2;
  }
}
