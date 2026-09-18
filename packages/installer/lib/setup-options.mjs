import { join, resolve, isAbsolute, dirname } from 'node:path';

const scopes = ['all', 'server', 'client'];
const integrations = ['codex', 'claude-code', 'fleet'];
const valueFlags = new Map(Object.entries({
  '--scope': 'scope', '--action': 'operation', '--mode': 'mode', '--state-dir': 'stateDir',
  '--identity-name': 'identityName', '--integrations': 'integrations', '--fleet-settings': 'fleetSettingsPath',
  '--config': 'config', '--sources': 'sources', '--migrate-from': 'migrateFrom', '--port': 'port', '--cowork-port': 'coworkPort', '--messenger-port': 'messengerPort',
}));
const boolFlags = new Map([['--compatible', 'compatible'], ['--dry-run', 'dryRun'], ['--migrate', 'migrate']]);
const allowed = new Set([...valueFlags.values(), ...boolFlags.values(), 'interactive', 'explicitPorts']);
const defaults = { port: 3050, coworkPort: 3052, messengerPort: 8420 };
const paths = ['stateDir', 'config', 'sources', 'fleetSettingsPath', 'migrateFrom'];
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);

export function recommendedMode({ platform, arch, release = '' } = {}) {
  if (platform === 'linux' && /microsoft|wsl/i.test(release)) return { mode: 'docker', reason: 'Docker is recommended on Windows and WSL.' };
  if (platform === 'linux' && arch === 'x64') return { mode: 'packages', reason: 'Native packages are recommended on Linux x64 with a systemd user manager.' };
  if (platform === 'darwin') return { mode: 'docker', reason: 'Docker is recommended on macOS.' };
  if (platform === 'win32') return { mode: 'docker', reason: 'Docker is recommended on Windows; run the installer inside WSL with Docker Desktop.' };
  return { mode: 'docker', reason: 'Docker is recommended for this platform.' };
}

