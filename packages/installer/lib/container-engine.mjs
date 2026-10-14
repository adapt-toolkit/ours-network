import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

export const engineName = record => record.containerEngine === undefined ? 'docker' : record.containerEngine;
const path = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !/[\x00-\x1f]/.test(value);
export function validateContainerEngine(record) {
  const engine = engineName(record);
  if (!['docker', 'podman'].includes(engine) || (record.mode !== 'docker' && (record.containerEngine !== undefined || record.containerBinding !== undefined))) throw new Error('Invalid container engine selection');
  const b = record.containerBinding;
  if (engine === 'docker') {
    if (b !== undefined) throw new Error('Unexpected Docker backend binding');
    return;
  }
  if (!b || b.version !== 1 || !Number.isInteger(b.uid) || b.uid <= 0 || !path(b.graphRoot) || !path(b.runRoot)
    || !/^[a-f0-9]{64}$/.test(b.namespaceDigest ?? '') || !path(b.socket) || !path(b.provider) || typeof b.driver !== 'string' || !/^[a-z0-9]+$/.test(b.driver)
    || Object.keys(b).some(k => !['version', 'uid', 'graphRoot', 'runRoot', 'socket', 'provider', 'driver', 'namespaceDigest'].includes(k))) throw new Error('Invalid rootless Podman backend binding');
}
function podmanEnvironment(record, env, uid) {
  validateContainerEngine(record);
  const b = record.containerBinding;
  if (uid !== b.uid) throw new Error('Podman installation belongs to another rootless owner');
  for (const key of ['CONTAINER_HOST', 'CONTAINER_CONNECTION', 'CONTAINERS_STORAGE_CONF', 'CONTAINERS_CONF', 'PODMAN_USERNS', 'STORAGE_DRIVER', 'STORAGE_OPTS']) {
    if (env[key]) throw new Error(`${key} conflicts with the retained local Podman backend`);
  }
  if ((env.OURS_PODMAN_SOCKET && env.OURS_PODMAN_SOCKET !== b.socket) || env.DOCKER_CONTEXT || (env.DOCKER_HOST && env.DOCKER_HOST !== `unix://${b.socket}`)
    || (env.PODMAN_COMPOSE_PROVIDER && env.PODMAN_COMPOSE_PROVIDER !== b.provider)) throw new Error('Environment conflicts with the retained Podman backend/provider');
  return { DOCKER_CONTEXT: undefined, DOCKER_HOST: `unix://${b.socket}`, PODMAN_COMPOSE_PROVIDER: b.provider, PODMAN_COMPOSE_WARNING_LOGS: 'false' };
}
/** The only container command boundary. Legacy records keep their Docker path. */
export async function runContainer(effects, record, args, options = {}) {
  if (engineName(record) === 'docker') return effects.run('docker', args, options);
  const env = { ...(effects.env ?? {}), ...(options.env ?? {}) };
  const selected = podmanEnvironment(record, env, process.getuid?.());
  const b = record.containerBinding;
  if (args[0] === 'build' && !args.some(arg => arg === '--format' || arg.startsWith('--format='))) args = ['build', '--format', 'docker', ...args.slice(1)];
  // Docker reports a missing object as 1; Podman inspect uses 125. Probe exact
  // existence separately so transport/permission failures are never absence.
  if (['image', 'volume'].includes(args[0]) && args[1] === 'inspect' && options.allowCodes?.includes(1)) {
    const found = await runContainer(effects, record, [args[0], 'exists', args.at(-1)], { ...options, allowCodes: [1] });
    if (found.code === 1) return { code: 1, stdout: '', ok: false };
  }
  // Native commands and the Compose provider must address the SAME local store.
  const prefix = args[0] === 'compose' ? ['--remote', '--url', `unix://${b.socket}`] : ['--remote=false', '--root', b.graphRoot, '--runroot', b.runRoot, '--storage-driver', b.driver];
  const result = await effects.run('podman', [...prefix, ...args],
    { ...options, env: { ...options.env, ...selected } });
  if (args[0] === 'image' && args[1] === 'inspect' && !args.includes('--format') && result.code === 0) {
    const images = JSON.parse(result.stdout);
    for (const value of images) if (/^[a-f0-9]{64}$/.test(value.Id)) value.Id = `sha256:${value.Id}`;
    return { ...result, stdout: JSON.stringify(images) };
  }
  return result;
}
export function namespaceDigest(info) {
  const maps = info.host?.idMappings;
  const normalized = ['uidmap', 'gidmap'].map(key => {
    const rows = maps?.[key];
    if (!Array.isArray(rows) || !rows.length) throw new Error('Podman user namespace mappings are unavailable');
    return rows.map(row => {
      const values = [row.container_id, row.host_id, row.size];
      if (values.some(value => !Number.isInteger(value) || value < 0) || row.size < 1) throw new Error('Invalid Podman namespace mapping');
      return values;
    }).sort((a, b) => a[0] - b[0]);
  });
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
export async function bindPodman(effects, record) {
  if (effects.platform.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Podman server installation requires a non-root Linux user');
  const env = effects.env ?? {};
  const provider = record.containerBinding?.provider ?? env.PODMAN_COMPOSE_PROVIDER;
  if (!path(provider)) throw new Error('Set PODMAN_COMPOSE_PROVIDER to an absolute standalone Docker Compose executable path');
  // Reject ambient redirection before even probing an unbound store.
  for (const key of ['CONTAINER_HOST', 'CONTAINER_CONNECTION', 'CONTAINERS_STORAGE_CONF', 'CONTAINERS_CONF', 'PODMAN_USERNS', 'STORAGE_DRIVER', 'STORAGE_OPTS', 'DOCKER_CONTEXT']) {
    if (env[key]) throw new Error(`${key} conflicts with local rootless Podman`);
  }
  const info = JSON.parse((await effects.run('podman', ['--remote=false', 'info', '--format', 'json'])).stdout);
  if (info.host?.security?.rootless !== true) throw new Error('Podman must report rootless=true');
  const socket = record.containerBinding?.socket ?? env.OURS_PODMAN_SOCKET ?? info.host.remoteSocket?.path;
  const observed = { version: 1, uid: process.getuid(), graphRoot: info.store?.graphRoot, runRoot: info.store?.runRoot, driver: info.store?.graphDriverName, socket, provider, namespaceDigest: namespaceDigest(info) };
  validateContainerEngine({ ...record, containerBinding: observed });
  if (record.containerBinding && Object.keys(observed).some(k => observed[k] !== record.containerBinding[k])) throw new Error('Podman backend differs from retained installation');
  podmanEnvironment({ ...record, containerBinding: observed }, env, process.getuid());
  const api = JSON.parse((await effects.run('podman', ['--remote', '--url', `unix://${socket}`, 'info', '--format', 'json'])).stdout);
  if (api.host?.security?.rootless !== true || api.store?.graphRoot !== observed.graphRoot || api.store?.runRoot !== observed.runRoot || api.store?.graphDriverName !== observed.driver || namespaceDigest(api) !== observed.namespaceDigest) throw new Error('Podman socket does not address the selected rootless storage; enable the user podman.socket');
  const version = (await effects.run(provider, ['version', '--short'])).stdout.trim();
  const match = /^v?(\d+)\.(\d+)\./.exec(version);
  if (!match || +match[1] < 2 || (+match[1] === 2 && +match[2] < 35)) throw new Error('Standalone Docker Compose 2.35+ is required');
  record.containerBinding = observed;
}

/** Resolve Compose rather than maintaining a second, drifting build definition. */
export function nativeBuildCommands(config, services, env = {}) {
  const commands = [], seen = new Set();
  for (const name of services) {
    const service = config.services?.[name], build = service?.build;
    if (!build || typeof build !== 'object' || !path(build.context) || !service.image) throw new Error(`Missing resolved build definition for ${name}`);
    const supported = ['context', 'dockerfile', 'target', 'args', 'secrets', 'cache_from', 'cache_to', 'platforms', 'labels', 'no_cache', 'pull'];
    if (Object.keys(build).some(k => !supported.includes(k))) throw new Error(`Unsupported Podman build option for ${name}`);
    const args = ['build', '--format', 'docker', '--layers', '--file', resolve(build.context, build.dockerfile ?? 'Dockerfile'), '--tag', service.image];
    if (build.target) args.push('--target', build.target);
    const platforms = build.platforms ?? (service.platform ? [service.platform] : []);
    if (platforms.length > 1) throw new Error('Multi-platform Podman builds are not supported');
    if (platforms.length) args.push('--platform', platforms[0]);
    for (const [key, value] of Object.entries(build.args ?? {})) {
      if (value === null) throw new Error(`Unresolved build argument: ${key}`);
      args.push('--build-arg', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(build.labels ?? {})) args.push('--label', `${key}=${value}`);
    for (const key of ['cache_from', 'cache_to']) for (const value of build[key] ?? []) args.push('--' + key.replace('_', '-'), value);
    if (build.no_cache) args.push('--no-cache');
    if (build.pull) args.push('--pull=always');
    for (const secret of build.secrets ?? []) {
      const source = typeof secret === 'string' ? secret : secret.source;
      const id = typeof secret === 'string' ? source : secret.target ?? source;
      const definition = config.secrets?.[source];
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid build secret ID');
      if (definition?.environment) {
        // Native local Podman supports type=env; values never enter argv/files.
        if (env[definition.environment]) args.push('--secret', `id=${id},type=env,env=${definition.environment}`);
      } else if (definition?.file && path(definition.file)) args.push('--secret', `id=${id},src=${definition.file}`);
      else throw new Error(`Unsupported build secret: ${source}`);
    }
    args.push(build.context);
    const key = JSON.stringify(args);
    if (!seen.has(key)) { seen.add(key); commands.push(args); }
  }
  return commands;
}
