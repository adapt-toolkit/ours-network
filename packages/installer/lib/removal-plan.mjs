// Complete removal of Ours from this computer — the pure half.
//
// Discovery reads the machine (lib/removal.mjs); everything here decides, from
// what was read, WHAT is Ours, WHY it is known to be Ours, and in which order it
// can be removed. Nothing here touches the machine, so every ownership rule is
// tested directly.
//
// Ownership is never inferred from a familiar name alone. Each removable item
// carries its evidence:
//   - managed installations: a valid installation.json whose root is this
//     directory, and the Compose project recorded there;
//   - containers, volumes, networks: that project's Compose label;
//   - images: an image ID recorded by this installer, or that project's label;
//   - client generations: an owner record naming a removed installation, or —
//     for older generations without one — no remaining Ours installation at all;
//   - harness registrations and global commands: a path inside a generation
//     that is itself being removed;
//   - Fleet services: a unit file that references this client's profile or a
//     removed generation.
// Anything else that looks related is listed as KEPT with the reason.

import { isAbsolute, join, resolve, sep } from 'node:path';
import { validateContainerEngine } from './container-engine.mjs';
import { PRODUCTS } from './product.mjs';

export const JOURNAL = '.ours-removal.json';
export const CONFIRMATION = 'remove ours';
export const CACHE_MOUNT_ID = '/ours-dist-2-npm';
export const IMAGE_TARGETS = ['runtime', 'gateway', 'maintenance', 'previous-runtime', 'previous-maintenance', 'previous-gateway'];
export const CLAUDE_PLUGIN = 'ours@ours.network';
export const CLAUDE_MARKETPLACE = 'ours.network';
export const CODEX_PLUGIN = 'ours@ours-codex-marketplace';
export const CODEX_MARKETPLACE = 'ours-codex-marketplace';
export const FLEET_UNITS = ['ours-fleet.service', 'ours-fleet-web.service', 'ours-fleet-watchdogs.service'];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PROJECT = /^ours-[a-z0-9]+$/;
const GENERATION = /^[0-9a-f]{16}$/;

export const GROUPS = {
  services: 'Ours services and containers',
  data: 'Ours data: identities, keys, messages and settings',
  apps: 'Ours connections in your agent apps',
  fleet: 'Persistent agents (Fleet)',
  programs: 'Ours programs and downloads',
  legacy: 'Earlier Ours installations',
};

/** Inside (or equal to) a directory, by normalized lexical path. */
export const within = (path, directory) => typeof path === 'string' && typeof directory === 'string'
  && (path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep));

/**
 * The guard in front of every recursive deletion. Returns null when the path may
 * be deleted, otherwise the reason it may not. A path is removable only when it
 * is absolute and normalized, is not the filesystem root, the home directory or
 * one of its ancestors, has no symbolic link anywhere in it, is a directory (or
 * regular file) owned by this user, and — for private trees — is not readable by
 * anybody else.
 */
export function unsafeTreeReason(path, { home, stat, realpath, uid, privateTree = true, file = false }) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) return 'not an absolute normalized path';
  const parts = path.split(sep).filter(Boolean);
  if (parts.length < 2) return 'too close to the filesystem root';
  if (path === home || within(home, path)) return 'is your home directory or contains it';
  const st = stat(path);
  if (!st) return null; // Already absent: nothing to delete, nothing to guard.
  if (st.type === 'symlink') return 'is a symbolic link';
  if (realpath(path) !== path) return 'is reached through a symbolic link';
  if (file ? st.type !== 'file' : st.type !== 'dir') return file ? 'is not a regular file' : 'is not a directory';
  if (st.uid !== uid) return 'belongs to another user';
  if (privateTree && (st.mode & 0o077)) return 'is not private to you';
  return null;
}

