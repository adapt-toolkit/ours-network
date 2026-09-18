import { join, resolve } from 'node:path';

const scopes = ['all', 'server', 'client'];
const integrations = ['codex', 'claude-code', 'fleet'];
const valueFlags = new Map(Object.entries({
  '--scope': 'scope', '--action': 'operation', '--mode': 'mode', '--state-dir': 'stateDir',
  '--identity-name': 'identityName', '--integrations': 'integrations', '--fleet-settings': 'fleetSettingsPath',
  '--config': 'config', '--sources': 'sources', '--port': 'port', '--cowork-port': 'coworkPort', '--messenger-port': 'messengerPort',
}));
const boolFlags = new Map([['--compatible', 'compatible'], ['--dry-run', 'dryRun'], ['--migrate', 'migrate']]);
const allowed = new Set([...valueFlags.values(), ...boolFlags.values(), 'interactive', 'explicitPorts']);
const defaults = { port: 3050, coworkPort: 3052, messengerPort: 8420 };
const paths = ['stateDir', 'config', 'sources', 'fleetSettingsPath'];
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
  const missing = [];
  if (server) for (const [key, flag] of [['mode', '--mode'], ['stateDir', '--state-dir'], ['identityName', '--identity-name']]) if (!nonempty(options[key])) missing.push(flag);
  if (client && options.integrations === undefined) missing.push('--integrations (use none to skip)');
  if (!server && !nonempty(options.config)) missing.push('--config');
  if (server && options.operation === 'update' && options.compatible !== true) missing.push('--compatible');
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
    options.identityName = options.identityName.trim();
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
    } else output[key] = resolve(value);
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
  options.scope = (await effects.askLine('Set up all, server, or client? ', 'all')).trim();
  if (!scopes.includes(options.scope)) throw new Error('Scope must be all, server, or client');
  let existing;
  if (options.scope !== 'client') {
    options.stateDir = await effects.askLine('Private installation root: ', join(effects.home, '.ours-install'));
    options.stateDir = expandPaths({ stateDir: options.stateDir }, effects.home).stateDir;
    existing = effects.readJson(join(options.stateDir, 'installation.json'));
  }
  options.operation = (await effects.askLine('Install or update? ', existing ? 'update' : 'install')).trim();
  if (options.scope !== 'client') {
    const recommendation = recommendedMode({ ...effects.platform, arch: effects.platform?.arch ?? process.arch });
    effects.out(recommendation.reason);
    options.mode = await effects.askLine('Runtime mode (packages or docker): ', existing?.mode ?? recommendation.mode);
    options.identityName = await effects.askLine('What name should others see? ', existing?.identityName ?? effects.username?.() ?? 'me');
    for (const [key, fallback] of Object.entries(defaults)) {
      const label = { port: 'Daemon', coworkPort: 'Cowork', messengerPort: 'Messenger' }[key];
      const value = await effects.askLine(`${label} port: `, String(existing?.[key] ?? fallback));
      if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} port must be an integer`);
      options[key] = Number(value); options.explicitPorts.push(key);
    }
    if (options.operation === 'update') options.compatible = await effects.ask('Confirm that the selected update is compatible with retained state?', false);
  } else options.config = await effects.askLine('Prepared client profile path: ', join(effects.home, '.ours-client', 'profile.json'));
  if (options.scope !== 'server') {
    const detected = typeof effects.detectHarnesses === 'function' ? await effects.detectHarnesses() : [];
    options.integrations = [];
    for (const name of integrations) if (await effects.ask(`Install ${name}?`, name === 'fleet' || detected.some(item => item.name === name && item.status === 'ok'))) options.integrations.push(name);
    if (options.integrations.includes('fleet')) {
      const path = await effects.askLine('Fleet settings file (leave empty for the interactive Fleet wizard): ', '');
      if (path.trim()) options.fleetSettingsPath = path;
    }
  }
  const sources = await effects.askLine('Source policy override (leave empty for the packaged release): ', '');
  if (sources.trim()) options.sources = sources;
  const validated = validateSetupOptions(expandPaths(options, effects.home), { interactive: true });
  effects.out(`Setup: ${validated.operation} ${validated.scope}${validated.mode ? ` using ${validated.mode} in ${validated.stateDir}` : ` from ${validated.config}`}; integrations: ${validated.integrations?.join(', ') || 'none'}.`);
  if (!await effects.ask('Continue with this setup?', false)) throw new Error('Setup cancelled; nothing was changed');
  return validated;
}
