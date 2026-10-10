// Complete removal of Ours from this computer — discovery, confirmation,
// execution and verification. Decisions live in lib/removal-plan.mjs.
//
//   ours-install remove [--state-dir PATH] [--dry-run]
//
// Interactive only: permanent deletion of identities and their private keys
// needs a person who has read the list and typed the confirmation. A retry
// record is written before the first change and kept until a fresh scan finds
// nothing left, so an interrupted or partly failed removal can be finished by
// running the same command again.

import { basename, dirname, join, resolve } from 'node:path';
import { modify, applyEdits, parse as parseJsonc } from 'jsonc-parser';
import { validateInstallation, unitNameForStateDir } from './plan.mjs';
import { validateContainerEngine, runContainer } from './container-engine.mjs';
import { classifyStateDir } from './detect.mjs';
import { stripManagedBlock, YAML_BLOCK, MD_BLOCK } from './uninstall.mjs';
import { readOwners } from './ownership.mjs';
import {
  JOURNAL, CONFIRMATION, IMAGE_TARGETS, CLAUDE_PLUGIN, CLAUDE_MARKETPLACE, CODEX_PLUGIN, CODEX_MARKETPLACE, FLEET_UNITS,
  within, unsafeTreeReason, journalInstallation, validateJournal, removeTomlTables, parseBuildCache, isOursCacheRecord, ownedContainer, isOursCodexTable, projectForRoot, tombstoneFor, otherOursProjects,
  planRemoval, describePlan,
} from './removal-plan.mjs';
import { ok, info, warn, heading, progress } from './ui.mjs';

export const EXIT_OK = 0;
export const EXIT_INCOMPLETE = 1;
export const EXIT_REFUSED = 2;
export const EXIT_CANCELLED = 130;
const GENERATION = /^[0-9a-f]{16}$/;
const MANAGED_CLI_MARKER = '// ours-managed-cli-v1 ';

export const REMOVE_USAGE = `ours-install remove — remove Ours completely from this computer.

  ours-install remove [--state-dir PATH] [--dry-run]

Finds everything Ours installed or created for you — its services and
containers, stored identities, keys and messages, the Ours plugins in Claude
Code and Codex, persistent agents set up by Ours, downloaded programs and
earlier Ours installations — shows the complete list, and removes it after you
type the confirmation. Your own agent-app settings, skills and other plugins are
kept, and anything shared or not created by Ours is listed and left in place.

  --state-dir  remove only this Ours installation (and the connection of this
               computer's agent apps to it). Without it, everything Ours is removed.
  --dry-run    show the list and change nothing.

Removal needs a terminal: identities and their private keys exist nowhere else,
so they are never deleted without a person confirming. If removal is interrupted
or something cannot be removed, run the same command again to finish.`;

function parseRemoveArgs(argv, home) {
  const options = { stateDirs: [], dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--state-dir' || arg.startsWith('--state-dir=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value) throw new Error('--state-dir requires a folder');
      options.stateDirs.push(value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : resolve(value));
    } else throw new Error(`Unknown option for remove: ${arg}`);
  }
  return options;
}

function json(text) { try { return JSON.parse(text); } catch { return undefined; } }