export function validateSetupOptions(input, { interactive = input?.interactive === true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Setup options must be an object');
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown setup option: ${key}`);
  const options = { ...input, scope: input.scope ?? 'all', operation: input.operation ?? 'install', interactive };
  if (!scopes.includes(options.scope)) throw new Error('Scope must be all, server, or client');
  if (!['install', 'update'].includes(options.operation)) throw new Error('Operation must be install or update');
  const server = options.scope !== 'client';
  const client = options.scope !== 'server';
  if (options.migrateFrom !== undefined && (!server || options.operation !== 'install')) throw new Error('--migrate-from requires server or all scope and operation install');
  if (options.migrateFrom !== undefined && (!nonempty(options.migrateFrom) || !isAbsolute(options.migrateFrom))) throw new Error('--migrate-from requires an absolute daemon config path');
  const missing = [];
  if (server) for (const [key, flag] of [['mode', '--mode'], ['stateDir', '--state-dir'], ...(options.migrateFrom === undefined ? [['identityName', '--identity-name']] : [])]) if (!nonempty(options[key])) missing.push(flag);
  if (client && options.integrations === undefined) missing.push('--integrations (use none to skip)');
  if (!server && !nonempty(options.config)) missing.push('--config');
  if (server && (options.operation === 'update' || options.migrateFrom !== undefined) && options.compatible !== true) missing.push('--compatible');
  if (Array.isArray(options.integrations) && options.integrations.includes('fleet') && !interactive && !nonempty(options.fleetSettingsPath)) missing.push('--fleet-settings');
  if (missing.length) throw new Error(`Missing required setup options: ${missing.join(', ')}`);
  if (options.mode === 'native') options.mode = 'packages';
  if (server && !['packages', 'docker'].includes(options.mode)) throw new Error('Mode must be packages (or native) or docker');
  if (server && options.config !== undefined) throw new Error('--config is only valid for client scope');
  if (!server) for (const key of ['mode', 'stateDir', 'identityName', ...Object.keys(defaults), 'compatible', 'migrate']) {
    if (options[key] !== undefined) throw new Error(`${key} is only valid for server or all scope`);
  }
  if (!client && (options.integrations !== undefined || options.fleetSettingsPath !== undefined)) throw new Error('--integrations and --fleet-settings require all or client scope');
  if (options.integrations !== undefined) {
    if (!Array.isArray(options.integrations) || options.integrations.some(name => !integrations.includes(name)) || new Set(options.integrations).size !== options.integrations.length) throw new Error('Integrations must be unique codex, claude-code, fleet, or none');
    options.integrations = [...options.integrations];
  }
  if (options.fleetSettingsPath !== undefined && !options.integrations?.includes('fleet')) throw new Error('--fleet-settings requires the fleet integration');
  for (const key of paths) if (options[key] !== undefined && !nonempty(options[key])) throw new Error(`Invalid path for ${key}`);
  for (const key of ['compatible', 'migrate']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  if (server) {
    if (options.identityName !== undefined) {
      if (!nonempty(options.identityName)) throw new Error('Invalid Human identity name');
      options.identityName = options.identityName.trim();
    }
    for (const [key, fallback] of Object.entries(defaults)) {
      options[key] ??= fallback;
      if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > 65535) throw new Error(`${key} must be an integer port between 1 and 65535`);
    }
    if (new Set(Object.keys(defaults).map(key => options[key])).size !== 3) throw new Error('Server ports must be distinct');
  }
  options.explicitPorts ??= [];
  if (!Array.isArray(options.explicitPorts) || options.explicitPorts.some(key => !Object.hasOwn(defaults, key)) || new Set(options.explicitPorts).size !== options.explicitPorts.length || (!server && options.explicitPorts.length)) throw new Error('Invalid explicitPorts selection');
  options.explicitPorts = [...options.explicitPorts];
  return options;
}

function expandPaths(options, home) {
  const output = { ...options };
  for (const key of paths) if (nonempty(output[key])) {
    const value = output[key];
    if (value === '~' || value.startsWith('~/')) {
      if (!nonempty(home)) throw new Error('Home directory is required to expand ~/ paths');
      output[key] = resolve(home, value === '~' ? '' : value.slice(2));
    } else {
      if (key === 'migrateFrom' && !isAbsolute(value)) throw new Error('--migrate-from requires an absolute daemon config path');
      output[key] = resolve(value);
    }
  }
  return output;
}

export function parseSetupArgs(argv, { home } = {}) {
  if (!Array.isArray(argv) || !argv.every(arg => typeof arg === 'string')) throw new Error('Arguments must be strings');
  const options = { interactive: false, explicitPorts: [] };
  const seen = new Set();
  const positional = [];
  const put = (key, value) => {
    if (seen.has(key)) throw new Error(`Duplicate or conflicting setup option: ${key}`);
    seen.add(key); options[key] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const equal = arg.indexOf('=');
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    if (boolFlags.has(flag)) {
      if (equal >= 0) throw new Error(`${flag} takes no value`);
      put(boolFlags.get(flag), true); continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`Unknown setup flag: ${flag}`);
    const value = equal < 0 ? argv[++i] : arg.slice(equal + 1);
    if (!nonempty(value) || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    const key = valueFlags.get(flag);
    if (key === 'integrations') put(key, value === 'none' ? [] : value.split(',').map(item => item.trim()));
    else if (Object.hasOwn(defaults, key)) {
      if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag} requires an integer port`);
      put(key, Number(value)); options.explicitPorts.push(key);
    } else put(key, value);
  }
  if (positional.length && scopes.includes(positional[0])) put('scope', positional.shift());
  if (positional.length && ['install', 'update'].includes(positional[0])) put('operation', positional.shift());
  if (positional.length) throw new Error(`Unexpected setup argument: ${positional.join(' ')}`);
  return validateSetupOptions(expandPaths(options, home), { interactive: false });
}

