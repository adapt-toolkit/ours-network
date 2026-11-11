#!/usr/bin/env node
// Release images: plan → stage → build (buildx bake) → qualify (anonymous) → tag.
// The plan is computed once per workflow run and passed between jobs unchanged.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validateRelease } from './release-manifest.mjs';
import { resolveSourcePolicy } from '../packages/installer/lib/plan.mjs';
import { stageDockerContext } from '../packages/installer/lib/docker-context.mjs';
import { IMAGE_REPOSITORIES, IMAGE_ROLES, IMAGE_TARGETS, IMAGE_PLATFORM, policyBytes, policyHash, validateImagesManifest, pullServerImages, verifyImagePair } from '../packages/installer/lib/image-acquisition.mjs';
import { qualifyDockerRuntime } from '../packages/installer/lib/docker-runtime-repair.mjs';

const ROOT = new URL('../', import.meta.url);
export const RELEASE_TAG = /^\d+\.\d+\.\d+(?:-nightly\.\d+)?-(?:server|daemon)$/;
export const SNAPSHOT_TAG = /^snapshot-stable-[0-9a-f]{12}-(?:server|daemon)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Tags per role: release builds use the installer version, unbumped main pushes a commit snapshot. */
export function imageTags({ channel, installerVersion, commit, kind }) {
  if (!['release', 'snapshot'].includes(kind) || (kind === 'snapshot' && channel !== 'stable')) throw new Error(`Unsupported image publication ${channel}/${kind}`);
  const tags = Object.fromEntries(IMAGE_ROLES.map(role => [role, kind === 'release' ? `${installerVersion}-${role}` : `snapshot-stable-${commit.slice(0, 12)}-${role}`]));
  for (const tag of Object.values(tags)) if (!(kind === 'release' ? RELEASE_TAG : SNAPSHOT_TAG).test(tag)) throw new Error(`Invalid image tag ${tag}`);
  return tags;
}

/** One plan per run: channel, version, commit, the exact role policies and their tags. */
export async function planImages({ root = ROOT, commit, kind }) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('A full release commit SHA is required');
  const pkg = JSON.parse(readFileSync(new URL('packages/installer/package.json', root)));
  const channel = pkg.version.includes('-nightly.') ? 'nightly' : 'stable';
  const release = validateRelease(JSON.parse(readFileSync(new URL(`releases/${channel}.json`, root))), pkg.version);
  // The packaged policy, exactly as scripts/prepare-installer.mjs writes it.
  const policy = { release, packages: Object.fromEntries(Object.entries(release.packages).map(([name, p]) => [name, { type: 'npm', version: p.version }])) };
  const policies = {};
  for (const role of IMAGE_ROLES) policies[role] = policyBytes(await resolveSourcePolicy(policy, role)).toString();
  return { schema: 1, channel, installerVersion: pkg.version, commit, kind, platform: IMAGE_PLATFORM, tags: imageTags({ channel, installerVersion: pkg.version, commit, kind }), policies };
}

export function readPlan(path) {
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  if (plan.schema !== 1 || plan.platform !== IMAGE_PLATFORM || !isDeepStrictEqual(Object.keys(plan.policies).sort(), [...IMAGE_ROLES].sort())) throw new Error('Invalid image plan');
  if (!isDeepStrictEqual(plan.tags, imageTags(plan))) throw new Error('Image plan tags differ from its identity');
  return plan;
}

const labels = (plan, role) => ({
  'org.opencontainers.image.source': 'https://github.com/adapt-toolkit/ours-network',
  'org.opencontainers.image.revision': plan.commit,
  'org.opencontainers.image.version': plan.installerVersion,
  'network.ours.installer-version': plan.installerVersion,
  'network.ours.channel': plan.channel,
  'network.ours.role': role,
  'network.ours.policy-sha256': policyHash(Buffer.from(plan.policies[role])),
});

/** Stage each role's context with the host's own helper and describe one bake build. */
export function stageImages(plan, out, { push }) {
  mkdirSync(out, { recursive: true });
  const targets = {};
  for (const role of IMAGE_ROLES) {
    const context = join(out, role);
    stageDockerContext(context, Buffer.from(plan.policies[role]));
    for (const target of IMAGE_TARGETS) {
      targets[`${target}-${role}`] = {
        // Relative to the bake file: run bake from that directory (buildx filesystem entitlements).
        context: role, dockerfile: 'Dockerfile', target, platforms: [IMAGE_PLATFORM], labels: labels(plan, role),
        // Pushed untagged; immutable tags are written only after anonymous qualification.
        ...(push ? { attest: ['type=provenance,mode=max', 'type=sbom'], output: [`type=image,name=${IMAGE_REPOSITORIES[target]},push-by-digest=true,name-canonical=true,push=true`] }
          : { tags: [`ours-ci-${role}:${target}`], output: ['type=docker'] }),
      };
    }
  }
  // Both targets of a role share one bake graph, so their build stage is solved once.
  writeFileSync(join(out, 'docker-bake.json'), JSON.stringify({ group: { default: { targets: Object.keys(targets) } }, target: targets }, null, 2) + '\n');
  return join(out, 'docker-bake.json');
}