/** Read-only inventory of everything that may be Ours. */
export async function discoverFootprint(effects, { stateDirs = [], journal = null } = {}) {
  const home = effects.home;
  const found = { installations: [], otherInstallations: [], kept: [], generations: [], npm: null, legacy: null };
  // A residual is something of Ours that is left because it can no longer be proven; it keeps the removal unfinished.
  const keep = (group, label, reason, residual = false) => found.kept.push({ group, label, reason, ...(residual ? { residual: true } : {}) });
  const tombstone = (path, instanceId) => (effects.stat(tombstoneFor(path, instanceId))?.type === 'dir' ? tombstoneFor(path, instanceId) : null);

  // Managed installations.
  const homeEntries = effects.list(home) ?? [];
  const candidates = new Set([join(home, '.ours-install'), ...homeEntries.filter(name => name.startsWith('.ours')).map(name => join(home, name))]);
  for (const dir of stateDirs) candidates.add(dir);
  for (const item of journal?.installations ?? []) candidates.add(item.root);
  const selected = root => !stateDirs.length || stateDirs.includes(root) || journal?.installations?.some(i => i.root === root);
  for (const root of candidates) {
    const text = effects.readText(join(root, 'installation.json'));
    const retained = journal?.installations?.find(i => i.root === root);
    if (text === null) {
      // Partly removed earlier: finish engine items from the retry record. A folder
      // still there without its record is no longer provably the installation.
      if (retained) {
        found.installations.push({ ...retained, record: null, tombstone: tombstone(root, retained.instanceId) });
        if (effects.stat(root)) keep('data', `Folder ${root}`, 'it no longer holds the Ours installation record it had when the removal started, so it is left in place; check it and remove it yourself if it is not yours', true);
      }
      else if (stateDirs.includes(root)) keep('data', root, 'no Ours installation record was found there');
      continue;
    }
    let record;
    try { record = validateInstallation(json(text), root); if (record.containerBinding || record.containerEngine) validateContainerEngine(record); }
    catch { keep('data', `Folder ${root}`, 'its Ours installation record is not valid, so nothing in it is removed automatically'); continue; }
    if (retained && retained.instanceId !== record.instanceId) { keep('data', `Folder ${root}`, 'it now holds a different Ours installation than the unfinished removal recorded'); continue; }
    const item = { ...journalInstallation(record), ...(retained?.candidateProjects?.length ? { candidateProjects: [...new Set([...retained.candidateProjects, ...journalInstallation(record).candidateProjects])] } : {}), ...(retained?.images ? { images: retained.images } : {}), record, tombstone: tombstone(root, record.instanceId) };
    item.ownedImages = json(effects.readText(join(root, 'owned-images.json')) ?? '')?.images ?? null;
    (selected(root) ? found.installations : found.otherInstallations).push(item);
  }

  // The saved client connection of this computer's agent apps.
  const clientRoot = join(home, '.ours-client');
  if (effects.stat(clientRoot)) {
    const profile = json(effects.readText(join(clientRoot, 'profile.json')) ?? '');
    if (profile && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(profile.expectedInstanceId ?? '')) {
      found.client = { root: clientRoot, instanceId: profile.expectedInstanceId, integrations: profile.installer?.integrations ?? [], path: join(clientRoot, 'profile.json') };
    } else keep('apps', `Saved Ours connection ${clientRoot}`, 'its connection file is missing or cannot be read, so it is not provably this installation\'s and is left in place; remove it yourself if no Ours installation uses it', true);
  }
  found.clientTombstones = [...new Set([...(journal?.clientInstanceIds ?? []), ...(found.client?.instanceId ? [found.client.instanceId] : [])])]
    .map(id => tombstone(clientRoot, id)).filter(Boolean);

  // Downloaded client programs.
  const installRoot = join(home, '.ours-client-install');
  const generationNames = effects.list(installRoot) ?? [];
  for (const name of generationNames) {
    const path = join(installRoot, name);
    if (!GENERATION.test(name) || effects.stat(path)?.type !== 'dir') { keep('programs', path, 'it was not created by this installer'); continue; }
    found.generations.push({ id: name, path, owners: readOwners(effects, path), fleet: Boolean(effects.stat(join(path, 'node_modules/@ours.network/fleet'))) });
  }
  found.clientInstallEmptyAfter = generationNames.length > 0 && generationNames.every(name => GENERATION.test(name));

  // npm global commands and packages.
  try {
    const prefix = (await effects.run('npm', ['prefix', '--global'])).stdout.trim();
    const root = (await effects.run('npm', ['root', '--global'])).stdout.trim();
    const bins = [];
    for (const name of (effects.list(join(prefix, 'bin')) ?? []).filter(name => name === 'ours' || name.startsWith('ours-'))) {
      const path = join(prefix, 'bin', name), st = effects.stat(path);
      if (!st) continue;
      if (st.type === 'symlink') {
        const target = effects.realpath(path);
        if (target && within(target, installRoot)) bins.push({ name, path, target, kind: 'generation' });
        else if (target && within(target, join(root, '@ours.network'))) bins.push({ name, path, target, kind: 'package' });
        else bins.push({ name, path, target, kind: 'other' });
      } else if (st.type === 'file') {
        const line = (effects.readText(path) ?? '').split('\n')[1] ?? '';
        const binding = line.startsWith(MANAGED_CLI_MARKER) ? json(line.slice(MANAGED_CLI_MARKER.length)) : null;
        bins.push(binding?.targetRoot ? { name, path, kind: 'managed-launcher', root: binding.targetRoot } : { name, path, kind: 'other' });
      }
    }
    const packages = [];
    for (const name of effects.list(join(root, '@ours.network')) ?? []) {
      const path = join(root, '@ours.network', name), st = effects.stat(path);
      if (!st) continue;
      packages.push({ name: `@ours.network/${name}`, path, link: st.type === 'symlink', target: st.type === 'symlink' ? effects.realpath(path) : path });
    }
    found.npm = { prefix, root, bins, packages, scope: effects.stat(join(root, '@ours.network'))?.type === 'dir' ? join(root, '@ours.network') : null };
  } catch { keep('programs', 'Global npm commands', 'npm is not available to check them'); }

  // Claude Code and Codex registrations.
  const claudeSettingsPath = join(home, '.claude', 'settings.json');
  const settingsText = effects.readText(claudeSettingsPath);
  const settings = settingsText === null ? null : parseJsonc(settingsText, [], { allowTrailingComma: true });
  const settingsEntries = [];
  if (settings?.enabledPlugins && Object.hasOwn(settings.enabledPlugins, CLAUDE_PLUGIN)) settingsEntries.push(['enabledPlugins', CLAUDE_PLUGIN]);
  if (settings?.extraKnownMarketplaces && Object.hasOwn(settings.extraKnownMarketplaces, CLAUDE_MARKETPLACE)) settingsEntries.push(['extraKnownMarketplaces', CLAUDE_MARKETPLACE]);
  const settingsMarketplacePath = settings?.extraKnownMarketplaces?.[CLAUDE_MARKETPLACE]?.source?.path ?? null;
  let claude = null;
  try {
    const plugins = json((await effects.run('claude', ['plugin', 'list', '--json'], { timeout: 30_000 })).stdout) ?? [];
    const markets = json((await effects.run('claude', ['plugin', 'marketplace', 'list', '--json'], { timeout: 30_000 })).stdout) ?? [];
    const market = markets.find(m => m?.name === CLAUDE_MARKETPLACE);
    const plugin = plugins.find(p => p?.id === CLAUDE_PLUGIN);
    // Claude Code keeps its copy of the plugin after uninstalling it.
    const cache = effects.stat(join(home, '.claude', 'plugins', 'cache', 'ours-network'))?.type === 'dir' ? join(home, '.claude', 'plugins', 'cache', 'ours-network') : null;
    if (plugin || market || settingsEntries.length || cache) {
      claude = { plugin: Boolean(plugin), marketplace: market || settingsMarketplacePath ? { path: market?.path ?? market?.installLocation ?? settingsMarketplacePath } : null, settingsPath: claudeSettingsPath, settingsEntries, cache };
    }
  } catch {
    if (settingsEntries.length || effects.stat(join(home, '.claude/plugins/cache/ours-network')))
      keep('apps', 'Ours plugin in Claude Code', 'the claude command is not available to remove it; inside Claude Code run: /plugin uninstall ours@ours.network, then /plugin marketplace remove ours.network');
  }
  found.claude = claude;

  const codexDir = effects.env?.CODEX_HOME || join(home, '.codex');
  const codexConfigPath = join(codexDir, 'config.toml');
  const codexText = effects.readText(codexConfigPath);
  const scanned = codexText === null ? { removed: [] } : removeTomlTables(codexText, parts => isOursCodexTable(parts, CODEX_PLUGIN, CODEX_MARKETPLACE));
  if (scanned === null) keep('apps', `Ours entries in ${codexConfigPath}`, 'the file could not be read safely, so it is not edited; remove the [plugins."ours@ours-codex-marketplace"] and [marketplaces.ours-codex-marketplace] sections yourself');
  const configTables = scanned?.removed ?? [];
  let codex = null;
  try {
    const listed = json((await effects.run('codex', ['plugin', 'marketplace', 'list', '--json'], { timeout: 30_000 })).stdout);
    const market = listed?.marketplaces?.find(m => m?.name === CODEX_MARKETPLACE);
    const plugin = configTables.some(label => label.startsWith(`plugins.${JSON.stringify(CODEX_PLUGIN)}`));
    const cache = effects.stat(join(codexDir, 'plugins', 'cache', CODEX_MARKETPLACE))?.type === 'dir' ? join(codexDir, 'plugins', 'cache', CODEX_MARKETPLACE) : null;
    if (market || plugin || configTables.length || cache) codex = { plugin, marketplace: market ? { path: market.marketplaceSource?.source ?? market.root } : null, configPath: codexConfigPath, configTables, cache };
  } catch {
    if (configTables.length) keep('apps', 'Ours plugin in Codex', 'the codex command is not available to remove it; run: codex plugin remove ours@ours-codex-marketplace');
  }
  found.codex = codex;

  // Fleet set up by this client.
  const fleetHome = effects.env?.OURS_FLEET_HOME || home;
  const unitsDir = join(home, '.config', 'systemd', 'user');
  const clientProfile = join(clientRoot, 'profile.json');
  const units = [];
  for (const name of effects.list(unitsDir) ?? []) {
    if (!(FLEET_UNITS.includes(name) || /^ours-fleet-agent@[^/]*\.service$/.test(name))) continue;
    const path = join(unitsDir, name), st = effects.stat(path);
    if (st?.type !== 'file') continue;
    const text = effects.readText(path) ?? '';
    units.push({ name, path, bound: text.includes(`OURS_CONFIG=${clientProfile}`) || within(text.match(/ExecStart=\S*\s+"?([^"\s]+)/)?.[1] ?? '', installRoot),
      dropIn: effects.stat(`${path}.d`)?.type === 'dir' ? `${path}.d` : null });
  }
  const fleetGeneration = found.generations.find(g => g.fleet);
  const installedByOurs = Boolean(found.client?.integrations?.includes('fleet') && fleetGeneration);
  const configPath = join(fleetHome, 'fleet.yaml'), stateRoot = join(fleetHome, '.ours-fleet');
  if (installedByOurs || units.length || effects.stat(configPath) || effects.stat(stateRoot)) {
    found.fleet = { installedByOurs, bin: fleetGeneration ? join(fleetGeneration.path, 'node_modules/.bin/ours-fleet') : null, configPath, configExists: Boolean(effects.stat(configPath)), stateRoot, stateExists: Boolean(effects.stat(stateRoot)), units };
  }

  // Earlier installations: the shared-daemon layout and the marked plugin blocks.
  if (!stateDirs.length) {
    const legacy = { dirs: [], services: [], blocks: [], skillDirs: [] };
    const daemonDir = join(home, '.ours');
    const io = { exists: path => Boolean(effects.stat(path)), readJson: path => json(effects.readText(path) ?? '') ?? null };
    if (effects.stat(daemonDir)?.type === 'dir' && !effects.stat(join(daemonDir, 'installation.json')) && (classifyStateDir(daemonDir, io).isDaemon || effects.stat(join(daemonDir, 'install')))) {
      legacy.dirs.push(daemonDir);
      if (effects.stat(join(daemonDir, 'config.json'))) {
        const config = io.readJson(join(daemonDir, 'config.json'));
        const unit = unitNameForStateDir(daemonDir);
        legacy.services.push({ kind: 'daemon', label: 'Earlier Ours daemon and its boot service', dir: daemonDir,
          port: Number.isInteger(config?.port) ? config.port : 3050, cliStartedIt: Boolean(effects.stat(join(daemonDir, 'ours-cli-daemon.json'))),
          unitPath: unit.ok ? join(home, '.config', 'systemd', 'user', unit.unit) : null });
      }
    }
    for (const [name, service, unitName] of [['.ours-telegram', 'ours-tg-connector', 'ours-telegram.service'], ['.ours-cowork', 'ours-cowork', 'ours-cowork.service']]) {
      const dir = join(home, name);
      if (effects.stat(dir)?.type !== 'dir') continue;
      legacy.dirs.push(dir);
      // Only a boot service that serves this earlier folder; verified gone afterwards.
      const unitPath = join(home, '.config', 'systemd', 'user', unitName);
      if (effects.stat(unitPath)?.type === 'file' && (effects.readText(unitPath) ?? '').includes(dir)) {
        legacy.services.push({ kind: 'connector', label: `Earlier ${service} boot service`, command: [service, 'uninstall-service'], unitPath, dir });
      }
    }
    const hermesDir = effects.env?.HERMES_DIR || join(home, '.hermes');
    const skillsDir = effects.env?.SKILLS_DIR || join(home, '.agents', 'skills');
    for (const [path, markers] of [[join(hermesDir, 'config.yaml'), YAML_BLOCK], [codexConfigPath, YAML_BLOCK], [join(codexDir, 'AGENTS.md'), MD_BLOCK]]) {
      const text = effects.readText(path);
      if (text === null || !text.includes(markers.start)) continue;
      if (stripManagedBlock(text, markers).action === 'strip') legacy.blocks.push({ path, markers });
      else keep('legacy', `Ours section in ${path}`, 'it has no closing marker; remove it by hand so nothing you wrote after it is lost');
    }
    for (const dir of [join(skillsDir, 'ours'), join(skillsDir, 'writing-agent-bios'), join(hermesDir, 'skills', 'communication', 'ours'), join(hermesDir, 'skills', 'communication', 'writing-agent-bios')]) {
      if (effects.stat(dir)?.type === 'dir') legacy.skillDirs.push(dir);
    }
    legacy.remove = !found.otherInstallations.length;
    // The Ours tools in Claude Code and Codex keep per-instance records here.
    const toolRoot = join(home, '.ours-mcp');
    if (effects.stat(toolRoot)?.type === 'dir') {
      const configText = effects.readText(join(toolRoot, 'config.json'));
      const config = configText === null ? null : json(configText);
      const valid = configText === null || (config && config.version === 1 && typeof config.daemons === 'object' && !Array.isArray(config.daemons)
        && (config.instances === undefined || (typeof config.instances === 'object' && !Array.isArray(config.instances))));
      found.toolState = { root: toolRoot, configPath: join(toolRoot, 'config.json'), valid: Boolean(valid),
        daemons: Object.keys(config?.daemons ?? {}), instances: Object.keys(config?.instances ?? {}),
        sessions: effects.list(join(toolRoot, 'sessions')) ?? [], others: (effects.list(toolRoot) ?? []).filter(name => !['config.json', 'sessions'].includes(name)) };
    }
    // Session guards are shared by every Ours tool session of this user, of any
    // installation, and are temporary: reported, never removed.
    if (effects.stat(`/tmp/ours-${effects.uid}`)?.type === 'dir') keep('apps', `Temporary Ours session guards /tmp/ours-${effects.uid}`, 'they are shared by every Ours tool session of your user and are cleared when the computer restarts');
    if (legacy.dirs.length || legacy.blocks.length || legacy.skillDirs.length) found.legacy = legacy;
    found.removeInstaller = !found.otherInstallations.length;
  }

  // Other Ours projects on the same engine keep the shared build cache.
  if (found.installations.some(i => i.mode === 'docker')) {
    const removing = new Set(found.installations.flatMap(i => [i.project, ...(i.candidateProjects ?? [])]));
    const binding = found.installations.find(i => i.mode === 'docker');
    const others = new Set();
    // Containers inherit their image's project label, so only Compose-created ones
    // (with a project folder) show another installation; volume labels are not inherited.
    const label = '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}';
    for (const [kind, composeOnly] of [[['ps', '-a'], true], [['volume', 'ls'], false]]) {
      try {
        const listed = await runContainer(effects, binding, [...kind, '--format', label]);
        for (const project of otherOursProjects(listed.stdout, removing, { composeOnly })) others.add(project);
      } catch { others.add('unknown'); }
    }
    found.otherEngineProjects = [...others];
    for (const item of found.installations.filter(i => i.mode === 'docker')) item.engine = await engineInventory(effects, item, keep);
    try {
      const listed = await runContainer(effects, binding, ['buildx', 'du', '--verbose', '--filter', 'type=exec.cachemount']);
      found.buildCache = parseBuildCache(listed.stdout).filter(isOursCacheRecord).map(record => record.id);
    } catch { found.buildCache = null; }
  }
  return found;
}

