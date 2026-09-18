/** Qualify cached images before reuse; repair only the known root-owned 0600 policy. */
import { lstatSync, readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync, openSync, closeSync, fstatSync, fchmodSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { atomicWriteConfig } from './config.mjs';

const policyPath = '/opt/ours/sources.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Docker runtime verification refused: ${message}`); };
const imageId = value => /^sha256:[0-9a-f]{64}$/.test(value ?? '');

export function refreshDockerPolicyCopy(record) {
  if (record.workDir !== join(record.root, 'runtime')) fail('Unsafe retained Dockerfile: runtime directory differs from installation record');
  for (const directory of [record.root, record.workDir]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || realpathSync(directory) !== directory) fail('Unsafe retained Dockerfile: installation directory is linked or not canonical');
    if (stat.uid !== process.getuid()) fail('Unsafe retained Dockerfile: installation directory belongs to another user');
    if (stat.mode & 0o7077) fail('Unsafe retained Dockerfile: installation directory must be owner-private (0700)');
  }
  const path = join(record.workDir, 'Dockerfile');
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { fail(`Unsafe retained Dockerfile: cannot open a regular unlinked file (${error.code})`); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail('Unsafe retained Dockerfile: expected a regular file');
    if (stat.nlink !== 1) fail('Unsafe retained Dockerfile: hard links are not supported');
    if (stat.uid !== process.getuid()) fail(`Unsafe retained Dockerfile: file owner ${stat.uid} differs from current user ${process.getuid()}`);
    if (stat.mode & 0o7000) fail('Unsafe retained Dockerfile: special permission bits are not supported');
    // Asset copies can retain 0664 under umask 002. Private canonical ancestors
    // exclude other users; normalize this owned inode without following links.
    fchmodSync(fd, 0o600);
    const text = readFileSync(fd, 'utf8');
    const current = lstatSync(path);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1) fail('Unsafe retained Dockerfile: file changed during normalization');
    const oldLine = /^COPY sources\.json \/opt\/ours\/sources\.json$/m;
    if (oldLine.test(text)) atomicWriteConfig(path, text.replace(oldLine, 'COPY --chmod=644 sources.json /opt/ours/sources.json'));
  } finally { closeSync(fd); }
}