const sh = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20, ...options });
const engine = env => ({ out: line => console.error(line), env, run: async (command, args, options = {}) => {
  try { return { code: 0, ok: true, stdout: sh(command, args, { env: { ...process.env, ...env, ...(options.env ?? {}) }, timeout: options.timeout }) }; }
  catch (error) { if (options.allowCodes?.includes(error.status)) return { code: error.status, ok: false, stdout: error.stdout ?? '' }; throw error; }
} });

/** Index → linux/amd64 manifest → config, read from the registry without credentials. */
export function resolveDigests(repository, index, inspectRaw) {
  const top = JSON.parse(inspectRaw(`${repository}@${index}`));
  const manifests = (top.manifests ?? []).filter(m => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64' && !m.platform?.variant);
  if (manifests.length !== 1 || !DIGEST.test(manifests[0].digest)) throw new Error(`${repository}@${index} is not a single linux/amd64 image index`);
  const manifest = manifests[0].digest, config = JSON.parse(inspectRaw(`${repository}@${manifest}`)).config?.digest;
  if (!DIGEST.test(config ?? '')) throw new Error(`${repository}@${manifest} has no config digest`);
  return { repository, index, manifest, config };
}

/** Build the packaged descriptor from pushed index digests ({ role: { target: index } }). */
export function imagesManifest(plan, indexes, inspectRaw) {
  const variants = Object.fromEntries(IMAGE_ROLES.map(role => [role, {
    policySha256: policyHash(Buffer.from(plan.policies[role])),
    ...Object.fromEntries(IMAGE_TARGETS.map(target => [target, resolveDigests(IMAGE_REPOSITORIES[target], indexes[role][target], inspectRaw)])),
  }]));
  return validateImagesManifest({ schema: 1, channel: plan.channel, installerVersion: plan.installerVersion, commit: plan.commit, platform: plan.platform, variants }, plan);
}

/** Pushed index digests from `buildx bake --metadata-file`. */
export function bakeIndexes(metadata) {
  return Object.fromEntries(IMAGE_ROLES.map(role => [role, Object.fromEntries(IMAGE_TARGETS.map(target => {
    const digest = metadata[`${target}-${role}`]?.['containerimage.digest'];
    if (!DIGEST.test(digest ?? '')) throw new Error(`Build metadata lacks the ${target}-${role} digest`);
    return [target, digest];
  }))]));
}

/**
 * Existing immutable tags: none → build; all four → reuse (a retried run); some → refuse,
 * because a mixed pair can never be published.
 */
export function existingTags(plan, lookup) {
  const found = {};
  for (const role of IMAGE_ROLES) for (const target of IMAGE_TARGETS) {
    const digest = lookup(`${IMAGE_REPOSITORIES[target]}:${plan.tags[role]}`);
    if (digest) (found[role] ??= {})[target] = digest;
  }
  const count = Object.values(found).reduce((n, role) => n + Object.keys(role).length, 0);
  if (count === 0) return null;
  if (count !== IMAGE_ROLES.length * IMAGE_TARGETS.length) throw new Error('Some immutable image tags of this release already exist and others do not; publish a new version');
  return found;
}

/** Anonymous pull, digest/label/pair checks and the host's own runtime qualification. */
export async function qualifyImages(manifest, plan, { work = mkdtempSync(join(tmpdir(), 'ours-qualify-')) } = {}) {
  const config = join(work, 'docker-config');
  mkdirSync(config, { mode: 0o700 });
  const effects = engine({ DOCKER_CONFIG: config });
  for (const role of IMAGE_ROLES) {
    const root = join(work, role); mkdirSync(root, { mode: 0o700 });
    const sourcesPath = join(root, 'sources.json');
    writeFileSync(sourcesPath, plan.policies[role], { mode: 0o600 });
    const record = { mode: 'docker', containerEngine: 'docker', project: `ours-qualify-${role}`, root, sourcesPath, uid: 1000, gid: 1000 };
    const entry = { role, channel: manifest.channel, installerVersion: manifest.installerVersion, commit: manifest.commit, platform: manifest.platform, ...manifest.variants[role] };
    delete entry.policySha256;
    await pullServerImages(effects, record, entry);
    await qualifyDockerRuntime(record, effects);
  }
}

async function main([command, ...argv]) {
  const option = name => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
  // Registry reads never use stored credentials: what is checked is what anyone can pull.
  const anonymous = args => sh('docker', args, { env: { ...process.env, DOCKER_CONFIG: mkdtempSync(join(tmpdir(), 'ours-anon-')) } });
  const inspectRaw = ref => anonymous(['buildx', 'imagetools', 'inspect', '--raw', ref]);
  if (command === 'plan') {
    const plan = await planImages({ commit: option('commit'), kind: option('kind') });
    writeFileSync(option('out'), JSON.stringify(plan, null, 2) + '\n');
    console.error(`Planned ${plan.kind} images ${Object.values(plan.tags).join(', ')} for ${plan.channel} ${plan.installerVersion} at ${plan.commit}`);
  } else if (command === 'stage') {
    console.log(stageImages(readPlan(option('plan')), resolve(option('out')), { push: argv.includes('--push') }));
  } else if (command === 'existing') {
    // Writes reused index digests when a retried run finds its complete published pair.
    const plan = readPlan(option('plan'));
    const lookup = ref => { try { return JSON.parse(anonymous(['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest}}'])).digest ?? null; } catch { return null; } };
    const found = existingTags(plan, lookup);
    if (found) writeFileSync(option('out'), JSON.stringify(found, null, 2) + '\n');
    console.log(found ? 'reuse' : 'build');
  } else if (command === 'describe') {
    const plan = readPlan(option('plan'));
    const indexes = option('reuse') && existsSync(option('reuse')) ? JSON.parse(readFileSync(option('reuse'), 'utf8')) : bakeIndexes(JSON.parse(readFileSync(option('metadata'), 'utf8')));
    writeFileSync(option('out'), JSON.stringify(imagesManifest(plan, indexes, inspectRaw), null, 2) + '\n');
  } else if (command === 'qualify') {
    await qualifyImages(validateImagesManifest(JSON.parse(readFileSync(option('images'), 'utf8')), readPlan(option('plan'))), readPlan(option('plan')));
    console.error('Published images qualified anonymously');
  } else if (command === 'qualify-local') {
    // Pull requests: images built and loaded locally as ours-ci-<role>:<target>; nothing is pushed.
    const plan = readPlan(option('plan'));
    for (const role of IMAGE_ROLES) {
      const work = mkdtempSync(join(tmpdir(), 'ours-qualify-')), sourcesPath = join(work, 'sources.json');
      writeFileSync(sourcesPath, plan.policies[role], { mode: 0o600 });
      const effects = engine({}), record = { mode: 'docker', containerEngine: 'docker', project: `ours-ci-${role}`, root: work, sourcesPath, uid: 1000, gid: 1000 };
      await qualifyDockerRuntime(record, effects);
      await verifyImagePair(effects, record, IMAGE_TARGETS.map(target => `ours-ci-${role}:${target}`));
      rmSync(work, { recursive: true, force: true });
    }
    console.error('Locally built images qualified');
  } else if (command === 'tag') {
    const plan = readPlan(option('plan')), manifest = validateImagesManifest(JSON.parse(readFileSync(option('images'), 'utf8')), plan);
    for (const role of IMAGE_ROLES) for (const target of IMAGE_TARGETS) {
      const { repository, index } = manifest.variants[role][target], tag = `${repository}:${plan.tags[role]}`;
      let current = null;
      try { current = JSON.parse(sh('docker', ['buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}'])).digest; } catch {}
      if (current === index) continue;
      if (current) throw new Error(`Refusing to move immutable tag ${tag}`);
      sh('docker', ['buildx', 'imagetools', 'create', '--tag', tag, `${repository}@${index}`], { stdio: ['ignore', 'inherit', 'inherit'] });
    }
  } else if (command === 'verify-pack') {
    const archive = option('archive'), plan = readPlan(option('plan'));
    const packed = JSON.parse(sh('tar', ['-xOf', archive, 'package/assets/images.json']));
    if (!isDeepStrictEqual(packed, JSON.parse(readFileSync(option('images'), 'utf8')))) throw new Error('Packed images.json differs from the qualified descriptor');
    validateImagesManifest(packed, JSON.parse(sh('tar', ['-xOf', archive, 'package/assets/release.json'])));
    if (packed.commit !== plan.commit) throw new Error('Packed images.json belongs to another commit');
    // The installer recognizes a published package by the absence of test/ (lib/image-acquisition.mjs).
    if (sh('tar', ['-tf', archive]).split('\n').some(entry => entry.startsWith('package/test/'))) throw new Error('A published installer must not ship test/');
    console.error(`Verified ${archive} carries the qualified image descriptor`);
  } else throw new Error('Usage: release-images.mjs plan|stage|existing|describe|qualify|qualify-local|tag|verify-pack …');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