/** A managed record reduced to the identity a retry may rely on. */
export function journalInstallation(record) {
  return {
    root: record.root, instanceId: record.instanceId, project: record.project, mode: record.mode,
    ...(record.containerEngine ? { containerEngine: record.containerEngine } : {}),
    ...(record.containerBinding ? { containerBinding: record.containerBinding } : {}),
    ...(record.product ? { product: record.product } : {}),
    candidateProjects: record.buildTransition?.candidate?.project ? [record.buildTransition.candidate.project] : [],
  };
}

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/**
 * A container this installation created. Containers inherit their image's labels,
 * so the Compose project label alone is no proof: Compose also records the
 * project folder, which must lie inside this installation. The installer's own
 * helper containers carry its fixed names and run its own image.
 */
export function ownedContainer(value, { root, project }) {
  const labels = value?.Config?.Labels ?? {};
  const name = String(value?.Name ?? '').replace(/^\//, '');
  if (labels['com.docker.compose.project'] === project && within(labels['com.docker.compose.project.working_dir'], root)) return true;
  return (name === `${project}-records` || name.startsWith(`${project}-issue-`)) && String(value?.Config?.Image ?? '').startsWith(`${project}:`);
}

/** Strict journal validation: only identities, never free-form deletion paths. */
export function validateJournal(value, { home }) {
  const fail = message => { throw new Error(`Unfinished removal record is invalid (${message}); it was left untouched. Remove ${join(home, JOURNAL)} yourself only after checking what remains.`); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1) fail('schema');
  const keys = ['schema', 'startedAt', 'installations', 'clientInstanceIds', 'generations', 'fleet', 'legacy', 'installer'];
  if (Object.keys(value).some(key => !keys.includes(key))) fail('unexpected field');
  if (!Array.isArray(value.installations) || !Array.isArray(value.clientInstanceIds) || !Array.isArray(value.generations)) fail('lists');
  for (const item of value.installations) {
    if (!item || typeof item.root !== 'string' || !isAbsolute(item.root) || resolve(item.root) !== item.root
      || !UUID.test(item.instanceId ?? '') || !PROJECT.test(item.project ?? '') || !['docker', 'packages'].includes(item.mode)
      || !Array.isArray(item.candidateProjects ?? []) || (item.candidateProjects ?? []).some(p => !/^ours-build[0-9a-f]{32}$/.test(p))) fail('installation identity');
    if (item.images !== undefined) {
      const projects = [item.project, ...(item.candidateProjects ?? [])];
      if (!item.images || typeof item.images !== 'object' || Array.isArray(item.images)
        || Object.entries(item.images).some(([tag, id]) => !projects.some(p => IMAGE_TARGETS.some(t => tag === `${p}:${t}`)) || !IMAGE_ID.test(id))) fail('image identity');
    }
    if (Object.keys(item).some(key => !['root', 'instanceId', 'project', 'mode', 'containerEngine', 'containerBinding', 'product', 'candidateProjects', 'images'].includes(key))) fail('installation field');
    try { validateContainerEngine(item); } catch { fail('container engine'); }
    if (item.product !== undefined && !PRODUCTS.includes(item.product)) fail('product');
  }
  if (value.clientInstanceIds.some(id => !UUID.test(id))) fail('client identity');
  if (value.generations.some(id => !GENERATION.test(id))) fail('generation identity');
  for (const key of ['fleet', 'legacy', 'installer']) if (typeof value[key] !== 'boolean') fail(key);
  return value;
}

/** Remove whole TOML tables whose header satisfies `match`; every other byte is kept. */
export function removeTomlTables(text, match) {
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  const removed = [];
  for (const line of lines) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      skipping = match(header[1].trim());
      if (skipping) { removed.push(header[1].trim()); continue; }
    }
    if (!skipping) out.push(line);
  }
  return { text: out.join('\n'), removed };
}

