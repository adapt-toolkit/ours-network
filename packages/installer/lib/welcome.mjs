// The first screen of `ours-install` with no arguments.
//
// It starts from what the person wants, not from how Ours is built: add
// collaboration tools to the agent apps they already use, install the complete
// workspace, or connect to a workspace that already runs elsewhere. When Ours is
// already here, it offers to update, repair or remove what is installed, and
// keeps the kind of installation the person chose.
//
// This file only asks and explains. It returns the same validated setup options
// the CLI presets produce (or a removal request), so every path runs the same
// installer underneath.

import { join } from 'node:path';
import { validateInstallation } from './plan.mjs';
import { productOf, isPluginOnly, PLUGIN_ONLY, PRODUCT_LABELS, PLUGIN_ONLY_INTEGRATIONS } from './product.mjs';
import { validateSetupOptions, defaultHostname } from './setup-options.mjs';
import { validateIdentityName } from './server-onboarding.mjs';
import { heading, info } from './ui.mjs';

export const KEEPS_YOUR_SETUP = 'Your existing agent configuration, skills, plugins and custom settings stay as they are. Ours adds its own tools next to them; it does not replace or reconfigure your setup.';

export const WORKSPACE_BENEFITS = [
  'The complete Ours workspace adds, on this computer:',
  '  - Rooms: a room of agents for each task, where they work on it together',
  '  - Invitations: bring in agents and people from outside, with their own identities',
  '  - Tracking: follow tasks and every agent\'s progress in one place',
  '  - Mobile: reach your agents from the Ours app on your phone',
  '  - Persistent agents: define agents that keep running and remember their role',
  '  - Orchestration: Claude Code, Codex and other agent apps and vendors working together',
];

export const TOOLS_SUMMARY = [
  'Collaboration tools give the agent apps you already use their own secure Ours identity,',
  'so they can message other agents and people, share files and be woken when mail arrives.',
  'It runs one small background service in Docker or Podman on this computer — nothing else.',
];

/** Managed installations on this computer, in the default and ~/.ours* folders. */
export function findInstallations(effects, extra = []) {
  const home = effects.home;
  const names = typeof effects.list === 'function' ? effects.list(home) ?? [] : [];
  const roots = [...new Set([join(home, '.ours-install'), ...names.filter(n => n.startsWith('.ours')).map(n => join(home, n)), ...extra])];
  const found = [];
  for (const root of roots) {
    const value = effects.readJson(join(root, 'installation.json'));
    if (!value) continue;
    try {
      const record = validateInstallation(value, root);
      const journal = record.legacyMigrationSource ? effects.readJson(join(root, 'legacy-migration.json')) : null;
      found.push({ root, record, product: productOf(record),
        pending: record.buildTransition ? record.buildTransition.operation : record.layoutConversion ? 'install'
          : record.legacyMigrationSource && journal?.phase !== 'complete' ? 'install' : null });
    } catch { found.push({ root, invalid: true }); }
  }
  return found;
}

function describe(item) {
  if (item.invalid) return `An Ours folder that could not be read: ${item.root}`;
  const engine = item.record.mode === 'packages' ? 'directly on this computer' : item.record.containerEngine === 'podman' ? 'in Podman' : 'in Docker';
  return `${PRODUCT_LABELS[item.product]} — folder ${item.root}, running ${engine}`;
}

const defaultIdentity = effects => `${String(effects.username?.() ?? 'me').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 30) || 'me'}@${defaultHostname()}`;

async function askIdentity(effects) {
  effects.out('Choose the name other people and agents will see for you. Your agents get their own identities under it later.');
  for (;;) {
    const name = (await effects.askLine('Your name in Ours: ', defaultIdentity(effects))).trim();
    try { validateIdentityName(name); return name; }
    catch { effects.out('Use 1–64 characters without slashes or control characters.'); }
  }
}

async function askFolder(effects) {
  const recommended = join(effects.home, '.ours-install');
  effects.out(`Ours keeps its service and your data in one folder. The recommended folder is ${recommended}.`);
  const where = await effects.select('Where should Ours keep its data?', [
    { value: 'recommended', label: `Use the recommended folder (${recommended})` },
    { value: 'custom', label: 'Choose another folder' },
  ], 'recommended');
  return where === 'recommended' ? recommended : await effects.askLine('Folder for Ours: ', recommended);
}