/**
 * What of one installation still exists in its container engine, so the plan
 * lists only real items and a finished removal rescans as empty. A failed query
 * leaves that kind unknown (null), which is planned and checked again.
 */
async function engineInventory(effects, item, keep) {
  const inventory = {};
  const inspect = async args => { try { return json((await runContainer(effects, item, args)).stdout) ?? null; } catch { return null; } };
  const names = async args => { try { return (await runContainer(effects, item, args)).stdout.split(/\s+/).filter(Boolean); } catch { return null; } };
  for (const project of [item.project, ...(item.candidateProjects ?? [])]) {
    const label = `label=com.docker.compose.project=${project}`;
    // Labelled containers plus the installer's named helpers; ownership decided per container.
    const listed = await names(['ps', '-aq', '--no-trunc', '--filter', label]);
    const helpers = (await names(['ps', '-aq', '--no-trunc', '--filter', `name=${project}-`])) ?? [];
    let containers = null;
    const imageIds = new Set();
    if (listed !== null) {
      const ids = [...new Set([...listed, ...helpers])];
      const values = ids.length ? await inspect(['inspect', ...ids]) : [];
      if (values !== null) {
        containers = [];
        for (const value of values) {
          const name = String(value?.Name ?? '').replace(/^\//, '');
          if (ownedContainer(value, { root: item.root, project })) {
            containers.push(value.Id);
            const image = value.Config?.Labels?.['com.docker.compose.image'] ?? value.Image;
            if (/^sha256:[0-9a-f]{64}$/.test(image ?? '')) imageIds.add(image);
          } else if (value?.Config?.Labels?.['com.docker.compose.project'] === project) {
            keep('services', `Container ${name}`, 'it uses an Ours image but was not created by this installer, so it is left in place');
          }
        }
      }
    }
    // An image is proven by the ID this installer recorded for that name, or by
    // being the image an owned container was created from. Names are no proof.
    const images = {};
    let imagesKnown = true;
    for (const target of IMAGE_TARGETS) {
      const tag = `${project}:${target}`;
      let found;
      try { found = await runContainer(effects, item, ['image', 'inspect', tag], { allowCodes: [1] }); } catch { imagesKnown = false; continue; }
      if (found.code === 1) continue;
      const id = (json(found.stdout) ?? [])[0]?.Id;
      const recorded = item.ownedImages?.[tag] ?? item.images?.[tag];
      if (id && (recorded ? recorded === id : imageIds.has(id))) images[tag] = id;
      else keep('programs', `Container image ${tag}`, 'it has an Ours name but is not provably the image this installer built, so it is left in place');
    }
    inventory[project] = {
      containers,
      images: imagesKnown ? images : null,
      volumes: (await names(['volume', 'ls', '-q', '--filter', label]))?.length ?? null,
      networks: (await names(['network', 'ls', '-q', '--filter', label]))?.length ?? null,
    };
  }
  return inventory;
}

const verifyTarget = (effects, path, expected) => effects.stat(path)?.type === 'symlink' && effects.realpath(path) === expected;

async function executeStep(step, effects, context) {
  const { home } = effects;
  switch (step.type) {
    case 'command': {
      try { await effects.run(step.command[0], step.command.slice(1), { timeout: 120_000 }); }
      catch (error) { if (!step.tolerate) throw error; }
      return;
    }
    case 'legacy-service': {
      // Run the earlier tools' own stop commands, then verify: an error from a
      // command is only a failure when the service is in fact still there.
      const errors = [];
      // One short line per failed command; a missing program is said plainly.
      const attempt = async command => {
        try { await effects.run(command[0], command.slice(1), { timeout: 120_000 }); }
        catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          errors.push(/ENOENT/.test(text) || error?.code === 'ENOENT' ? `the ${command[0]} command is not installed` : `${command.slice(0, 2).join(' ')} failed: ${text.split('\n').find(line => line.trim()) ?? 'no reason given'}`.slice(0, 200));
        }
      };
      const unitHelp = path => `run: systemctl --user disable --now ${basename(path)}, then delete ${path}`;
      if (step.service.kind === 'daemon') {
        const { dir, port, unitPath, cliStartedIt } = step.service;
        if (unitPath && effects.stat(unitPath)) await attempt(['ours-daemon', 'uninstall-service', '--yes', '--state-dir', dir, '--config', join(dir, 'config.json')]);
        if (cliStartedIt) await attempt(['ours-daemon', 'stop', '--state-dir', dir, '--config', join(dir, 'config.json')]);
        let running = true;
        for (let i = 0; i < 10 && running; i++) {
          const probe = await effects.probe(port);
          running = Boolean(probe?.ok && resolve(probe.stateDir) === dir);
          if (running) await effects.sleep?.(1000);
        }
        const reason = () => errors.length ? ` (${[...new Set(errors)].join('; ')})` : '';
        if (running) throw new Error(`the earlier daemon for ${dir} is still running on port ${port}${reason()}; stop that process, then run the removal again`);
        if (unitPath && effects.stat(unitPath)) throw new Error(`its boot service ${unitPath} is still installed${reason()}; ${unitHelp(unitPath)}`);
        return;
      }
      if (effects.stat(step.service.unitPath)) await attempt(step.service.command);
      if (effects.stat(step.service.unitPath)) throw new Error(`its boot service ${step.service.unitPath} is still installed${errors.length ? ` (${[...new Set(errors)].join('; ')})` : ''}; ${unitHelp(step.service.unitPath)}`);
      return;
    }
    case 'fleet-down': {
      await effects.run(step.bin, ['down'], { env: { OURS_CONFIG: join(home, '.ours-client', 'profile.json') }, timeout: 180_000, allowCodes: [1] });
      return;
    }
    case 'user-unit': {
      await effects.run('systemctl', ['--user', 'disable', '--now', step.name], { allowCodes: [1, 5] });
      const reason = unsafeTreeReason(step.path, { home, stat: effects.stat, realpath: effects.realpath, uid: effects.uid, privateTree: false, file: true });
      if (reason) throw new Error(`${step.path} ${reason}`);
      effects.removeFile(step.path);
      if (step.dropIn && !unsafeTreeReason(step.dropIn, { home, stat: effects.stat, realpath: effects.realpath, uid: effects.uid, privateTree: false })) effects.removeDir(step.dropIn);
      context.reloadUnits = true;
      return;
    }
    case 'claude-settings': {
      const text = effects.readText(step.path);
      if (text === null) return;
      let updated = text;
      const edit = path => { updated = applyEdits(updated, modify(updated, path, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } })); };
      for (const path of step.entries) {
        const current = parseJsonc(updated, [], { allowTrailingComma: true });
        if (current?.[path[0]] && Object.hasOwn(current[path[0]], path[1])) edit(path);
      }
      // A section that held only the Ours entry is not left behind empty.
      for (const key of new Set(step.entries.map(path => path[0]))) {
        const value = parseJsonc(updated, [], { allowTrailingComma: true })?.[key];
        if (value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) edit([key]);
      }
      if (updated !== text) effects.writeText(step.path, updated);
      return;
    }
    case 'codex-config': {
      const text = effects.readText(step.path);
      if (text === null) return;
      const result = removeTomlTables(text, parts => isOursCodexTable(parts, CODEX_PLUGIN, CODEX_MARKETPLACE));
      if (result === null) throw new Error('the file changed and can no longer be read safely; it was not edited');
      if (result.removed.length) effects.writeText(step.path, result.text);
      return;
    }
    case 'tool-config': {
      const text = effects.readText(step.path);
      if (text === null) return;
      const value = JSON.parse(text);
      if (value?.version !== 1 || !value.instances || typeof value.instances !== 'object') throw new Error('it changed format since it was checked');
      const instances = Object.fromEntries(Object.entries(value.instances).filter(([id]) => !step.instances.includes(id)));
      if (Object.keys(instances).length === Object.keys(value.instances).length) return;
      effects.writeText(step.path, JSON.stringify({ ...value, instances }, null, 2) + '\n');
      return;
    }
    case 'managed-block': {
      const text = effects.readText(step.path);
      if (text === null) return;
      const stripped = stripManagedBlock(text, step.markers);
      if (stripped.action === 'absent') return;
      if (stripped.action !== 'strip') throw new Error(stripped.reason);
      effects.writeText(step.path, stripped.text);
      return;
    }
    case 'unlink': {
      const st = effects.stat(step.path);
      if (!st) return;
      if (step.expectTarget && !verifyTarget(effects, step.path, step.expectTarget)) throw new Error('the command changed since it was checked');
      if (step.expectLauncher) {
        const line = (effects.readText(step.path) ?? '').split('\n')[1] ?? '';
        if (!line.startsWith(MANAGED_CLI_MARKER) || json(line.slice(MANAGED_CLI_MARKER.length))?.targetRoot !== step.expectLauncher) throw new Error('the command changed since it was checked');
      }
      effects.removeFile(step.path);
      return;
    }
    case 'npm-uninstall': {
      if (step.expectTarget) {
        const path = join(context.npmRoot ?? '', step.name);
        if (effects.stat(path) && effects.realpath(path) !== step.expectTarget) throw new Error('the package changed since it was checked');
      }
      await effects.run('npm', ['uninstall', '--global', step.name], { timeout: 180_000 });
      return;
    }
    case 'server-services': {
      if (!step.installation.record) return; // Already removed earlier; containers are still cleaned by label below.
      await effects.serverStopForRemoval(step.installation.record);
      return;
    }
    case 'containers': {
      let ids = step.containerIds;
      if (!ids) {
        const label = `label=com.docker.compose.project=${step.project}`;
        const labelled = (await runContainer(effects, step.installation, ['ps', '-aq', '--no-trunc', '--filter', label])).stdout.split(/\s+/).filter(Boolean);
        const helpers = (await runContainer(effects, step.installation, ['ps', '-aq', '--no-trunc', '--filter', `name=${step.project}-`])).stdout.split(/\s+/).filter(Boolean);
        ids = [...new Set([...labelled, ...helpers])];
      }
      if (!ids.length) return;
      const present = (await runContainer(effects, step.installation, ['ps', '-aq', '--no-trunc'])).stdout.split(/\s+/).filter(Boolean);
      const live = ids.filter(id => present.includes(id));
      if (!live.length) return;
      const owned = [];
      for (const value of JSON.parse((await runContainer(effects, step.installation, ['inspect', ...live])).stdout)) {
        if (ownedContainer(value, { root: step.installation.root, project: step.project })) owned.push(value.Id);
        else if (step.containerIds) throw new Error('a container changed ownership while being removed');
      }
      if (!owned.length) return;
      await runContainer(effects, step.installation, ['stop', '--time', '30', ...owned], { allowCodes: [1] });
      await runContainer(effects, step.installation, ['rm', '--force', '--volumes=false', ...owned]);
      return;
    }
    case 'images': {
      const problems = [];
      // Only names whose image ID was proven during the check; unknown inventories
      // fall back to the IDs this installer recorded.
      const expected = step.tags ?? Object.fromEntries(IMAGE_TARGETS.map(target => `${step.project}:${target}`)
        .map(tag => [tag, step.installation.ownedImages?.[tag] ?? step.installation.images?.[tag]]).filter(([, id]) => id));
      for (const [tag, id] of Object.entries(expected)) {
        const found = await runContainer(effects, step.installation, ['image', 'inspect', tag], { allowCodes: [1] });
        if (found.code === 1) continue;
        const [image] = JSON.parse(found.stdout);
        if (image.Id !== id) { problems.push(`${tag} changed since it was checked and was left in place`); continue; }
        // Remove only this name. An image ID still named or used elsewhere stays.
        try { await runContainer(effects, step.installation, ['image', 'rm', tag]); }
        catch {
          let users = '';
          try { users = (await runContainer(effects, step.installation, ['ps', '-a', '--filter', `ancestor=${id}`, '--format', '{{.Names}}'])).stdout.split(/\s+/).filter(Boolean).join(', '); } catch { /* named generically below */ }
          problems.push(users ? `${tag} is still used by container ${users}, which Ours did not create; remove that container if you no longer need it` : `${tag} is still in use elsewhere`);
        }
      }
      if (problems.length) throw new Error(problems.join('; '));
      return;
    }
    case 'volumes':
    case 'networks': {
      const kind = step.type === 'volumes' ? 'volume' : 'network';
      const names = (await runContainer(effects, step.installation, [kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${step.project}`])).stdout.split(/\s+/).filter(Boolean);
      for (const name of names) {
        const [value] = JSON.parse((await runContainer(effects, step.installation, [kind, 'inspect', name])).stdout);
        if (value?.Labels?.['com.docker.compose.project'] !== step.project) throw new Error(`${name} changed ownership while being removed`);
        await runContainer(effects, step.installation, [kind, 'rm', name]);
      }
      return;
    }
    case 'build-cache': {
      if ((step.installation.containerEngine ?? 'docker') !== 'docker') throw new Error('Podman keeps no separate Ours build cache record to select; nothing was pruned');
      const listed = await runContainer(effects, step.installation, ['buildx', 'du', '--verbose', '--filter', 'type=exec.cachemount']);
      for (const record of parseBuildCache(listed.stdout).filter(isOursCacheRecord)) {
        await runContainer(effects, step.installation, ['buildx', 'prune', '--force', '--filter', `id=${record.id}`]);
      }
      return;
    }
    case 'tree':
    case 'file': {
      const reason = unsafeTreeReason(step.path, { home, stat: effects.stat, realpath: effects.realpath, uid: effects.uid, privateTree: step.privateTree !== false, file: step.type === 'file' });
      if (reason) throw new Error(`${step.path} ${reason}`);
      if (!effects.stat(step.path)) return;
      if (step.type === 'file') effects.removeFile(step.path); else effects.removeDir(step.path);
      return;
    }
    case 'retire': {
      // Verify the folder's own record, move it aside in one rename, then delete.
      if (!effects.stat(step.path)) return;
      const guard = { home, stat: effects.stat, realpath: effects.realpath, uid: effects.uid };
      const reason = unsafeTreeReason(step.path, guard);
      if (reason) throw new Error(`${step.path} ${reason}`);
      const record = json(effects.readText(join(step.path, step.recordFile)) ?? '');
      if (!record || record[step.recordField] !== step.expectInstance) throw new Error('it no longer holds the Ours record it had when checked, so it was left in place');
      if (effects.stat(step.tombstone)) {
        const leftover = unsafeTreeReason(step.tombstone, guard);
        if (leftover) throw new Error(`${step.tombstone} ${leftover}`);
        effects.removeDir(step.tombstone);
      }
      effects.renamePath(step.path, step.tombstone);
      effects.removeDir(step.tombstone);
      return;
    }
    case 'empty-dir': {
      if ((effects.list(step.path) ?? []).length) throw new Error('it still contains other files');
      if (effects.stat(step.path)) effects.removeEmptyDir(step.path);
      return;
    }
    default: throw new Error(`unknown step ${step.type}`);
  }
}

/** Run the plan in order; a step waits for the steps it depends on. */
export async function executeRemoval(plan, effects, { journal } = {}) {
  const results = new Map();
  const context = { npmRoot: null };
  try { context.npmRoot = (await effects.run('npm', ['root', '--global'])).stdout.trim(); } catch { /* checked per step */ }
  const ordered = [...plan.steps.filter(s => !s.last), ...plan.steps.filter(s => s.last)];
  let index = 0;
  for (const step of ordered) {
    index += 1;
    const blocked = (step.after ?? []).filter(id => results.has(id) && results.get(id).state === 'failed');
    effects.out(progress(index - 1, ordered.length, step.label, ''));
    if (blocked.length) {
      results.set(step.id, { state: 'failed', reason: 'skipped because an earlier step it depends on did not finish' });
      effects.out(warn(`Not removed yet: ${step.label} (it depends on a step that did not finish)`));
      continue;
    }
    if (step.last && [...results.values()].some(r => r.state === 'failed')) {
      results.set(step.id, { state: 'skipped', reason: 'kept so the removal can be retried' });
      effects.out(info(`${step.label}: kept so you can run the removal again`));
      continue;
    }
    try {
      await executeStep(step, effects, context);
      results.set(step.id, { state: 'done' });
      effects.out(ok(`Removed: ${step.label}`));
    } catch (error) {
      results.set(step.id, { state: 'failed', reason: error instanceof Error ? error.message : String(error) });
      effects.out(warn(`Could not remove: ${step.label} — ${error instanceof Error ? error.message : String(error)}`));
    }
    if (context.reloadUnits && !ordered.slice(index).some(s => s.type === 'user-unit')) {
      try { await effects.run('systemctl', ['--user', 'daemon-reload']); } catch { /* reported by verification */ }
      context.reloadUnits = false;
    }
  }
  return results;
}

/** The whole command. */
export async function runRemoval(argv, effects) {
  let options;
  try { options = parseRemoveArgs(argv, effects.home); }
  catch (error) { effects.out(warn(`ours-install remove: ${error.message}`)); return EXIT_REFUSED; }
  if (options.help) { effects.out(REMOVE_USAGE); return EXIT_OK; }
  const journalPath = join(effects.home, JOURNAL);
  let journal = null;
  const journalText = effects.readText(journalPath);
  if (journalText !== null) {
    try {
      const st = effects.stat(journalPath);
      if (st?.type !== 'file' || st.uid !== effects.uid || (st.mode & 0o077)) throw new Error('The unfinished removal record is not a private file you own; it was left untouched');
      journal = validateJournal(json(journalText), { home: effects.home });
    } catch (error) { effects.out(warn(error.message)); return EXIT_REFUSED; }
  }
  effects.out(heading('Remove Ours from this computer'));
  if (journal) effects.out(info('An earlier removal did not finish. Its list is used again, together with a fresh check of this computer.'));
  effects.out(info('Checking what Ours installed here…'));
  const found = await discoverFootprint(effects, { stateDirs: options.stateDirs, journal });
  const plan = planRemoval(found, { home: effects.home });
  // Only this command itself left: Ours is already removed; say so instead of asking.
  const onlyInstaller = plan.steps.every(step => step.id === 'installer' || step.id === 'npm-scope') && !journal;
  const residualsFound = plan.kept.filter(item => item.residual);
  if ((!plan.steps.length || onlyInstaller) && residualsFound.length) {
    effects.out(warn('Some Ours items are left and cannot be removed automatically:'));
    for (const item of residualsFound) effects.out(warn(`  - ${item.label} — ${item.reason}`));
    effects.out(info(journal ? `Fix the reason shown, then run ours-install remove again. The list of what is left is kept in ${journalPath}.` : 'Fix the reason shown, then run ours-install remove again.'));
    return EXIT_INCOMPLETE;
  }
  if (!plan.steps.length || onlyInstaller) {
    for (const line of describePlan({ steps: [], kept: plan.kept })) effects.out(info(line));
    effects.out(ok(journal ? 'Nothing from Ours is left to remove. The removal is complete.' : 'Nothing from Ours was found on this computer. Nothing was changed.'));
    if (onlyInstaller && plan.steps.some(step => step.id === 'installer')) effects.out(info('Only the ours-install command itself is installed. To remove it too, run: npm uninstall --global @ours.network/install'));
    if (journal && !options.dryRun) effects.removeFile(journalPath);
    return EXIT_OK;
  }
  effects.out(info('This will remove:'));
  for (const line of describePlan(plan)) effects.out(info(line));
  if (plan.steps.some(step => step.group === 'data')) effects.out(warn('This is permanent. Your Ours identities and their private keys, messages, rooms, agents and Ours settings will be deleted. They are not stored anywhere else and nobody can give them back. If you may need them, stop here and make a backup first: ours-install server backup server <label> --state-dir <folder>.'));
  effects.out(info('Your own Claude Code and Codex settings, skills and other plugins are kept. Docker, Node.js, npm, Claude Code and Codex themselves are not removed.'));
  if (options.dryRun) { effects.out(info('Preview only: nothing was removed.')); return EXIT_OK; }
  if (!effects.interactive || effects.env?.OURS_ASSUME_YES) {
    effects.out(warn('Removal needs a terminal so a person can confirm it. Nothing was removed. Run ours-install remove in a terminal.'));
    return EXIT_REFUSED;
  }
  const typed = await effects.askLine(`To permanently remove everything listed above, type: ${CONFIRMATION}\n`, '');
  if (String(typed ?? '').trim().toLowerCase() !== CONFIRMATION) {
    effects.out(info('Cancelled. Nothing was removed.'));
    return EXIT_CANCELLED;
  }
  // Retry record before the first change: only identities, never paths to delete.
  const record = {
    schema: 1, startedAt: journal?.startedAt ?? new Date(effects.now?.() ?? Date.now()).toISOString(),
    installations: found.installations.filter(item => item.project === projectForRoot(item.root)).map(({ record: _record, ownedImages: _owned, engine, images: retained, tombstone: _tombstone, ...item }) => {
      const images = { ...(retained ?? {}), ...Object.assign({}, ...Object.values(engine ?? {}).map(e => e.images ?? {})) };
      return { ...item, ...(Object.keys(images).length ? { images } : {}) };
    }),
    clientInstanceIds: found.client?.instanceId ? [found.client.instanceId] : [],
    generations: plan.steps.filter(s => s.id.startsWith('generation:')).map(s => s.id.slice('generation:'.length)),
    fleet: plan.steps.some(s => s.group === 'fleet'), legacy: plan.steps.some(s => s.group === 'legacy'), installer: plan.steps.some(s => s.id === 'installer'),
  };
  effects.writeJson(journalPath, JSON.stringify(record, null, 2) + '\n');
  let release = () => {};
  try { release = await effects.holdInstallationLocks(found.installations.map(i => i.root)); }
  catch (error) { effects.out(warn(`${error.message}. Nothing was removed.`)); return EXIT_REFUSED; }
  let results;
  try { results = await executeRemoval(plan, effects, { journal: record }); }
  finally { release(); }
  // Fresh check: only what is actually gone counts as removed.
  const after = planRemoval(await discoverFootprint(effects, { stateDirs: options.stateDirs, journal: record }), { home: effects.home });
  const remaining = after.steps.filter(step => !(step.id === 'installer' && results.get('installer')?.state === 'done'));
  const failures = [...results.entries()].filter(([, r]) => r.state === 'failed');
  const residuals = after.kept.filter(item => item.residual);
  effects.out(heading('Removal summary'));
  if (!remaining.length && !failures.length && !residuals.length) {
    effects.removeFile(journalPath);
    effects.out(ok('Ours has been removed from this computer.'));
    for (const item of after.kept) effects.out(info(`Kept: ${item.label} — ${item.reason}`));
    effects.out(info('Restart Claude Code and Codex so they stop offering the Ours tools in sessions that were already open.'));
    return EXIT_OK;
  }
  effects.out(warn('Some Ours items could not be removed yet:'));
  for (const step of remaining) effects.out(warn(`  - ${step.label}${results.get(step.id)?.reason ? ` — ${results.get(step.id).reason}` : ''}`));
  for (const [id, r] of failures) if (!remaining.some(step => step.id === id)) effects.out(warn(`  - ${plan.steps.find(s => s.id === id)?.label ?? id} — ${r.reason}`));
  for (const item of residuals) effects.out(warn(`  - ${item.label} — ${item.reason}`));
  effects.out(info(`Fix the reason shown, then run ours-install remove again; it continues from where it stopped. The list of what is left is kept in ${journalPath}.`));
  return EXIT_INCOMPLETE;
}