/** Parse `docker buildx du --verbose` blocks into records. */
export function parseBuildCache(text) {
  const records = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const field = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    const [, key, value] = field;
    if (key === 'ID') { current = { id: value.trim() }; records.push(current); }
    else if (current && key === 'Description') current.description = value.trim();
    else if (current && key === 'Size') current.size = value.trim();
  }
  return records;
}
/** Exactly the installer's own npm cache mount, identified by its declared id. */
export const isOursCacheRecord = record => typeof record?.description === 'string'
  && /^cached mount \/root\/\.npm from exec .* with id "\/ours-dist-2-npm"$/.test(record.description)
  && /^[a-z0-9]{20,64}$/.test(record.id ?? '');

/**
 * Decide the removal from a discovery. Returns `steps` (ordered, each with its
 * evidence) and `kept` (what was found but is not removed, with the reason).
 */
export function planRemoval(found, { home }) {
  const steps = [];
  const kept = [...(found.kept ?? [])];
  const add = step => steps.push(step);
  const removedInstances = new Set(found.installations.map(i => i.instanceId));
  const clientBound = found.client && (removedInstances.has(found.client.instanceId) || found.client.orphaned);
  if (found.client && !clientBound) kept.push({ group: 'apps', label: `Saved Ours connection ${join(home, '.ours-client')}`, reason: 'it belongs to an Ours installation that is not being removed' });
  const clientInstances = new Set(clientBound ? [found.client.instanceId] : []);
  const othersRemain = found.otherInstallations?.length > 0;

  // Generations: owned by a removed installation, or (older ones without an owner
  // record) only when no other Ours installation remains on this computer.
  const generations = [];
  for (const generation of found.generations ?? []) {
    const owners = generation.owners;
    const ownedHere = owners ? owners.length > 0 && owners.every(id => removedInstances.has(id) || clientInstances.has(id)) : !othersRemain && (clientBound || !found.client);
    if (ownedHere) generations.push(generation);
    else kept.push({ group: 'programs', label: `Downloaded Ours programs ${generation.path}`, reason: owners ? 'they are also used by another Ours installation' : 'their owner is not recorded and another Ours installation remains' });
  }
  const removedGeneration = path => generations.some(g => within(path, g.path));
  const legacyMarketplaces = join(home, '.ours', 'install', 'marketplaces');
  const ownedMarketplace = path => removedGeneration(path) || (found.legacy?.remove && within(path, legacyMarketplaces));

  // Fleet first: its agents use the plugins and the client connection.
  if (clientBound && found.fleet) {
    const fleet = found.fleet;
    if (fleet.bin && fleet.installedByOurs) add({ id: 'fleet-down', group: 'fleet', label: 'Stop persistent agents (ours-fleet down)', type: 'fleet-down', bin: fleet.bin });
    for (const unit of fleet.units) {
      if (unit.bound) add({ id: `unit:${unit.name}`, group: 'fleet', label: `Agent service ${unit.name}`, type: 'user-unit', name: unit.name, path: unit.path, dropIn: unit.dropIn ?? null });
      else kept.push({ group: 'fleet', label: `Service ${unit.name}`, reason: 'it does not reference this Ours installation' });
    }
    if (fleet.installedByOurs) {
      if (fleet.configPath && fleet.configExists) add({ id: 'fleet-config', group: 'fleet', label: `Fleet agent configuration ${fleet.configPath}`, type: 'file', path: fleet.configPath, after: ['fleet-down'] });
      if (fleet.stateRoot && fleet.stateExists) add({ id: 'fleet-state', group: 'fleet', label: `Fleet agent state, logs and workspaces ${fleet.stateRoot}`, type: 'tree', path: fleet.stateRoot, privateTree: false, after: ['fleet-down', ...fleet.units.filter(u => u.bound).map(u => `unit:${u.name}`)] });
    } else if (fleet.configExists || fleet.stateExists) kept.push({ group: 'fleet', label: 'Fleet configuration and state', reason: 'Fleet on this computer was not set up by this Ours client' });
  }

  // Agent app registrations that point into removed downloads.
  const apps = [];
  const claude = found.claude;
  if (claude?.marketplace && !ownedMarketplace(claude.marketplace.path)) kept.push({ group: 'apps', label: `Claude Code marketplace "${CLAUDE_MARKETPLACE}"`, reason: `it points to ${claude.marketplace.path}, which this installer did not create` });
  else if (claude) {
    if (claude.plugin) apps.push({ id: 'claude-plugin', group: 'apps', label: 'Ours plugin in Claude Code', type: 'command', command: ['claude', 'plugin', 'uninstall', CLAUDE_PLUGIN, '--scope', 'user'] });
    if (claude.marketplace) apps.push({ id: 'claude-marketplace', group: 'apps', label: 'Ours plugin source in Claude Code', type: 'command', command: ['claude', 'plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE], after: ['claude-plugin'] });
    if (claude.settingsEntries?.length) apps.push({ id: 'claude-settings', group: 'apps', label: `Ours entries in ${claude.settingsPath}`, type: 'claude-settings', path: claude.settingsPath, entries: claude.settingsEntries, after: ['claude-plugin', 'claude-marketplace'] });
    if (claude.cache) apps.push({ id: 'claude-cache', group: 'apps', label: `Claude Code's copy of the Ours plugin ${claude.cache}`, type: 'tree', path: claude.cache, privateTree: false, after: ['claude-plugin', 'claude-marketplace'] });
  }
  const codex = found.codex;
  if (codex?.marketplace && !ownedMarketplace(codex.marketplace.path)) kept.push({ group: 'apps', label: `Codex marketplace "${CODEX_MARKETPLACE}"`, reason: `it points to ${codex.marketplace.path}, which this installer did not create` });
  else if (codex) {
    if (codex.plugin) apps.push({ id: 'codex-plugin', group: 'apps', label: 'Ours plugin in Codex', type: 'command', command: ['codex', 'plugin', 'remove', CODEX_PLUGIN] });
    if (codex.marketplace) apps.push({ id: 'codex-marketplace', group: 'apps', label: 'Ours plugin source in Codex', type: 'command', command: ['codex', 'plugin', 'marketplace', 'remove', CODEX_MARKETPLACE], after: ['codex-plugin'] });
    if (codex.configTables?.length) apps.push({ id: 'codex-config', group: 'apps', label: `Ours entries in ${codex.configPath}`, type: 'codex-config', path: codex.configPath, after: ['codex-plugin', 'codex-marketplace'] });
    if (codex.cache) apps.push({ id: 'codex-cache', group: 'apps', label: `Codex's copy of the Ours plugin ${codex.cache}`, type: 'tree', path: codex.cache, privateTree: false, after: ['codex-plugin', 'codex-marketplace'] });
  }
  for (const step of apps) add(step);
  // Ours tool records: only the rows and session folders of the removed instances.
  const tool = found.toolState;
  if (tool) {
    const ids = new Set([...removedInstances, ...clientInstances]);
    const label = `Ours tool records ${tool.root}`;
    if (!tool.valid) kept.push({ group: 'apps', label, reason: 'its record file could not be read, so nothing in it is removed automatically' });
    else if (ids.size) {
      const ourSessions = tool.sessions.filter(id => ids.has(id));
      const ourRows = tool.instances.filter(id => ids.has(id));
      const foreign = tool.daemons.length || tool.others.length || tool.sessions.some(id => !ids.has(id)) || tool.instances.some(id => !ids.has(id));
      if (!foreign) add({ id: 'tool-state', group: 'apps', label, type: 'tree', path: tool.root, after: apps.map(s => s.id) });
      else {
        for (const id of ourSessions) add({ id: `tool-sessions:${id}`, group: 'apps', label: `Ours tool session records ${join(tool.root, 'sessions', id)}`, type: 'tree', path: join(tool.root, 'sessions', id), after: apps.map(s => s.id) });
        if (ourRows.length) add({ id: 'tool-config', group: 'apps', label: `Ours entries in ${tool.configPath}`, type: 'tool-config', path: tool.configPath, instances: ourRows, after: apps.map(s => s.id) });
        kept.push({ group: 'apps', label: `Other records in ${tool.root}`, reason: 'they belong to other Ours installations or tools' });
      }
    } else kept.push({ group: 'apps', label, reason: 'it does not record which installation it belongs to, and no Ours installation is being removed' });
  }

  // Older plugin installers wrote marked blocks and skills; only exact, closed blocks.
  for (const block of found.legacy?.blocks ?? []) add({ id: `block:${block.path}`, group: 'legacy', label: `Ours section in ${block.path}`, type: 'managed-block', path: block.path, markers: block.markers });
  for (const dir of found.legacy?.skillDirs ?? []) add({ id: `skills:${dir}`, group: 'legacy', label: `Ours skill ${dir}`, type: 'tree', path: dir, privateTree: false });

  // Commands published into the npm prefix, before the downloads they point into.
  const commandSteps = [];
  for (const entry of found.npm?.bins ?? []) {
    if (entry.kind === 'generation' && removedGeneration(entry.target)) commandSteps.push({ id: `bin:${entry.path}`, group: 'programs', label: `Command ${entry.name}`, type: 'unlink', path: entry.path, expectTarget: entry.target });
    else if (entry.kind === 'managed-launcher' && found.installations.some(i => i.root === entry.root)) commandSteps.push({ id: `bin:${entry.path}`, group: 'programs', label: `Command ${entry.name} (managed launcher)`, type: 'unlink', path: entry.path, expectLauncher: entry.root });
    else if (entry.kind !== 'package') kept.push({ group: 'programs', label: `Command ${entry.path}`, reason: 'it does not point to Ours programs that are being removed' });
  }
  for (const pkg of found.npm?.packages ?? []) {
    if (pkg.name === '@ours.network/install') continue;
    if (pkg.link && removedGeneration(pkg.target)) commandSteps.push({ id: `npm:${pkg.name}`, group: 'programs', label: `Global package ${pkg.name}`, type: 'npm-uninstall', name: pkg.name, expectTarget: pkg.target });
    else if (!pkg.link && found.legacy?.remove) commandSteps.push({ id: `npm:${pkg.name}`, group: 'legacy', label: `Global package ${pkg.name}`, type: 'npm-uninstall', name: pkg.name });
    else kept.push({ group: 'programs', label: `Global package ${pkg.name}`, reason: pkg.link ? 'it points outside the Ours downloads being removed' : 'it is not part of the installations being removed' });
  }
  for (const step of commandSteps) add(step);
  const beforeDownloads = [...apps.map(s => s.id), ...commandSteps.map(s => s.id), ...steps.filter(s => s.group === 'fleet').map(s => s.id)];

  // Server services, then their engine resources.
  // Engine items are planned when they exist or could not be checked (null/absent inventory).
  const present = value => value === null || value === undefined
    || (Array.isArray(value) ? value.length > 0 : typeof value === 'object' ? Object.keys(value).length > 0 : value > 0);
  for (const item of found.installations) {
    const tag = item.root;
    if (item.record !== null) add({ id: `services:${tag}`, group: 'services', label: `Ours services of ${item.root}`, type: 'server-services', installation: item });
    if (item.mode === 'docker') {
      for (const project of [item.project, ...(item.candidateProjects ?? [])]) {
        const engine = item.engine?.[project] ?? {};
        if (present(engine.containers)) add({ id: `containers:${project}`, group: 'services', label: `Containers of ${project}`, type: 'containers', installation: item, project, ...(Array.isArray(engine.containers) ? { containerIds: engine.containers } : {}), after: [`services:${tag}`] });
        if (present(engine.images)) add({ id: `images:${project}`, group: 'programs', label: `Container images of ${project}`, type: 'images', installation: item, project, ...(engine.images ? { tags: engine.images } : {}), after: [`containers:${project}`] });
        if (present(engine.volumes)) add({ id: `volumes:${project}`, group: 'data', label: `Stored data volumes of ${project}`, type: 'volumes', installation: item, project, after: [`containers:${project}`] });
        if (present(engine.networks)) add({ id: `networks:${project}`, group: 'services', label: `Network of ${project}`, type: 'networks', installation: item, project, after: [`containers:${project}`] });
      }
    }
  }
  const dockerItems = found.installations.filter(i => i.mode === 'docker');
  if (dockerItems.length && present(found.buildCache)) {
    if (found.otherEngineProjects?.length || othersRemain) kept.push({ group: 'programs', label: 'Shared Ours build cache', reason: 'another Ours installation on this engine may still use it' });
    else add({ id: 'build-cache', group: 'programs', label: 'Ours build cache in the container engine', type: 'build-cache', installation: dockerItems[0], after: dockerItems.flatMap(i => [i.project, ...(i.candidateProjects ?? [])].map(p => `images:${p}`)) });
  }

  // Directories last: downloads after everything that pointed into them, roots after their services.
  for (const generation of generations) add({ id: `generation:${generation.id}`, group: 'programs', label: `Downloaded Ours programs ${generation.path}`, type: 'tree', path: generation.path, after: beforeDownloads });
  if (clientBound) add({ id: 'client', group: 'data', label: `Saved Ours connection and credential ${found.client.root}`, type: 'tree', path: found.client.root, expectInstance: found.client.instanceId, after: beforeDownloads });
  const clientInstall = join(home, '.ours-client-install');
  if (found.clientInstallEmptyAfter && generations.length) add({ id: 'client-install', group: 'programs', label: `Ours downloads folder ${clientInstall}`, type: 'empty-dir', path: clientInstall, after: generations.map(g => `generation:${g.id}`) });
  for (const item of found.installations.filter(i => i.record !== null)) add({ id: `root:${item.root}`, group: 'data', label: `Ours installation folder ${item.root}`, type: 'tree', path: item.root, expectInstance: item.instanceId, after: [`services:${item.root}`, ...(item.mode === 'docker' ? [item.project, ...(item.candidateProjects ?? [])].map(p => `containers:${p}`) : [])] });

  if (found.legacy?.remove) {
    for (const service of found.legacy.services ?? []) add({ id: `legacy-service:${service.label}`, group: 'legacy', label: service.label, type: 'command', command: service.command, tolerate: true });
    for (const dir of found.legacy.dirs ?? []) add({ id: `legacy:${dir}`, group: 'legacy', label: `Earlier Ours data ${dir}`, type: 'tree', path: dir, privateTree: false, after: (found.legacy.services ?? []).map(s => `legacy-service:${s.label}`) });
  }
  if (found.npm?.packages?.some(p => p.name === '@ours.network/install') && found.removeInstaller) {
    add({ id: 'installer', group: 'programs', label: 'The ours-install command itself', type: 'npm-uninstall', name: '@ours.network/install', last: true });
  }
  // npm leaves the empty @ours.network folder behind once every package in it is gone.
  const removedPackages = new Set(steps.filter(s => s.type === 'npm-uninstall').map(s => s.name));
  if (found.npm?.scope && (found.npm.packages ?? []).every(p => removedPackages.has(p.name))) {
    add({ id: 'npm-scope', group: 'programs', label: `Empty folder ${found.npm.scope}`, type: 'empty-dir', path: found.npm.scope, last: true, after: [...removedPackages].map(name => name === '@ours.network/install' ? 'installer' : `npm:${name}`) });
  }
  return { steps, kept };
}

/** Plain-language summary lines for the confirmation screen, grouped. */
export function describePlan({ steps, kept }) {
  const lines = [];
  for (const [group, title] of Object.entries(GROUPS)) {
    const items = steps.filter(step => step.group === group);
    if (!items.length) continue;
    lines.push(title + ':');
    for (const item of items) lines.push(`  - ${item.label}`);
  }
  if (kept.length) {
    lines.push('Kept (not created by this installer, shared, or still in use):');
    for (const item of kept) lines.push(`  - ${item.label} — ${item.reason}`);
  }
  return lines;
}