export async function collectSetupOptions(effects) {
  if (effects.interactive !== true) throw new Error('Interactive setup requires a TTY; provide the complete CLI options instead');
  const options = { interactive: true, explicitPorts: [] };
  const scopeChoices = [
    { value: 'all', label: 'Everything on this computer' },
    { value: 'server', label: 'Server only' },
    { value: 'client', label: 'Connect this computer to an existing server' },
  ];
  effects.out('Choose what this computer should do. Everything runs the server here and connects your selected apps; client-only uses a server you already have.');
  options.scope = await effects.select('What would you like to set up?', scopeChoices, 'all');
  if (!scopes.includes(options.scope)) throw new Error('Scope must be all, server, or client');
  let existing;
  let pendingMigration;
  if (options.scope !== 'client') {
    const recommendedRoot = join(effects.home, '.ours-install');
    effects.out(`Stores the server programs and data, including identities and messages. The recommended folder is ${recommendedRoot}; choose another only if you want to manage its location yourself.`);
    const location = await effects.select('Where should server programs and data be stored?', [
      { value: 'recommended', label: `Use the recommended folder (${recommendedRoot})` },
      { value: 'custom', label: 'Choose another folder' },
    ], 'recommended');
    options.stateDir = location === 'recommended' ? recommendedRoot : await effects.askLine('Folder for server programs and data: ', recommendedRoot);
    options.stateDir = expandPaths({ stateDir: options.stateDir }, effects.home).stateDir;
    existing = effects.readJson(join(options.stateDir, 'installation.json'));
    const migrationJournal = existing?.legacyMigrationSource ? effects.readJson(join(options.stateDir, 'legacy-migration.json')) : null;
    pendingMigration = existing?.legacyMigrationSource && migrationJournal?.phase !== 'complete' ? existing.legacyMigrationSource : null;
  }
  effects.out(pendingMigration
    ? 'An earlier migration is unfinished. Resume it in this same folder to retain the copied data and repair the installation.'
    : existing
    ? 'This folder already contains an installation. Update selects this installer’s release while retaining state; repair reinstalls the retained package selection.'
    : options.scope === 'client' ? 'Install connects your selected apps. Update refreshes their packages while keeping the server connection.'
      : 'Install creates a managed installation in the selected folder. Update requires an installation already recorded there.');
  options.operation = !existing && options.scope !== 'client' ? 'install' : await effects.select('What should happen?', [
    { value: 'install', label: pendingMigration ? 'Resume the unfinished migration' : existing ? 'Repair this installation' : 'Install and configure' },
    { value: 'update', label: 'Update an existing installation' },
  ], existing && !pendingMigration ? 'update' : 'install');
  if (options.scope !== 'client' && options.operation === 'install') {
    const defaultConfig = join(effects.home, '.ours', 'config.json');
    const legacy = !existing ? effects.readJson(defaultConfig) : null;
    const legacyState = nonempty(legacy?.stateDir) ? legacy.stateDir
      : legacy && legacy.stateDir === undefined && nonempty(effects.readJson(join(effects.home, '.ours', 'root.json'))?.name)
        ? join(effects.home, '.ours') : null;
    if (pendingMigration) options.migrateFrom = pendingMigration;
    else if (legacyState) {
      effects.out(`Found an existing ours installation at ${legacyState}. Upgrade it to keep its identities, messages and settings. The old server will stop; its original state is kept as a recovery copy.`);
      if (await effects.ask('Upgrade this existing ours installation and keep its data?', true)) options.migrateFrom = defaultConfig;
      else {
        effects.out('A separate installation creates a different server. It does not move or share the identities and messages in the existing installation.');
        if (!await effects.ask('Create a separate fresh installation and keep the existing daemon unchanged?', false)) throw new Error('Setup cancelled; existing daemon was not changed');
      }
    } else {
      effects.out('Start fresh if you have no existing ours data to bring over. If your old installation is stored elsewhere, select its configuration file to retain its data.');
      const migration = await effects.select('Should existing ours data be brought over?', [
        { value: 'fresh', label: 'Start a fresh installation' },
        { value: 'migrate', label: 'Bring data from another existing installation' },
      ], 'fresh');
      if (migration === 'migrate') options.migrateFrom = expandPaths({ migrateFrom: await effects.askLine('Existing daemon configuration file: ', '') }, effects.home).migrateFrom;
    }
    if (options.migrateFrom) {
      if (existing && pendingMigration !== options.migrateFrom) throw new Error('--migrate-from requires a new managed installation root; the selected root already has installation.json');
      const sourceConfig = effects.readJson(options.migrateFrom);
      const sourceState = sourceConfig?.stateDir ?? dirname(options.migrateFrom);
      const root = effects.readJson(join(sourceState, 'root.json'));
      if (!nonempty(root?.name)) throw new Error('Cannot read the existing Human identity name; choose the configuration file for a complete existing installation');
      options.identityName = root.name;
      effects.out(`Your existing Human identity, ${root.name}, will be retained; no replacement identity will be created. Migration keeps the original state, but compatibility with an older release cannot be guaranteed automatically.`);
      options.compatible = await effects.ask('Proceed with this release and keep the original state as a recovery copy?', false);
      if (!options.compatible) throw new Error('Migration requires explicit compatibility confirmation (--compatible)');
    }
  }
  if (options.scope !== 'client') {
    const recommendation = recommendedMode({ ...effects.platform, arch: effects.platform?.arch ?? process.arch });
    effects.out(`${recommendation.reason} Native runs directly on this computer; Docker runs in containers and needs Docker installed and running. An existing installation must keep its current mode.`);
    options.mode = await effects.select('How should the server run?', [
      { value: 'packages', label: 'Native packages' }, { value: 'docker', label: 'Docker' },
    ], existing?.mode ?? recommendation.mode);
    if (!options.migrateFrom) {
      effects.out(existing ? 'Existing identities and names are retained. This name is used only if a Human identity needs to be created.' : 'Choose the name other people and agents should see for your Human identity.');
      options.identityName = await effects.askLine('What name should others see? ', existing?.messengerIdentity ?? effects.username?.() ?? 'me');
    }
    for (const [key, fallback] of Object.entries(defaults)) options[key] = existing?.[key] ?? fallback;
    if (options.operation === 'update') {
      effects.out('The update retains identities and messages and creates a recovery backup before changing stored state. Proceed only if you accept this release for your existing data; compatibility is not automatically guaranteed.');
      options.compatible = await effects.ask('Proceed with this update and keep a recovery backup?', false);
    }
  } else {
    const savedProfile = join(effects.home, '.ours-client', 'profile.json');
    effects.out('A connection profile identifies the server and its private access credential. Reuse your saved connection or select a profile supplied by the server owner.');
    const connection = await effects.select('Which server connection should this computer use?', [
      { value: 'saved', label: 'Use the saved server connection' }, { value: 'file', label: 'Choose a connection profile file' },
    ], effects.readJson(savedProfile) ? 'saved' : 'file');
    options.config = connection === 'saved' ? savedProfile : await effects.askLine('Connection profile file: ', savedProfile);
  }
  if (options.scope !== 'server') {
    const detected = typeof effects.detectHarnesses === 'function' ? await effects.detectHarnesses() : [];
    const selected = integrations.filter(name => name === 'fleet' || detected.some(item => item.name === name && item.status === 'ok'));
    effects.out('Choose the apps to connect. Detected agent apps are selected by default; Fleet configures persistent agents but leaves them stopped. Use Space to toggle choices, then Enter to continue. You can select none.');
    options.integrations = await effects.multiselect('Which integrations should be configured?', [
      { value: 'codex', label: 'Codex' }, { value: 'claude-code', label: 'Claude Code' }, { value: 'fleet', label: 'Fleet — persistent agents' },
    ], selected);
    if (options.integrations.includes('fleet')) {
      effects.out('Fleet needs model and agent settings. Its guided setup asks for these later; a prepared settings file applies your existing choices. Fleet roles will not start automatically.');
      const fleetMode = await effects.select('How should Fleet be configured?', [
        { value: 'wizard', label: 'Configure interactively with Fleet' }, { value: 'file', label: 'Use a prepared settings file' },
      ], 'wizard');
      if (fleetMode === 'file') options.fleetSettingsPath = await effects.askLine('Fleet settings file: ', '');
    }
  }
  effects.out('Recommended settings use the standard service ports and this installer’s packaged release. Customize only if you need different ports or a development package selection.');
  const advanced = await effects.select('Installation settings', [
    { value: 'recommended', label: 'Use recommended settings' }, { value: 'custom', label: 'Customize' },
  ], 'recommended');
  if (advanced === 'custom') {
    if (options.scope !== 'client') {
      effects.out('Ports determine where local apps reach each service. Use three different available ports; an existing installation keeps its recorded ports.');
      for (const key of Object.keys(defaults)) {
        const label = { port: 'Daemon', coworkPort: 'Cowork', messengerPort: 'Messenger' }[key];
        const value = await effects.askLine(`${label} port: `, String(options[key]));
        if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} port must be an integer`);
        options[key] = Number(value); options.explicitPorts.push(key);
      }
    }
    effects.out('A source override replaces the packaged release selection. Leave it empty for the supported packaged release; use a file only for a deliberate development override.');
    const sources = await effects.askLine('Source policy override file (optional): ', '');
    if (sources.trim()) options.sources = sources;
  }
  const validated = validateSetupOptions(expandPaths(options, effects.home), { interactive: true });
  const scopeLabel = scopeChoices.find(choice => choice.value === validated.scope).label;
  effects.out(`Setup: ${scopeLabel}; ${validated.operation}${validated.mode ? ` using ${validated.mode === 'packages' ? 'native packages' : 'Docker'} in ${validated.stateDir}` : ` from ${validated.config}`}; integrations: ${validated.integrations?.join(', ') || 'none'}${validated.migrateFrom ? `; migrate from: ${validated.migrateFrom}` : ''}.`);
  effects.out('Continue to apply these choices. Cancelling now leaves programs, services and data unchanged.');
  if (!await effects.ask('Continue with this setup?', false)) throw new Error('Setup cancelled; nothing was changed');
  return validated;
}