async function askEngine(effects) {
  let podman = false;
  try { podman = (await effects.run('sh', ['-c', 'command -v podman'], { allowCodes: [1, 127] })).code === 0; } catch { podman = false; }
  if (!podman) return {};
  effects.out('Ours runs its service in containers. Docker is recommended; choose Podman if that is what you use.');
  const engine = await effects.select('Which container app should run Ours?', [
    { value: 'docker', label: 'Docker (recommended)' }, { value: 'podman', label: 'Podman' },
  ], 'docker');
  return engine === 'podman' ? { containerEngine: 'podman' } : {};
}

/** Collaboration tools for existing agent apps: the plugin-only installation. */
async function collectTools(effects) {
  effects.out(heading('Collaboration tools for your agent apps'));
  for (const line of TOOLS_SUMMARY) effects.out(line);
  effects.out(KEEPS_YOUR_SETUP);
  const detected = typeof effects.detectHarnesses === 'function' ? await effects.detectHarnesses() : [];
  const found = name => detected.some(item => item.name === name && item.status === 'ok');
  const choices = [
    ...PLUGIN_ONLY_INTEGRATIONS.filter(found).map(name => ({ value: name, label: name === 'claude-code' ? 'Claude Code (found on this computer)' : 'Codex (found on this computer)' })),
    { value: 'custom', label: 'Another agent app — show me how to connect it' },
  ];
  const missing = PLUGIN_ONLY_INTEGRATIONS.filter(name => !found(name)).map(name => name === 'claude-code' ? 'Claude Code' : 'Codex');
  effects.out(`Choose the agent apps that should get the Ours tools. Use Space to select and Enter to continue.${missing.length ? ` Not found on this computer: ${missing.join(' and ')} — install it first and run ours-install again to connect it.` : ''}`);
  const selected = await effects.multiselect('Which agent apps should get the Ours tools?', choices, choices.filter(c => c.value !== 'custom').map(c => c.value));
  const integrations = selected.filter(name => name !== 'custom');
  const customHarness = selected.includes('custom');
  if (!integrations.length && !customHarness) throw Object.assign(new Error('Setup cancelled; no agent app was selected and nothing was changed'), { cancelled: true });
  const engine = await askEngine(effects);
  const stateDir = await askFolder(effects);
  const identityName = await askIdentity(effects);
  const options = validateSetupOptions({ scope: 'all', operation: 'install', product: PLUGIN_ONLY, mode: 'docker', ...engine, stateDir, identityName, integrations, interactive: true, explicitPorts: [] }, { interactive: true });
  effects.out(`Ready to install: collaboration tools for ${[...integrations.map(n => n === 'claude-code' ? 'Claude Code' : 'Codex'), ...(customHarness ? ['another agent app (instructions at the end)'] : [])].join(', ')}; data in ${stateDir}; your name: ${identityName}.`);
  effects.out('Nothing is changed until you continue. You can remove everything later with: ours-install remove');
  if (!await effects.ask('Install now?', true)) throw Object.assign(new Error('Setup cancelled; nothing was changed'), { cancelled: true });
  return { action: 'setup', options, customHarness };
}

/** Update, repair or remove what is already installed. */
async function collectExisting(effects, installations) {
  effects.out(heading('Ours is already set up on this computer'));
  for (const item of installations) effects.out(info(describe(item)));
  const usable = installations.filter(item => !item.invalid);
  let item = usable[0];
  if (usable.length > 1) {
    effects.out('Choose the installation to work with.');
    const root = await effects.select('Which installation?', usable.map(i => ({ value: i.root, label: describe(i) })), usable[0].root);
    item = usable.find(i => i.root === root);
  }
  if (!item) {
    effects.out('Its record could not be read, so it is not changed automatically. You can remove Ours completely, which lists everything first.');
    const next = await effects.select('What would you like to do?', [{ value: 'remove', label: 'Remove Ours from this computer' }, { value: 'cancel', label: 'Cancel' }], 'cancel');
    return { action: next };
  }
  const saved = (() => { try { return effects.readManagedClientProfile?.() ?? null; } catch { return null; } })();
  const clientBound = saved?.expectedInstanceId === item.record.instanceId;
  if (item.pending) {
    effects.out('An earlier update or setup step did not finish. Finishing it keeps your identities and data and repairs the installation.');
  } else {
    effects.out(`Update brings this ${item.product === PLUGIN_ONLY ? 'installation' : 'workspace'} to installer ${effects.version ?? 'this version'}, keeping your identities, data, connected agent apps and their settings. Repair runs setup again with the same choices. To switch between collaboration tools and the complete workspace, remove this installation first.`);
  }
  const action = await effects.select('What would you like to do?', [
    ...(item.pending ? [{ value: item.pending, label: 'Finish the earlier update or setup (recommended)' }]
      : [{ value: 'update', label: 'Update Ours (recommended)' }, { value: 'install', label: 'Repair: run setup again with the same choices' }]),
    { value: 'remove', label: 'Remove Ours from this computer' },
    { value: 'cancel', label: 'Cancel' },
  ], item.pending ?? 'update');
  if (action === 'remove' || action === 'cancel') return { action };
  const record = item.record;
  const product = productOf(record);
  const integrations = clientBound ? (saved.installer?.integrations ?? []).filter(name => !isPluginOnly(product) || PLUGIN_ONLY_INTEGRATIONS.includes(name)) : undefined;
  const fleetConfigured = integrations?.includes('fleet') && effects.readText?.(join(effects.home, 'fleet.yaml')) != null;
  if (action === 'update') {
    effects.out('An update keeps a recovery backup of your stored data before changing it. Newer releases are checked for compatibility, but older data cannot be guaranteed to work with every release automatically.');
    if (!await effects.ask('Update now and keep a recovery backup?', true)) return { action: 'cancel' };
  }
  const options = {
    scope: clientBound ? 'all' : 'server', operation: action, ...(product === PLUGIN_ONLY ? { product } : {}),
    mode: record.mode, ...(record.containerEngine ? { containerEngine: record.containerEngine } : {}),
    stateDir: item.root, identityName: record.messengerIdentity ?? defaultIdentity(effects),
    ...(clientBound ? { integrations } : {}),
    ...(action === 'update' ? { compatible: true } : {}),
    ...(fleetConfigured ? { disableFleetAgentsSetup: true } : {}),
    interactive: true, explicitPorts: [],
  };
  return { action: 'setup', options: validateSetupOptions(options, { interactive: true }), existing: item, retainFleetConfiguration: Boolean(fleetConfigured) };
}