const probeScript = `
const fs = require('node:fs'), crypto = require('node:crypto');
(async () => {
  const path = '${policyPath}', s = fs.lstatSync(path);
  if (!s.isFile() || s.nlink !== 1 || s.uid !== 0 || s.gid !== 0 || ![0o600, 0o644].includes(s.mode & 0o7777)) throw new Error('Unsupported policy ownership/type/mode');
  let bytes;
  try { bytes = fs.readFileSync(path); }
  catch (error) { if (process.getuid() !== 0 && error.code === 'EACCES') { process.exitCode = 74; return; } throw error; }
  const graph = await import('/opt/ours/maintenance/release-graph.mjs');
  graph.verifyRuntimeRelease('/opt/ours');
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const records = {};
  for (const name of ['package.json', 'package-lock.json', 'dependency-tree.json', 'build-context.json']) {
    const file = '/opt/ours/' + name, stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsupported build record');
    records[name] = hash(fs.readFileSync(file));
  }
  console.log(JSON.stringify({ uid: s.uid, gid: s.gid, regular: true, links: s.nlink, mode: s.mode & 0o7777, policyHash: hash(bytes), records }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;

export async function qualifyDockerRuntime(record, effects) {
  if (!/^ours-[a-z0-9-]+$/.test(record.project ?? '')) fail('unexpected installation project');
  const uid = record.uid ?? 1000, gid = record.gid ?? 1000;
  if (![uid, gid].every(n => Number.isInteger(n) && n > 0)) fail('non-root runtime UID/GID required');
  const tag = `${record.project}:runtime`;
  const inspect = async target => {
    const { stdout } = await effects.run('docker', ['image', 'inspect', target], { timeout: 60000 });
    const [value] = JSON.parse(stdout);
    if (!imageId(value?.Id) || !Array.isArray(value.RootFS?.Layers) || value.Config?.Labels?.['network.ours.build-context'] !== '1') fail('image lacks recognized build metadata');
    return value;
  };
  const probe = async (id, user) => {
    const name = `ours-runtime-probe-${randomUUID()}`;
    try {
      const result = await effects.run('docker', ['run', '--rm', '--name', name, '--read-only', '--network', 'none', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '256m', '--user', user, '--entrypoint', 'node', id, '-e', probeScript],
      { allowCodes: [1, 74], timeout: 60000 });
      return { code: result.code, report: result.code === 0 ? JSON.parse(result.stdout) : null };
    } catch (error) {
      // A killed Docker client can leave its own bounded probe container behind.
      try { await effects.run('docker', ['rm', '-f', name], { allowCodes: [1], timeout: 10000 }); } catch {}
      throw error;
    }
  };
  const policy = readFileSync(record.sourcesPath), expectedHash = digest(policy);
  const check = (report, mode) => {
    if (!report || report.mode !== mode || report.uid !== 0 || report.gid !== 0 || !report.regular || report.links !== 1 || report.policyHash !== expectedHash) fail('image policy differs from retained selection or expected permissions');
  };
  const original = await inspect(tag);
  const ordinary = await probe(original.Id, `${uid}:${gid}`);
  if (ordinary.code === 0) { check(ordinary.report, 0o644); return; }
  if (ordinary.code !== 74) fail('cached image is unusable; automatic repair only supports the known source-policy permission defect');
  const privileged = await probe(original.Id, '0:0');
  if (privileged.code !== 0) fail('original release graph could not be verified');
  check(privileged.report, 0o600);
  effects.out?.('Repairing cached Docker image permissions; keeping the selected packages and stored data.');
  const directory = mkdtempSync(join(record.root, '.image-permissions-'));
  const name = `ours-permission-repair-${randomUUID()}`, baseTag = `${name}:base`, candidateTag = `${name}:candidate`;
  try {
    // Unique local alias transports the immutable ID into BuildKit. The resulting
    // layer ancestry and complete execution config are checked before publication.
    await effects.run('docker', ['image', 'tag', original.Id, baseTag]);
    if ((await inspect(baseTag)).Id !== original.Id) fail('repair base image changed');
    writeFileSync(join(directory, 'sources.json'), policy, { mode: 0o600, flag: 'wx' });
    writeFileSync(join(directory, 'Dockerfile'), `FROM ${baseTag}\nCOPY --chmod=644 sources.json ${policyPath}\n`, { mode: 0o600, flag: 'wx' });
    await effects.run('docker', ['build', '--network=none', '--pull=false', '--tag', candidateTag, directory], { stream: true, timeout: 120000 });
    const candidate = await inspect(candidateTag);
    if (!isDeepStrictEqual(candidate.Config, original.Config) || !isDeepStrictEqual(candidate.RootFS.Layers.slice(0, original.RootFS.Layers.length), original.RootFS.Layers)
        || candidate.RootFS.Layers.length !== original.RootFS.Layers.length + 1) fail('repair changed image execution settings or ancestry');
    const verified = await probe(candidate.Id, `${uid}:${gid}`);
    if (verified.code !== 0) fail('repaired image did not pass runtime verification');
    check(verified.report, 0o644);
    if (!isDeepStrictEqual(verified.report.records, privileged.report.records)) fail('repair changed build provenance');
    if ((await inspect(tag)).Id !== original.Id) fail('selected image changed during repair; retry setup');
    await effects.run('docker', ['image', 'tag', candidate.Id, tag]);
    effects.out?.('Cached Docker image repaired and verified; continuing setup.');
  } finally {
    for (const temporary of [candidateTag, baseTag]) {
      try { await effects.run('docker', ['image', 'rm', temporary], { allowCodes: [1], timeout: 10000 }); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
