/** Published server images: descriptor validation, generation selection and digest-bound pulls. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { atomicWriteConfig } from './config.mjs';
import { runContainer } from './container-engine.mjs';

export const IMAGE_REPOSITORIES = Object.freeze({ runtime: 'docker.io/adaptframework/ours-runtime', maintenance: 'docker.io/adaptframework/ours-maintenance' });
export const IMAGE_TARGETS = Object.freeze(Object.keys(IMAGE_REPOSITORIES));
export const IMAGE_ROLES = Object.freeze(['server', 'daemon']);
export const IMAGE_PLATFORM = 'linux/amd64';
/** Generated at release packing; development checkouts have none and build locally. */
export const PACKAGED_IMAGES = fileURLToPath(new URL('../assets/images.json', import.meta.url));
export const IMAGES_FILE = 'images.json';
const DIGEST = /^sha256:[0-9a-f]{64}$/, HASH = /^[0-9a-f]{64}$/;

export const policyHash = bytes => createHash('sha256').update(bytes).digest('hex');
/** The exact bytes the installer retains as sources.json for a resolved selection. */
export const policyBytes = policy => Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);

const object = value => value && typeof value === 'object' && !Array.isArray(value);
function exactKeys(value, keys, what) {
  if (!object(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(`Invalid image descriptor: ${what}`);
}
function validateTarget(target, value) {
  exactKeys(value, ['repository', 'index', 'manifest', 'config'], target);
  if (value.repository !== IMAGE_REPOSITORIES[target] || ![value.index, value.manifest, value.config].every(digest => DIGEST.test(digest))) {
    throw new Error(`Invalid image descriptor: ${target}`);
  }
}
function validateBinding(value, what) {
  if (!['stable', 'nightly'].includes(value.channel) || typeof value.installerVersion !== 'string' || !value.installerVersion
    || !/^[0-9a-f]{40}$/.test(value.commit) || value.platform !== IMAGE_PLATFORM) throw new Error(`Invalid image descriptor: ${what}`);
}

/** The packaged descriptor: both roles, fixed repositories, bound to the packaged release. */
export function validateImagesManifest(value, release) {
  exactKeys(value, ['schema', 'channel', 'installerVersion', 'commit', 'platform', 'variants'], 'manifest');
  if (value.schema !== 1) throw new Error('Invalid image descriptor: manifest');
  validateBinding(value, 'manifest');
  if (release && (value.channel !== release.channel || value.installerVersion !== release.installerVersion)) {
    throw new Error('Image descriptor does not belong to the packaged release');
  }
  exactKeys(value.variants, IMAGE_ROLES, 'variants');
  for (const role of IMAGE_ROLES) {
    const variant = value.variants[role];
    exactKeys(variant, ['policySha256', ...IMAGE_TARGETS], role);
    if (!HASH.test(variant.policySha256)) throw new Error(`Invalid image descriptor: ${role}`);
    for (const target of IMAGE_TARGETS) validateTarget(target, variant[target]);
  }
  return value;
}

export function readPackagedImages(release, path = PACKAGED_IMAGES) {
  if (!existsSync(path)) return null;
  return validateImagesManifest(JSON.parse(readFileSync(path, 'utf8')), release);
}

/** One retained generation: what a role's selection was installed from. */
export function generationEntry(manifest, role) {
  const { channel, installerVersion, commit, platform } = manifest;
  return { role, channel, installerVersion, commit, platform, ...Object.fromEntries(IMAGE_TARGETS.map(target => [target, manifest.variants[role][target]])) };
}
function validateEntry(entry) {
  exactKeys(entry, ['role', 'channel', 'installerVersion', 'commit', 'platform', ...IMAGE_TARGETS], 'generation');
  if (!IMAGE_ROLES.includes(entry.role)) throw new Error('Invalid image descriptor: generation');
  validateBinding(entry, 'generation');
  for (const target of IMAGE_TARGETS) validateTarget(target, entry[target]);
}

/** An update candidate is staged in <root>/.build-*; its generations belong to the installation. */
export const imagesRoot = root => basename(root).startsWith('.build-') ? dirname(root) : root;

export function readGenerations(root) {
  const path = join(imagesRoot(root), IMAGES_FILE);
  if (!existsSync(path)) return {};
  const store = JSON.parse(readFileSync(path, 'utf8'));
  exactKeys(store, ['schema', 'generations'], 'retained generations');
  if (store.schema !== 1 || !object(store.generations)) throw new Error('Invalid image descriptor: retained generations');
  for (const [hash, entry] of Object.entries(store.generations)) {
    if (!HASH.test(hash)) throw new Error('Invalid image descriptor: retained generations');
    validateEntry(entry);
  }
  return store.generations;
}
function writeGenerations(root, generations) {
  atomicWriteConfig(join(imagesRoot(root), IMAGES_FILE), JSON.stringify({ schema: 1, generations }, null, 2) + '\n');
}
/** Added before its sources.json is retained, so every retained selection keeps its generation. */
export function rememberGeneration(root, hash, entry) {
  validateEntry(entry);
  const generations = readGenerations(root);
  if (generations[hash] && !isDeepStrictEqual(generations[hash], entry)) throw new Error('A different image generation is already retained for this selection');
  if (!generations[hash]) writeGenerations(root, { ...generations, [hash]: entry });
}
/** After sources.json is replaced: keep the active and previous selections only. */
export function pruneGenerations(root, keep) {
  const generations = readGenerations(root);
  const kept = Object.fromEntries(Object.entries(generations).filter(([hash]) => keep.includes(hash)));
  if (Object.keys(kept).length !== Object.keys(generations).length) writeGenerations(root, kept);
}

/**
 * Decide where a selection's images come from, keyed only by the retained policy hash:
 * its own retained generation, else the packaged release, else an explicit local build.
 * A released selection whose published descriptor is missing or mismatched is an error.
 */
export function selectServerImages({ root, sourcesPath, role, packaged, releasedHash, buildLocally = false }) {
  if (!IMAGE_ROLES.includes(role)) throw new Error(`Unsupported image role: ${role}`);
  if (buildLocally) return { kind: 'build', reason: 'local build requested with OURS_BUILD_LOCALLY=1' };
  const hash = policyHash(readFileSync(sourcesPath));
  const retained = readGenerations(root)[hash];
  if (retained) {
    if (retained.role !== role) throw new Error('Retained image generation belongs to a different installation role');
    return { kind: 'pull', hash, entry: retained };
  }
  if (packaged?.variants[role].policySha256 === hash) return { kind: 'pull', hash, entry: generationEntry(packaged, role), remember: true };
  if (packaged && releasedHash === hash) throw new Error('The published image descriptor does not match this release selection; reinstall the installer package');
  return { kind: 'build', reason: packaged ? 'the selected packages differ from this installer release (custom sources or an earlier installation)' : 'this installer has no published images (development checkout)' };
}

const pairScript = `
const fs = require('node:fs'), crypto = require('node:crypto');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const records = Object.fromEntries(['package.json', 'package-lock.json', 'dependency-tree.json', 'build-context.json', 'sources.json'].map(name => [name, hash('/opt/ours/' + name)]));
const vendor = '/opt/ours/docker/vendor';
for (const name of fs.readdirSync(vendor).sort()) records['vendor/' + name] = hash(vendor + '/' + name);
console.log(JSON.stringify(records));
`;
/** Runtime and maintenance must carry one npm tree, one policy and one vendor set. */
export async function verifyImagePair(effects, record, refs) {
  const reports = [];
  for (const ref of refs) {
    const result = await runContainer(effects, record, ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--user', `${record.uid ?? 1000}:${record.gid ?? 1000}`, '--entrypoint', 'node', ref, '-e', pairScript], { timeout: 60000 });
    reports.push(JSON.parse(result.stdout));
  }
  if (!isDeepStrictEqual(reports[0], reports[1])) throw new Error('Published runtime and maintenance images do not share one build');
}

/** Pull each image by its published index digest and name it for this installation project. */
export async function pullServerImages(effects, record, entry, { project = record.project } = {}) {
  for (const target of IMAGE_TARGETS) {
    const published = entry[target], ref = `${published.repository}@${published.index}`;
    effects.out?.(`Downloading the published ${target} image (${published.repository.replace(/^docker\.io\//, '')})…`);
    try { await runContainer(effects, record, ['pull', '--platform', entry.platform, ref], { stream: true, timeout: 1800000 }); }
    catch (error) {
      throw new Error(`Could not download the published ${target} image ${ref}. Check the network connection; if Docker Hub's anonymous pull limit was reached, run "docker login" and retry. To build from source instead, rerun with OURS_BUILD_LOCALLY=1.`, { cause: error });
    }
    const [value] = JSON.parse((await runContainer(effects, record, ['image', 'inspect', ref])).stdout);
    // Engines name a pulled image by its config, platform manifest or index digest.
    const repository = published.repository.replace(/^docker\.io\//, '');
    if (![published.config, published.manifest, published.index].includes(value?.Id)
      || !(value.RepoDigests ?? []).some(digest => digest.replace(/^docker\.io\//, '') === `${repository}@${published.index}`)
      || value.Config?.Labels?.['network.ours.build-context'] !== '1') throw new Error(`The downloaded ${target} image does not match its published digest`);
    await runContainer(effects, record, ['tag', ref, `${project}:${target}`]);
  }
  await verifyImagePair(effects, record, IMAGE_TARGETS.map(target => `${project}:${target}`));
}