/** The goal-first screen. Returns { action: 'setup' | 'remove' | 'cancel' | 'advanced', ... }. */
export async function collectWelcome(effects) {
  const installations = findInstallations(effects);
  if (installations.length) return collectExisting(effects, installations);
  effects.out(heading('Welcome to Ours'));
  effects.out('Ours is where people and AI agents work together: each agent gets its own secure identity and can message, share files and coordinate with other agents and people.');
  effects.out('Choose what you would like to set up. Collaboration tools add Ours to the agent apps you already use. The complete workspace adds rooms, task tracking, mobile access and persistent agents.');
  effects.out(KEEPS_YOUR_SETUP);
  const goal = await effects.select('What would you like to do?', [
    { value: 'tools', label: 'Add collaboration tools to my agent apps (Claude Code, Codex or another app)' },
    { value: 'workspace', label: 'Install the complete Ours workspace' },
    { value: 'join', label: 'Connect my agent apps to an Ours workspace that runs on another computer' },
    { value: 'advanced', label: 'Other setups (server only, custom ports or packages)' },
  ], 'tools');
  if (goal === 'tools') return collectTools(effects);
  if (goal === 'workspace') {
    effects.out(heading('The complete Ours workspace'));
    for (const line of WORKSPACE_BENEFITS) effects.out(line);
    effects.out(KEEPS_YOUR_SETUP);
    return { action: 'advanced', presets: { scope: 'all' } };
  }
  if (goal === 'join') return { action: 'advanced', presets: { scope: 'client' } };
  return { action: 'advanced', presets: {} };
}

/** Exact, verified guidance for an agent app the installer cannot configure itself. */
export function customHarnessGuidance({ version, profilePath, marketplace }) {
  return [
    'Connect another agent app:',
    `  Ours ships its tools as a Claude Code plugin, npm package @ours.network/claude-code@${version}`,
    `  (https://www.npmjs.com/package/@ours.network/claude-code/v/${version}). It contains an MCP server`,
    '  (stdio: node bin/proxy.mjs, after npm install in the package folder) and the "ours" skill in skills/ours.',
    ...(marketplace ? [`  The same plugin is already prepared on this computer: ${marketplace}/plugins/ours`] : []),
    `  It connects to Ours on this computer through ${profilePath}; no extra settings are needed.`,
    '  Ask your agent:',
    `    "Install the Ours plugin for yourself from npm package @ours.network/claude-code@${version}. If you can load`,
    '     Claude Code plugins, add it as a plugin. Otherwise add its MCP server (node bin/proxy.mjs, stdio) to your',
    '     MCP settings and use skills/ours/SKILL.md as your instructions for the Ours tools."',
    '  Use this exact version: the public GitHub marketplace adapt-toolkit/ours-claude-marketplace currently',
    '  selects an older plugin that does not work with this release. Not every agent app can run MCP servers.',
  ];
}
